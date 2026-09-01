/**
 * Expand/contract policy for journaled Drizzle migrations.
 *
 * A zero-downtime deploy runs two binaries against one database: the old slot
 * is still serving while the new one boots. A migration that drops or renames
 * something the old slot still selects takes that slot down mid-deploy. So a
 * migration is split — `migration.sql` may only add, and anything destructive
 * moves to `contract.sql`, which runs after the old slot has drained.
 *
 * The rule is only worth anything if it is checked, which is what this is for:
 * an offline gate that fails the build rather than the deployment.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Statements that can break a running slot.
 *
 * Deliberately blunt. A pattern that occasionally flags something harmless
 * costs one `contract.sql` file; a pattern that misses something costs an
 * outage during a deploy, which is the failure this exists to prevent.
 */
const DESTRUCTIVE_PATTERNS = [
  /\bdrop\s+(?:column|constraint|function|index|schema|table|trigger|type)\b/iu,
  /\btruncate\b/iu,
  /\balter\s+table\b[\s\S]*\b(?:alter\s+column|rename\s+(?:column|to))\b/iu,
  /\balter\s+type\b[\s\S]*\brename\b/iu,
];

export type ContractMigrationFile = {
  id: string;
  path: string;
  sql: string;
};

export type MigrationPhaseOptions = {
  /**
   * Migrations at or before this directory id predate the policy and are left
   * alone. Without it, adopting the policy on an existing project means either
   * rewriting history or failing forever on migrations that already ran.
   */
  since?: string;
};

const migrationDirectoryIds = async (
  drizzleRoot: string,
  options: MigrationPhaseOptions,
): Promise<string[]> => {
  const entries = await readdir(drizzleRoot, { withFileTypes: true });

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (options.since === undefined || entry.name > options.since),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
};

const readText = async (path: string): Promise<string | undefined> => {
  const file = Bun.file(path);

  return (await file.exists()) ? file.text() : undefined;
};

export const destructiveMigrationStatements = (sql: string): string[] =>
  sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement !== "" &&
        DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(statement)),
    );

const layoutErrorsFor = async (
  drizzleRoot: string,
  id: string,
): Promise<string[]> => {
  const migrationPath = join(drizzleRoot, id, "migration.sql");
  const migrationSql = await readText(migrationPath);
  if (migrationSql === undefined) return [];

  const destructive = destructiveMigrationStatements(migrationSql);
  const errors =
    destructive.length === 0
      ? []
      : [
          `${migrationPath}: destructive SQL must move to contract.sql so it runs after the old slot drains: ${destructive.join("; ")}`,
        ];

  const contractPath = join(drizzleRoot, id, "contract.sql");
  const contractSql = await readText(contractPath);
  if (contractSql === undefined) return errors;

  // An empty contract.sql is a file somebody meant to fill in. Left silent it
  // reads as "the destructive half ran", which is the one thing it did not do.
  return contractSql.trim() === ""
    ? [...errors, `${contractPath}: contract migration is empty`]
    : errors;
};

/** Every contract migration on disk, oldest first. */
export const contractMigrationFiles = async (
  drizzleRoot: string,
  options: MigrationPhaseOptions = {},
): Promise<ContractMigrationFile[]> => {
  const ids = await migrationDirectoryIds(drizzleRoot, options);
  const files = await Promise.all(
    ids.map(async (id) => {
      const path = join(drizzleRoot, id, "contract.sql");
      const sql = await readText(path);

      return sql === undefined ? null : { id, path, sql };
    }),
  );

  return files.filter((file): file is ContractMigrationFile => file !== null);
};

/** Everything wrong with how the migrations are split. Empty means safe. */
export const contractMigrationLayoutErrors = async (
  drizzleRoot: string,
  options: MigrationPhaseOptions = {},
): Promise<string[]> => {
  const ids = await migrationDirectoryIds(drizzleRoot, options);
  const errors = await Promise.all(
    ids.map((id) => layoutErrorsFor(drizzleRoot, id)),
  );

  return errors.flat();
};

/**
 * Split a SQL file into runnable statements.
 *
 * Comment-only lines are stripped from each chunk rather than the chunk being
 * dropped when it starts with one — every generated migration opens with a
 * comment, so the naive version silently skips the entire file and reports
 * success. `IF NOT EXISTS` guards on a live database hide that completely.
 */
export const statementsIn = (source: string): string[] =>
  source
    .split(/-->\s*statement-breakpoint|;\s*$/mu)
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !/^\s*--/u.test(line))
        .join("\n")
        .trim(),
    )
    .filter((chunk) => chunk.length > 0);
