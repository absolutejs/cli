import type { Change } from "@absolutejs/changelog";

export const change: Change = {
  kind: "fixed",
  summary:
    '`db verify-schema` no longer reports a schema compatible having checked nothing: a table export the project\'s dialect cannot read is an error naming it, and a schema with zero tables is an error (MySQL and SQLite tables were silently skipped as "not a table")',
};
