/**
 * Engine detection. The live verbs build SQL for one engine, so reading the
 * wrong one is not a soft failure: it runs PostgreSQL SQL against MySQL, or
 * worse, a check against nothing that reports success.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { mssqlConnectionString, sqlitePath } from "../src/utils/dbEngines";
import {
  detectProject,
  dialectFromUrl,
  parseDialect,
} from "../src/utils/dbProject";

let root = "";
let cwd = "";

beforeEach(async () => {
  cwd = process.cwd();
  root = join(tmpdir(), `absolutejs-dbproject-${Bun.randomUUIDv7()}`);
  await mkdir(root, { recursive: true });
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(root, { force: true, recursive: true });
});

describe("parseDialect", () => {
  test("takes drizzle-kit's names and the common aliases", () => {
    expect(parseDialect("postgresql", "t")).toBe("postgresql");
    expect(parseDialect("postgres", "t")).toBe("postgresql");
    expect(parseDialect("cockroachdb", "t")).toBe("cockroach");
    expect(parseDialect("sqlserver", "t")).toBe("mssql");
    expect(parseDialect("turso", "t")).toBe("turso");
  });

  test("refuses engines it cannot gate, saying why", () => {
    expect(() => parseDialect("gel", "t")).toThrow("Gel is not supported");
    expect(() => parseDialect("mongodb", "t")).toThrow(
      "MongoDB is not supported",
    );
    expect(() => parseDialect("oracle", "t")).toThrow("unknown");
  });
});

describe("dialectFromUrl", () => {
  test("reads the scheme", () => {
    expect(dialectFromUrl("postgres://a@b/c")).toBe("postgresql");
    expect(dialectFromUrl("mysql://a@b/c")).toBe("mysql");
    expect(dialectFromUrl("mariadb://a@b/c")).toBe("mariadb");
    expect(dialectFromUrl("sqlserver://h:1433;database=d")).toBe("mssql");
    expect(dialectFromUrl("libsql://x.turso.io")).toBe("turso");
    expect(dialectFromUrl("file:./app.db")).toBe("sqlite");
    expect(dialectFromUrl("./app.db")).toBeUndefined();
  });
});

describe("detectProject", () => {
  test("a drizzle config's dialect, out and schema win over the URL", async () => {
    await writeFile(
      join(root, "drizzle.config.ts"),
      'export default { dialect: "mysql", out: "./migrations", schema: "./src/schema.ts" };',
    );
    const project = await detectProject({}, "postgres://x@y/z");

    expect(project).toMatchObject({
      dialect: "mysql",
      migrationsDir: join(root, "migrations"),
      orm: "drizzle",
      schemaModule: join(root, "src/schema.ts"),
    });
  });

  test("a config that cannot be imported is read literally", async () => {
    await writeFile(
      join(root, "drizzle.config.ts"),
      'import { defineConfig } from "drizzle-kit-not-installed";\nexport default defineConfig({ dialect: "sqlite", schema: "./db/*.ts" });',
    );
    const project = await detectProject({}, undefined);

    expect(project).toMatchObject({
      dialect: "sqlite",
      schemaModule: undefined,
    });
  });

  test("a mysql config against a mariadb:// URL is MariaDB", async () => {
    await writeFile(
      join(root, "drizzle.config.json"),
      JSON.stringify({ dialect: "mysql" }),
    );

    expect((await detectProject({}, "mariadb://a@b/c")).dialect).toBe(
      "mariadb",
    );
  });

  test("a gel config is refused, not treated as postgres", async () => {
    await writeFile(
      join(root, "drizzle.config.ts"),
      'export default { dialect: "gel" };',
    );

    await expect(detectProject({}, "postgres://x@y/z")).rejects.toThrow("Gel");
  });

  test("a Prisma schema names its provider", async () => {
    await mkdir(join(root, "prisma"));
    await writeFile(
      join(root, "prisma/schema.prisma"),
      'datasource db {\n  provider = "sqlserver"\n  url = env("DATABASE_URL")\n}\n',
    );
    const project = await detectProject({}, undefined);

    expect(project).toMatchObject({
      dialect: "mssql",
      migrationsDir: join(root, "prisma/migrations"),
      orm: "prisma",
    });
  });

  test("a Prisma MongoDB project is refused", async () => {
    await writeFile(
      join(root, "schema.prisma"),
      'datasource db {\n  provider = "mongodb"\n}\n',
    );

    await expect(detectProject({}, undefined)).rejects.toThrow("MongoDB");
  });

  test("with nothing to go on it refuses rather than assuming postgres", async () => {
    await expect(detectProject({}, undefined)).rejects.toThrow(
      "cannot tell which database",
    );
    expect((await detectProject({}, "postgres://a@b/c")).dialect).toBe(
      "postgresql",
    );
    expect(
      (await detectProject({ dialect: "cockroach" }, undefined)).dialect,
    ).toBe("cockroach");
  });
});

describe("connection strings", () => {
  test("Prisma's sqlserver:// becomes an ADO string", () => {
    expect(
      mssqlConnectionString(
        "sqlserver://db.example:1433;database=app;user=sa;password=p=w;trustServerCertificate=true",
      ),
    ).toBe(
      "Server=db.example,1433;database=app;User Id=sa;password=p=w;trustServerCertificate=true",
    );
  });

  test("SQLite URLs resolve to paths, and memory is refused", () => {
    expect(sqlitePath("file:./app.db")).toBe("./app.db");
    expect(sqlitePath("file:///var/app.db")).toBe("/var/app.db");
    expect(sqlitePath("sqlite://./app.db?mode=rw")).toBe("./app.db");
    expect(sqlitePath("./app.db")).toBe("./app.db");
    expect(() => sqlitePath(":memory:")).toThrow("in-memory");
  });
});
