/**
 * `check-drift` through the real drizzle-kit, per dialect. Offline: nothing
 * here contacts a database, which is the point of the placeholder URL.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { runDb } from "../src/commands/db";

setDefaultTimeout(120_000);

type Case = {
  core: string;
  dialect: string;
  imports: string;
  table: string;
  text: string;
};

const CASES: Case[] = [
  {
    core: "pg-core",
    dialect: "postgresql",
    imports: "integer, pgTable, text",
    table: "pgTable",
    text: 'text("{name}")',
  },
  {
    core: "cockroach-core",
    dialect: "cockroach",
    imports: "int4 as integer, cockroachTable, text",
    table: "cockroachTable",
    text: 'text("{name}")',
  },
  {
    core: "mysql-core",
    dialect: "mysql",
    imports: "int as integer, mysqlTable, varchar",
    table: "mysqlTable",
    text: 'varchar("{name}", { length: 255 })',
  },
  {
    core: "singlestore-core",
    dialect: "singlestore",
    imports: "int as integer, singlestoreTable, varchar",
    table: "singlestoreTable",
    text: 'varchar("{name}", { length: 255 })',
  },
  {
    core: "sqlite-core",
    dialect: "sqlite",
    imports: "integer, sqliteTable, text",
    table: "sqliteTable",
    text: 'text("{name}")',
  },
  {
    core: "sqlite-core",
    dialect: "turso",
    imports: "integer, sqliteTable, text",
    table: "sqliteTable",
    text: 'text("{name}")',
  },
  {
    core: "mssql-core",
    dialect: "mssql",
    imports: "int as integer, mssqlTable, nvarchar",
    table: "mssqlTable",
    text: 'nvarchar("{name}", { length: 255 })',
  },
];

const schemaSource = (item: Case, columns: string[]) =>
  `import { ${item.imports} } from "drizzle-orm/${item.core}";

export const users = ${item.table}("users", {
  id: integer("id").primaryKey(),
${columns.map((name) => `  ${name}: ${item.text.replace("{name}", name)},`).join("\n")}
});
`;

const kitAvailable =
  spawnSync("bunx", ["drizzle-kit", "--version"], { encoding: "utf8" })
    .status === 0;
if (!kitAvailable)
  process.stderr.write(
    "\n[db drift] SKIPPING drizzle-kit drift tests: drizzle-kit is not installed\n\n",
  );

let project = "";
let cwd = "";

afterEach(async () => {
  if (cwd !== "") process.chdir(cwd);
  if (project !== "") await rm(project, { force: true, recursive: true });
});

const drift = () =>
  runDb({ flags: {}, positional: [], verb: "check-drift" }, "json");

describe.skipIf(!kitAvailable)("check-drift via drizzle-kit", () => {
  for (const item of CASES)
    test(`${item.dialect}: clean, then drift once the schema moves`, async () => {
      // Inside the package so the schema resolves drizzle-orm.
      project = join(import.meta.dir, `fixtures/drift-${Bun.randomUUIDv7()}`);
      await mkdir(project, { recursive: true });
      await writeFile(
        join(project, "drizzle.config.ts"),
        `export default { dialect: "${item.dialect}", out: "./migrations", schema: "./schema.ts", dbCredentials: { url: process.env.DATABASE_URL } };\n`,
      );
      await writeFile(
        join(project, "schema.ts"),
        schemaSource(item, ["email"]),
      );
      cwd = process.cwd();
      process.chdir(project);
      const saved = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        const init = spawnSync(
          "bunx",
          ["drizzle-kit", "generate", "--name", "init"],
          { encoding: "utf8" },
        );
        expect(init.status).toBe(0);

        expect(await drift()).toBe(0);
        await writeFile(
          join(project, "schema.ts"),
          schemaSource(item, ["email", "nickname"]),
        );
        expect(await drift()).toBe(1);
      } finally {
        if (saved !== undefined) process.env.DATABASE_URL = saved;
      }
    });

  test("gel is refused rather than checked as postgres", async () => {
    project = join(import.meta.dir, `fixtures/drift-${Bun.randomUUIDv7()}`);
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "drizzle.config.ts"),
      'export default { dialect: "gel" };\n',
    );
    cwd = process.cwd();
    process.chdir(project);

    await expect(drift()).rejects.toThrow("Gel is not supported");
  });
});
