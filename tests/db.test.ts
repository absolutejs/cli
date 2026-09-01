/**
 * Migration phase gates.
 *
 * The statement splitter has its own tests because the obvious implementation
 * is silently wrong: every generated migration opens with a comment, so a
 * splitter that drops comment-leading chunks skips the whole file and reports
 * success — and `IF NOT EXISTS` guards on a live database hide it completely.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDb } from "../src/commands/db";
import {
  contractMigrationFiles,
  contractMigrationLayoutErrors,
  destructiveMigrationStatements,
  statementsIn,
} from "../src/utils/migrationPhases";

let root = "";

const migration = async (
  id: string,
  files: { contract?: string; migration?: string },
) => {
  await mkdir(join(root, id), { recursive: true });
  if (files.migration !== undefined)
    await writeFile(join(root, id, "migration.sql"), files.migration);
  if (files.contract !== undefined)
    await writeFile(join(root, id, "contract.sql"), files.contract);
};

beforeEach(async () => {
  root = join(tmpdir(), `absolutejs-db-${Bun.randomUUIDv7()}`);
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("destructiveMigrationStatements", () => {
  test("names what would break a slot still serving", () => {
    expect(destructiveMigrationStatements('DROP TABLE "orders";')).toHaveLength(
      1,
    );
    expect(
      destructiveMigrationStatements('ALTER TABLE "a" DROP COLUMN "b";'),
    ).toHaveLength(1);
    expect(
      destructiveMigrationStatements('ALTER TABLE "a" RENAME TO "b";'),
    ).toHaveLength(1);
    expect(destructiveMigrationStatements('TRUNCATE "logs";')).toHaveLength(1);
  });

  test("leaves additive statements alone", () => {
    expect(
      destructiveMigrationStatements(
        'CREATE TABLE "a" ("id" text);--> statement-breakpoint\nALTER TABLE "a" ADD COLUMN "b" text;',
      ),
    ).toHaveLength(0);
  });
});

describe("statementsIn", () => {
  test("keeps a statement that follows a comment", () => {
    const sql = `-- what this migration is for\n-- and why\nDROP TABLE "old";`;
    expect(statementsIn(sql)).toEqual(['DROP TABLE "old"']);
  });

  test("splits on drizzle's breakpoint and on statement ends", () => {
    const sql = `CREATE INDEX "a" ON "t" ("c");\nDROP INDEX "b";`;
    expect(statementsIn(sql)).toHaveLength(2);
  });

  test("a comment-only file runs nothing rather than one empty statement", () => {
    expect(statementsIn("-- nothing to do here\n")).toEqual([]);
  });
});

describe("contract layout", () => {
  test("destructive SQL in the expand half is an error", async () => {
    await migration("20260101000000_drop", {
      migration: 'DROP TABLE "orders";',
    });
    const errors = await contractMigrationLayoutErrors(root);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("must move to contract.sql");
  });

  test("the same statement in contract.sql is fine", async () => {
    await migration("20260101000000_drop", {
      contract: 'DROP TABLE "orders";',
      migration: "-- post-drain: see contract.sql\n",
    });

    expect(await contractMigrationLayoutErrors(root)).toEqual([]);
  });

  test("an empty contract.sql is a file somebody meant to fill in", async () => {
    await migration("20260101000000_drop", {
      contract: "   \n",
      migration: "-- nothing\n",
    });
    const errors = await contractMigrationLayoutErrors(root);

    expect(errors[0]).toContain("empty");
  });

  test("migrations at or before the cutoff predate the policy", async () => {
    await migration("20250101000000_baseline", {
      migration: 'DROP TABLE "legacy";',
    });
    await migration("20260101000000_after", {
      migration: 'DROP TABLE "orders";',
    });

    expect(
      await contractMigrationLayoutErrors(root, {
        since: "20250101000000_baseline",
      }),
    ).toHaveLength(1);
  });

  test("contract files come back oldest first", async () => {
    await migration("20260301000000_c", { contract: "SELECT 1;" });
    await migration("20260101000000_a", { contract: "SELECT 1;" });
    await migration("20260201000000_b", { contract: "SELECT 1;" });
    const files = await contractMigrationFiles(root);

    expect(files.map((file) => file.id)).toEqual([
      "20260101000000_a",
      "20260201000000_b",
      "20260301000000_c",
    ]);
  });
});

describe("runDb", () => {
  test("verify-contract passes a safe layout and fails an unsafe one", async () => {
    await migration("20260101000000_ok", { migration: 'CREATE TABLE "a" ();' });
    expect(
      await runDb(
        { flags: { dir: root }, positional: [], verb: "verify-contract" },
        "json",
      ),
    ).toBe(0);

    await migration("20260102000000_bad", { migration: 'DROP TABLE "a";' });
    expect(
      await runDb(
        { flags: { dir: root }, positional: [], verb: "verify-contract" },
        "json",
      ),
    ).toBe(1);
  });

  test("an unknown verb is a usage error, not a crash", async () => {
    expect(
      await runDb({ flags: {}, positional: [], verb: "nope" }, "json"),
    ).toBe(2);
  });

  test("verify-schema says what it needs rather than guessing", async () => {
    expect(
      runDb({ flags: {}, positional: [], verb: "verify-schema" }, "json"),
    ).rejects.toThrow("--schema");
  });
});
