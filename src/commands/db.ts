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
 * Every engine Drizzle or Prisma targets is dispatched on its own terms —
 * PostgreSQL, CockroachDB, MySQL, MariaDB, SingleStore, SQLite, Turso/libSQL
 * and SQL Server — with the dialect read from the project's drizzle.config.*
 * or Prisma schema. An engine a verb cannot serve is refused by name, never
 * quietly treated as PostgreSQL.
 *
 * Every project that deploys migrations without downtime ends up
 * writing these four, and getting any of them subtly wrong is invisible until
 * a deploy fails — a drift check that passes because it silently skipped the
 * file, a contract runner that reports success because its statement splitter
 * ate the migration behind an opening comment.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  applyContractMigrations,
  assertIdentifier,
  liveCatalog,
} from "../utils/dbEngines";
import {
  defaultMigrationsDir,
  detectProject,
  stringFlag,
  type Dialect,
  type Flags,
  type Project,
} from "../utils/dbProject";
import { readSchemaTables } from "../utils/drizzleTables";
import {
  contractMigrationFiles,
  contractMigrationLayoutErrors,
} from "../utils/migrationPhases";
import { prismaCheckDrift, prismaMigrateStatus } from "../utils/prisma";
import {
  writeErr,
  writeJson,
  writeOut,
  type OutputMode,
} from "../utils/output";

export type DbArgs = {
  flags: Flags;
  positional: string[];
  verb: string;
};

const GUARD_NAME = "absolutejs_schema_guard";
const DEFAULT_LEDGER = "deployment_contract_migration";
const DEFAULT_LOCK = "absolutejs:contract-migrations";
const OK = 0;
const FAILED = 1;
const USAGE = 2;

const optionalUrl = (flags: Flags): string | undefined => {
  const url = stringFlag(flags, "url") ?? process.env.DATABASE_URL;

  return url === "" ? undefined : url;
};

const databaseUrl = (flags: Flags): string => {
  const url = optionalUrl(flags);
  if (url === undefined)
    throw new Error("DATABASE_URL is required (or pass --url)");

  return url;
};

const migrationDir = (flags: Flags, project: Project | undefined) => {
  const dir = stringFlag(flags, "dir");

  return dir === undefined ? defaultMigrationsDir(project) : resolve(dir);
};

/** A URL of the dialect's shape that nothing will ever answer on: drizzle-kit
 *  configs commonly read DATABASE_URL at load, and check/generate never
 *  connect. */
const PLACEHOLDER_URL: Record<Dialect, string> = {
  cockroach: "postgresql://drift-check@localhost:26257/drift_check",
  mariadb: "mysql://drift-check:placeholder@localhost:3306/drift_check",
  mssql: "mssql://drift-check:placeholder@localhost:1433/drift_check",
  mysql: "mysql://drift-check:placeholder@localhost:3306/drift_check",
  postgresql: "postgres://drift-check:placeholder@localhost:5432/drift_check",
  singlestore: "mysql://drift-check:placeholder@localhost:3306/drift_check",
  sqlite: ":memory:",
  turso: ":memory:",
};

/**
 * Does the committed journal cover the current schema?
 *
 * A schema file is not the whole schema surface — constants it imports are
 * schema too, so editing one without regenerating produces drift that
 * typecheck, lint and tests all miss and that surfaces as a failed deploy.
 *
 * Drizzle: the check runs the generator under a marker name and looks for
 * what it wrote. Nothing contacts a database. A real migration that is
 * pending but uncommitted does not false-positive: the generator finds no
 * further changes on top of it.
 *
 * Prisma: `prisma migrate diff` from the migrations folder to the schema.
 */
const checkDrift = async (flags: Flags, mode: OutputMode): Promise<number> => {
  const project = await detectProject(flags, optionalUrl(flags));
  if (project.orm === "prisma") return checkPrismaDrift(flags, project, mode);

  const dir = migrationDir(flags, project);
  const configArgs =
    project.configPath === undefined ? [] : ["--config", project.configPath];
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? PLACEHOLDER_URL[project.dialect],
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
    if (mode === "json") writeJson({ dialect: project.dialect, drift: false });
    else
      writeOut(
        `no schema drift — migrations cover the schema (${project.dialect})`,
      );

    return OK;
  }

  const wanted = guards.flatMap((guard) => {
    const sqlPath = join(dir, guard, "migration.sql");

    return existsSync(sqlPath)
      ? [{ dir: guard, sql: readFileSync(sqlPath, "utf8") }]
      : [];
  });
  removeGuards();

  if (mode === "json")
    writeJson({ dialect: project.dialect, drift: true, wanted });
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

const checkPrismaDrift = (
  flags: Flags,
  project: Extract<Project, { orm: "prisma" }>,
  mode: OutputMode,
): number => {
  const result = prismaCheckDrift(
    project,
    stringFlag(flags, "shadow-url") ?? process.env.SHADOW_DATABASE_URL,
  );
  if ("error" in result) {
    writeErr(result.error);
    writeErr("prisma migrate diff failed");

    return FAILED;
  }
  if (!result.drift) {
    if (mode === "json")
      writeJson({ dialect: project.dialect, drift: false, orm: "prisma" });
    else
      writeOut(
        `no schema drift — migrations cover the schema (prisma, ${project.dialect})`,
      );

    return OK;
  }
  if (mode === "json")
    writeJson({
      dialect: project.dialect,
      drift: true,
      orm: "prisma",
      summary: result.summary,
    });
  else {
    writeErr(
      "schema drift: the Prisma schema has changes with no committed migration:",
    );
    writeErr(result.summary);
    writeErr("\nRun `prisma migrate dev --name <change>` and commit it.");
  }

  return FAILED;
};

/** Offline gate: nothing destructive in `migration.sql`, no empty
 *  `contract.sql`. Runs before anything ships, so an unsafe layout fails the
 *  build rather than the old slot. Engine-independent. */
const verifyContract = async (
  flags: Flags,
  mode: OutputMode,
): Promise<number> => {
  const project =
    stringFlag(flags, "dir") === undefined
      ? await detectProject(flags, optionalUrl(flags)).catch(() => undefined)
      : undefined;
  const dir = migrationDir(flags, project);
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
 * Every file runs under the engine's lock primitive and is re-checked against
 * the ledger once the lock is held, so two deploys racing cannot both apply
 * it. Where DDL is transactional (PostgreSQL, CockroachDB, SQL Server,
 * SQLite) the file and its ledger row commit together; MySQL and MariaDB
 * commit implicitly around DDL, which `applyMySql` documents.
 */
const contractMigrate = async (
  flags: Flags,
  mode: OutputMode,
): Promise<number> => {
  const url = databaseUrl(flags);
  const project = await detectProject(flags, url);
  const dir = migrationDir(flags, project);
  const since = stringFlag(flags, "since");
  const ledger = assertIdentifier(
    stringFlag(flags, "ledger") ?? DEFAULT_LEDGER,
    "ledger",
  );
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
  const applied = await applyContractMigrations(project.dialect, url, {
    ledger,
    lock,
    migrations,
    onApplied: (id) => {
      if (mode === "human") writeOut(`applied ${id}`);
    },
  });

  if (mode === "json")
    writeJson({
      applied,
      dialect: project.dialect,
      skipped: migrations.length - applied.length,
    });
  else
    writeOut(
      `post-drain contract current on ${project.dialect} (${applied.length} applied, ${migrations.length - applied.length} skipped)`,
    );

  return OK;
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
 *
 * It fails rather than passes when it cannot look: a table export the
 * project's dialect cannot read is an error naming it, and a schema with no
 * tables at all is an error — "compatible" is only ever said about tables
 * that were actually compared.
 */
const verifySchema = async (
  flags: Flags,
  mode: OutputMode,
): Promise<number> => {
  const url = optionalUrl(flags);
  const project = await detectProject(flags, url);
  if (project.orm === "prisma")
    return verifyPrismaSchema(project, databaseUrl(flags), mode);

  const modulePath = stringFlag(flags, "schema") ?? project.schemaModule;
  if (modulePath === undefined)
    throw new Error(
      "--schema <path> is required: the module exporting your Drizzle tables",
    );
  const exportName = stringFlag(flags, "export") ?? "schema";
  const loaded = (await import(resolve(modulePath))) as Record<string, unknown>;
  const tablesExport = loaded[exportName];
  // Either a `schema` object of tables, or the module's own table exports.
  const exported = Object.entries(
    (typeof tablesExport === "object" && tablesExport !== null
      ? tablesExport
      : loaded) as Record<string, unknown>,
  );
  const { cores, tables, unreadable } = await readSchemaTables(
    project.dialect,
    exported,
  );
  if (unreadable.length > 0)
    throw new Error(
      `cannot verify ${unreadable.length} table export(s) — they are not ${project.dialect} tables (expected drizzle-orm/${cores.join(" or drizzle-orm/")}): ${unreadable.join(", ")}`,
    );
  if (tables.length === 0)
    throw new Error(
      `no Drizzle tables found in ${modulePath}${tablesExport === undefined ? "" : ` (export "${exportName}")`} — refusing to report a schema compatible having checked nothing`,
    );

  const live = await liveCatalog(project.dialect, databaseUrl(flags));
  const problems: string[] = [];
  let checkedTables = 0;
  let checkedColumns = 0;
  for (const table of tables) {
    const schema =
      project.dialect === "sqlite" || project.dialect === "turso"
        ? live.defaultSchema
        : (table.schema ?? live.defaultSchema);
    const label =
      table.schema === undefined ? table.name : `${table.schema}.${table.name}`;
    const columns = live.columns.get(`${schema}.${table.name}`);
    if (columns === undefined) {
      problems.push(`missing table: ${label}`);
      continue;
    }
    checkedTables += 1;
    for (const column of table.columns) {
      const notNull = columns.get(column.name);
      if (notNull === undefined) {
        problems.push(`missing column: ${label}.${column.name}`);
        continue;
      }
      checkedColumns += 1;
      // A column the code requires but the database lets be null will hand
      // the application a null it has no branch for.
      if (column.notNull && !notNull)
        problems.push(
          `${label}.${column.name} is NOT NULL in the code but nullable in the database`,
        );
    }
  }

  if (problems.length > 0) {
    if (mode === "json")
      writeJson({ compatible: false, dialect: project.dialect, problems });
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
      dialect: project.dialect,
      tables: checkedTables,
    });
  else
    writeOut(
      `compatible (${project.dialect}): ${checkedTables} tables, ${checkedColumns} columns`,
    );

  return OK;
};

const verifyPrismaSchema = (
  project: Extract<Project, { orm: "prisma" }>,
  url: string,
  mode: OutputMode,
): number => {
  const result = prismaMigrateStatus(project, url);
  const compatible = result.status === 0;
  if (mode === "json")
    writeJson({
      compatible,
      dialect: project.dialect,
      orm: "prisma",
      output: result.output,
    });
  else if (compatible)
    writeOut(
      `compatible (prisma, ${project.dialect}): every migration is applied`,
    );
  else {
    writeErr(result.output);
    writeErr(
      "incompatible — prisma migrate status reports the database is not up to date with the migrations the new build ships",
    );
  }

  return compatible ? OK : FAILED;
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
