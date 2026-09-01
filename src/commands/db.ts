/**
 * `absolutejs db` — the migration gates a zero-downtime deploy needs.
 *
 * Four verbs, in the order a pipeline runs them:
 *
 *   check-drift      offline. Do the committed migrations cover the schema?
 *   verify-contract  offline. Is anything destructive in the wrong phase?
 *   verify-schema    live.    Does the database have what the new binary selects?
 *   contract-migrate live.    Apply the destructive half, after the old slot drains.
 *
 * Every project that deploys Drizzle migrations without downtime ends up
 * writing these four, and getting any of them subtly wrong is invisible until
 * a deploy fails — a drift check that passes because it silently skipped the
 * file, a contract runner that reports success because its statement splitter
 * ate the migration behind an opening comment.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { SQL } from "bun";
import {
  contractMigrationFiles,
  contractMigrationLayoutErrors,
  statementsIn,
} from "../utils/migrationPhases";
import {
  writeErr,
  writeJson,
  writeOut,
  type OutputMode,
} from "../utils/output";

export type DbArgs = {
  flags: Record<string, string | boolean>;
  positional: string[];
  verb: string;
};

const GUARD_NAME = "absolutejs_schema_guard";
const DEFAULT_DIR = "drizzle";
const DEFAULT_LEDGER = "deployment_contract_migration";
const DEFAULT_LOCK = "absolutejs:contract-migrations";
const OK = 0;
const FAILED = 1;
const USAGE = 2;

const stringFlag = (
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined => {
  const value = flags[name];
  if (typeof value === "boolean") throw new Error(`--${name} requires a value`);

  return value;
};

const migrationDir = (flags: Record<string, string | boolean>) =>
  resolve(stringFlag(flags, "dir") ?? DEFAULT_DIR);

const databaseUrl = (flags: Record<string, string | boolean>): string => {
  const url = stringFlag(flags, "url") ?? process.env.DATABASE_URL;
  if (url === undefined || url === "")
    throw new Error("DATABASE_URL is required (or pass --url)");

  return url;
};

/**
 * Does the committed journal cover the current schema?
 *
 * A schema file is not the whole schema surface — constants it imports are
 * schema too, so editing one without regenerating produces drift that
 * typecheck, lint and tests all miss and that surfaces as a failed deploy.
 *
 * The check runs the generator under a marker name and looks for what it
 * wrote. Nothing contacts a database; a placeholder URL only exists to satisfy
 * config files that require one. A real migration that is pending but
 * uncommitted does not false-positive: the generator finds no further changes
 * on top of it.
 */
const checkDrift = (
  flags: Record<string, string | boolean>,
  mode: OutputMode,
): number => {
  const dir = migrationDir(flags);
  const config = stringFlag(flags, "config");
  const configArgs = config === undefined ? [] : ["--config", config];
  const env = {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgres://drift-check:placeholder@localhost:5432/drift_check",
  };
  const run = (args: string[]) =>
    spawnSync("bunx", ["drizzle-kit", ...args, ...configArgs], {
      encoding: "utf8",
      env,
    });

  const guardDirs = () =>
    existsSync(dir)
      ? readdirSync(dir).filter((entry) => entry.endsWith(`_${GUARD_NAME}`))
      : [];
  const removeGuards = () => {
    for (const guard of guardDirs())
      rmSync(join(dir, guard), { force: true, recursive: true });
  };

  // A stale guard directory from an aborted run would false-positive.
  removeGuards();

  const checked = run(["check"]);
  if (checked.status !== 0) {
    writeErr(checked.stdout);
    writeErr(checked.stderr);
    writeErr(
      "drizzle-kit check failed — the migration journal is inconsistent",
    );

    return FAILED;
  }

  const generated = run(["generate", "--name", GUARD_NAME]);
  if (generated.status !== 0) {
    writeErr(generated.stdout);
    writeErr(generated.stderr);
    writeErr("drizzle-kit generate failed");

    return FAILED;
  }

  const guards = guardDirs();
  if (guards.length === 0) {
    if (mode === "json") writeJson({ drift: false });
    else writeOut("no schema drift — migrations cover the schema");

    return OK;
  }

  const wanted = guards.flatMap((guard) => {
    const sqlPath = join(dir, guard, "migration.sql");

    return existsSync(sqlPath)
      ? [{ dir: guard, sql: readFileSync(sqlPath, "utf8") }]
      : [];
  });
  removeGuards();

  if (mode === "json") writeJson({ drift: true, wanted });
  else {
    writeErr(
      "schema drift: the schema has changes with no committed migration. The generator wanted to write:",
    );
    for (const entry of wanted)
      writeErr(`\n--- ${entry.dir}/migration.sql ---\n${entry.sql}`);
    writeErr("\nRun `drizzle-kit generate --name <change>` and commit it.");
  }

  return FAILED;
};

/** Offline gate: nothing destructive in `migration.sql`, no empty
 *  `contract.sql`. Runs before anything ships, so an unsafe layout fails the
 *  build rather than the old slot. */
const verifyContract = async (
  flags: Record<string, string | boolean>,
  mode: OutputMode,
): Promise<number> => {
  const dir = migrationDir(flags);
  const since = stringFlag(flags, "since");
  const errors = await contractMigrationLayoutErrors(dir, { since });
  if (errors.length === 0) {
    if (mode === "json") writeJson({ ok: true });
    else writeOut("migration phase layout verified");

    return OK;
  }
  if (mode === "json") writeJson({ errors, ok: false });
  else {
    writeErr("unsafe migration phase layout:");
    for (const error of errors) writeErr(`  - ${error}`);
  }

  return FAILED;
};

/**
 * Apply the post-drain half.
 *
 * Each file rides one transaction with an advisory lock and its ledger row, so
 * two deploys racing cannot both apply it and a crash cannot leave it
 * applied-but-unrecorded.
 */
const contractMigrate = async (
  flags: Record<string, string | boolean>,
  mode: OutputMode,
): Promise<number> => {
  const dir = migrationDir(flags);
  const since = stringFlag(flags, "since");
  const ledger = stringFlag(flags, "ledger") ?? DEFAULT_LEDGER;
  const lock = stringFlag(flags, "lock") ?? DEFAULT_LOCK;

  // Layout is re-checked here as well as in CI: this verb is the one that
  // actually runs the statements, and it must not be the place a bad split
  // first takes effect.
  const errors = await contractMigrationLayoutErrors(dir, { since });
  if (errors.length > 0) {
    writeErr(`unsafe migration phase layout:\n${errors.join("\n")}`);

    return FAILED;
  }

  const migrations = await contractMigrationFiles(dir, { since });
  const sql = new SQL(databaseUrl(flags));
  const applied: string[] = [];
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${ledger}" (
        "id" text PRIMARY KEY NOT NULL,
        "applied_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    const done = new Set(
      (
        (await sql.unsafe(`SELECT id FROM "${ledger}"`)) as { id: string }[]
      ).map((row) => row.id),
    );

    for (const migration of migrations) {
      if (done.has(migration.id)) continue;
      const statements = statementsIn(migration.sql);
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${lock}))`;
        for (const statement of statements) await tx.unsafe(statement);
        await tx.unsafe(`INSERT INTO "${ledger}" (id) VALUES ($1)`, [
          migration.id,
        ]);
      });
      applied.push(migration.id);
      if (mode === "human") writeOut(`applied ${migration.id}`);
    }
  } finally {
    await sql.close();
  }

  if (mode === "json")
    writeJson({ applied, skipped: migrations.length - applied.length });
  else
    writeOut(
      `post-drain contract current (${applied.length} applied, ${migrations.length - applied.length} skipped)`,
    );

  return OK;
};

type LiveColumns = Map<string, Map<string, boolean>>;

const liveColumns = async (sql: SQL): Promise<LiveColumns> => {
  const rows = (await sql`
    SELECT table_name, column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `) as { column_name: string; is_nullable: string; table_name: string }[];

  const live: LiveColumns = new Map();
  for (const row of rows) {
    const columns = live.get(row.table_name) ?? new Map<string, boolean>();
    columns.set(row.column_name, row.is_nullable === "NO");
    live.set(row.table_name, columns);
  }

  return live;
};

/**
 * Does the live database have everything the code about to be activated will
 * select?
 *
 * Deliberately one-directional. Missing tables, missing columns, and columns
 * the code treats as NOT NULL that the database allows to be null are all
 * failures, because the new binary would break on them. Objects the database
 * has and the code does not are NOT failures: during expand/contract that is
 * exactly the expected state between the migrate step and the post-drain step.
 * Drift in that direction is `check-drift`'s job, offline.
 */
const verifySchema = async (
  flags: Record<string, string | boolean>,
  mode: OutputMode,
): Promise<number> => {
  const modulePath = stringFlag(flags, "schema");
  if (modulePath === undefined)
    throw new Error(
      "--schema <path> is required: the module exporting your Drizzle tables",
    );
  const exportName = stringFlag(flags, "export") ?? "schema";
  const [{ getTableConfig }, loaded] = await Promise.all([
    import("drizzle-orm/pg-core"),
    import(resolve(modulePath)) as Promise<Record<string, unknown>>,
  ]);
  const tablesExport = loaded[exportName];
  // Either a `schema` object of tables, or the module's own table exports.
  const tables = Object.values(
    (typeof tablesExport === "object" && tablesExport !== null
      ? tablesExport
      : loaded) as Record<string, unknown>,
  );

  const sql = new SQL(databaseUrl(flags));
  const problems: string[] = [];
  let checkedTables = 0;
  let checkedColumns = 0;
  try {
    const live = await liveColumns(sql);
    for (const table of tables) {
      let config;
      try {
        config = getTableConfig(table as never);
      } catch {
        // Not a table export — a type, a helper, a constant.
        continue;
      }
      const columns = live.get(config.name);
      if (columns === undefined) {
        problems.push(`missing table: ${config.name}`);
        continue;
      }
      checkedTables += 1;
      for (const column of config.columns) {
        const notNull = columns.get(column.name);
        if (notNull === undefined) {
          problems.push(`missing column: ${config.name}.${column.name}`);
          continue;
        }
        checkedColumns += 1;
        // A column the code requires but the database lets be null will hand
        // the application a null it has no branch for.
        if (column.notNull && !notNull)
          problems.push(
            `${config.name}.${column.name} is NOT NULL in the code but nullable in the database`,
          );
      }
    }
  } finally {
    await sql.close();
  }

  if (problems.length > 0) {
    if (mode === "json") writeJson({ compatible: false, problems });
    else {
      writeErr("incompatible — the new binary would fail on:");
      for (const problem of problems) writeErr(`  - ${problem}`);
    }

    return FAILED;
  }
  if (mode === "json")
    writeJson({
      columns: checkedColumns,
      compatible: true,
      tables: checkedTables,
    });
  else
    writeOut(`compatible: ${checkedTables} tables, ${checkedColumns} columns`);

  return OK;
};

export const runDb = async (
  args: DbArgs,
  mode: OutputMode,
): Promise<number> => {
  switch (args.verb) {
    case "check-drift":
      return checkDrift(args.flags, mode);

    case "verify-contract":
      return verifyContract(args.flags, mode);

    case "contract-migrate":
      return contractMigrate(args.flags, mode);

    case "verify-schema":
      return verifySchema(args.flags, mode);

    default:
      writeErr(
        `unknown db verb "${args.verb}". try: check-drift | verify-contract | verify-schema | contract-migrate`,
      );

      return USAGE;
  }
};
