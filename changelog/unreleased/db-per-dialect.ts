import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  kind: "added",
  summary:
    "`db` verbs dispatch on the project's engine — read from drizzle.config.* or the Prisma schema, else the URL scheme, else refused: PostgreSQL, CockroachDB, MySQL, MariaDB, SingleStore, SQLite, Turso/libSQL and SQL Server each get their own catalog queries, placeholder URL, lock primitive and ledger types. Prisma 5-7 projects get `check-drift` (migrate diff) and `verify-schema` (migrate status). Gel, MongoDB, Prisma 8 and SingleStore `contract-migrate` are refused with the reason",
};
