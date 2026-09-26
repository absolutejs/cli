/**
 * `verify-schema` and `contract-migrate` against real engines.
 *
 * Every engine runs in its own throwaway container, one at a time, and is
 * removed afterwards. Without docker these skip — loudly, with the reason —
 * rather than pass: a skipped live check is not a verified one.
 *
 * Set ABSOLUTEJS_SKIP_LIVE_DB=1 to skip them deliberately.
 */
import { Database } from "bun:sqlite";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { SQL } from "bun";
import { runDb } from "../src/commands/db";
import type { Dialect } from "../src/utils/dbProject";

setDefaultTimeout(240_000);

const LABEL = "absolutejs-cli-live-db-test";

const skipReason = (): string | undefined => {
  if (process.env.ABSOLUTEJS_SKIP_LIVE_DB === "1")
    return "ABSOLUTEJS_SKIP_LIVE_DB=1";
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
  });
  if (info.error !== undefined)
    return `docker is not installed (${info.error.message})`;
  if (info.status !== 0)
    return `docker is not reachable: ${info.stderr.trim()}`;

  return undefined;
};

const SKIP = skipReason();
if (SKIP !== undefined)
  process.stderr.write(`\n[db.live] SKIPPING live database tests: ${SKIP}\n\n`);
else
  // Leftovers from an aborted run.
  spawnSync("sh", [
    "-c",
    `docker ps -aq --filter label=${LABEL} | xargs -r docker rm -f`,
  ]);

type Row = Record<string, unknown>;

type Live = {
  close: () => Promise<void>;
  exec: (sql: string) => Promise<Row[]>;
  url: string;
};

const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`docker ${args.join(" ")}: ${result.stderr}`);

  return result.stdout.trim();
};

const startContainer = (
  image: string,
  port: number,
  env: Record<string, string>,
  command: string[] = [],
) => {
  const name = `${LABEL}-${Bun.randomUUIDv7().slice(-8)}`;
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    LABEL,
    "-p",
    `127.0.0.1::${port}`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    image,
    ...command,
  ]);
  const mapped = docker(["port", name, `${port}/tcp`]).split("\n")[0] ?? "";
  const hostPort = mapped.slice(mapped.lastIndexOf(":") + 1);

  return { hostPort, name };
};

const waitFor = async (probe: () => Promise<unknown>, what: string) => {
  const deadline = Date.now() + 180_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await probe();

      return;
    } catch (error) {
      last = error;
      await Bun.sleep(1_000);
    }
  }
  throw new Error(`${what} never became ready: ${String(last)}`);
};

const rowsOf = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.map((row: unknown) =>
        typeof row === "object" && row !== null
          ? Object.fromEntries(Object.entries(row))
          : {},
      )
    : [];

const bunSqlLive = async (
  url: string,
  adapter: "mariadb" | "mysql" | "postgres",
  what: string,
): Promise<Live> => {
  await waitFor(async () => {
    const probe = new SQL(url, { adapter });
    try {
      await probe.unsafe("SELECT 1");
    } finally {
      await probe.close();
    }
  }, what);
  const sql = new SQL(url, { adapter });

  return {
    close: () => sql.close(),
    exec: async (statement) => rowsOf(await sql.unsafe(statement)),
    url,
  };
};

type Engine = {
  dialect: Dialect;
  image: string;
  name: string;
  schema: string;
  start: () => Promise<Live & { container: string }>;
};

const fixture = (file: string) => join(import.meta.dir, "fixtures/live", file);

const fixturePrisma = join(import.meta.dir, "fixtures/prisma-postgres");

const MSSQL_PASSWORD = "Live-Test-Passw0rd";

const ENGINES: Engine[] = [
  {
    dialect: "postgresql",
    image: "postgres:17",
    name: "PostgreSQL 17",
    schema: fixture("pgSchema.ts"),
    start: async () => {
      const { hostPort, name } = startContainer("postgres:17", 5432, {
        POSTGRES_DB: "app",
        POSTGRES_PASSWORD: "pw",
      });
      const live = await bunSqlLive(
        `postgres://postgres:pw@127.0.0.1:${hostPort}/app`,
        "postgres",
        "postgres",
      );

      return { ...live, container: name };
    },
  },
  {
    dialect: "cockroach",
    image: "cockroachdb/cockroach:latest",
    name: "CockroachDB (single node, insecure)",
    schema: fixture("cockroachSchema.ts"),
    start: async () => {
      const { hostPort, name } = startContainer(
        "cockroachdb/cockroach:latest",
        26257,
        {},
        ["start-single-node", "--insecure"],
      );
      const live = await bunSqlLive(
        `postgresql://root@127.0.0.1:${hostPort}/defaultdb?sslmode=disable`,
        "postgres",
        "cockroach",
      );

      return { ...live, container: name };
    },
  },
  {
    dialect: "mysql",
    image: "mysql:8",
    name: "MySQL 8",
    schema: fixture("mysqlSchema.ts"),
    start: async () => {
      const { hostPort, name } = startContainer("mysql:8", 3306, {
        MYSQL_DATABASE: "app",
        MYSQL_ROOT_PASSWORD: "pw",
      });
      // MySQL 8's caching_sha2 login needs TLS (or RSA key retrieval, which
      // Bun's driver does not offer).
      const live = await bunSqlLive(
        `mysql://root:pw@127.0.0.1:${hostPort}/app?sslmode=require`,
        "mysql",
        "mysql",
      );

      return { ...live, container: name };
    },
  },
  {
    dialect: "mariadb",
    image: "mariadb:11",
    name: "MariaDB 11",
    schema: fixture("mysqlSchema.ts"),
    start: async () => {
      const { hostPort, name } = startContainer("mariadb:11", 3306, {
        MARIADB_DATABASE: "app",
        MARIADB_ROOT_PASSWORD: "pw",
      });
      const live = await bunSqlLive(
        `mariadb://root:pw@127.0.0.1:${hostPort}/app`,
        "mariadb",
        "mariadb",
      );

      return { ...live, container: name };
    },
  },
  {
    dialect: "mssql",
    image: "mcr.microsoft.com/mssql/server:2022-latest",
    name: "SQL Server 2022",
    schema: fixture("mssqlSchema.ts"),
    start: async () => {
      const { hostPort, name } = startContainer(
        "mcr.microsoft.com/mssql/server:2022-latest",
        1433,
        { ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: MSSQL_PASSWORD },
      );
      // Prisma's URL form, to exercise the conversion to an ADO string.
      const url = `sqlserver://127.0.0.1:${hostPort};database=master;user=sa;password=${MSSQL_PASSWORD};encrypt=false;trustServerCertificate=true`;
      const { default: mssql } = await import("mssql");
      const ado = `Server=127.0.0.1,${hostPort};Database=master;User Id=sa;Password=${MSSQL_PASSWORD};Encrypt=false;TrustServerCertificate=true`;
      let pool: InstanceType<typeof mssql.ConnectionPool> | undefined;
      await waitFor(async () => {
        pool = await new mssql.ConnectionPool(ado).connect();
      }, "sql server");
      const connected = pool;
      if (connected === undefined) throw new Error("sql server pool missing");

      return {
        close: () => connected.close(),
        container: name,
        exec: async (statement) =>
          rowsOf((await connected.request().query(statement)).recordset),
        url,
      };
    },
  },
  {
    dialect: "singlestore",
    image: "ghcr.io/singlestore-labs/singlestoredb-dev:latest",
    name: "SingleStore (dev image, free tier)",
    schema: fixture("singlestoreSchema.ts"),
    start: async () => {
      const { hostPort, name } = startContainer(
        "ghcr.io/singlestore-labs/singlestoredb-dev:latest",
        3306,
        { ROOT_PASSWORD: "pw" },
      );
      const admin = await bunSqlLive(
        `mysql://root:pw@127.0.0.1:${hostPort}/information_schema`,
        "mysql",
        "singlestore",
      );
      await admin.exec("CREATE DATABASE IF NOT EXISTS app");
      await admin.close();
      const live = await bunSqlLive(
        `mysql://root:pw@127.0.0.1:${hostPort}/app`,
        "mysql",
        "singlestore",
      );

      // The CLI is handed the singlestore:// form drizzle users write.
      return {
        ...live,
        container: name,
        url: `singlestore://root:pw@127.0.0.1:${hostPort}/app`,
      };
    },
  },
  {
    dialect: "turso",
    image: "ghcr.io/tursodatabase/libsql-server:latest",
    name: "Turso / libSQL server (sqld)",
    schema: fixture("sqliteSchema.ts"),
    start: async () => {
      const { hostPort, name } = startContainer(
        "ghcr.io/tursodatabase/libsql-server:latest",
        8080,
        {},
      );
      const url = `http://127.0.0.1:${hostPort}`;
      const { createClient } = await import("@libsql/client");
      const client = createClient({ url });
      await waitFor(() => client.execute("SELECT 1"), "libsql");

      return {
        close: async () => client.close(),
        container: name,
        exec: async (statement) => {
          const result = await client.execute(statement);

          return result.rows.map((row) =>
            Object.fromEntries(
              result.columns.map((column, index) => [column, row[index]]),
            ),
          );
        },
        url,
      };
    },
  },
];

const sqliteEngine = async (): Promise<Live & { dir: string }> => {
  const dir = join(tmpdir(), `absolutejs-live-sqlite-${Bun.randomUUIDv7()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "app.db");
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");

  return {
    close: async () => db.close(),
    dir,
    exec: async (statement) => rowsOf(db.query(statement).all()),
    url: `file:${path}`,
  };
};

const verify = (dialect: Dialect, url: string, schema: string) =>
  runDb(
    { flags: { dialect, schema, url }, positional: [], verb: "verify-schema" },
    "json",
  );

const contractMigrate = (dialect: Dialect, url: string, dir: string) =>
  runDb(
    { flags: { dialect, dir, url }, positional: [], verb: "contract-migrate" },
    "json",
  );

const count = async (live: Live, statement: string) => {
  const [row] = await live.exec(statement);

  return Number(row?.n);
};

/** The same behavior asked of every engine. */
const liveSuite = (dialect: Dialect, schema: string, current: () => Live) => {
  // SingleStore has no GET_LOCK, so contract-migrate refuses it — asserted
  // below rather than run.
  const contract = dialect === "singlestore" ? test.skip : test;
  const recreate = async (definition: string) => {
    const live = current();
    await live.exec("DROP TABLE IF EXISTS users");
    if (definition !== "")
      await live.exec(`CREATE TABLE users (${definition})`);
  };

  test("verify-schema passes when the database has what the code selects, extras included", async () => {
    await recreate(
      "id integer PRIMARY KEY, email varchar(255) NOT NULL, nickname varchar(255), extra varchar(255)",
    );
    expect(await verify(dialect, current().url, schema)).toBe(0);
  });

  test("verify-schema fails on a missing column", async () => {
    await recreate("id integer PRIMARY KEY, email varchar(255) NOT NULL");
    expect(await verify(dialect, current().url, schema)).toBe(1);
  });

  test("verify-schema fails when the code requires NOT NULL and the database allows null", async () => {
    await recreate(
      "id integer PRIMARY KEY, email varchar(255), nickname varchar(255)",
    );
    expect(await verify(dialect, current().url, schema)).toBe(1);
  });

  test("verify-schema fails on a missing table", async () => {
    await recreate("");
    expect(await verify(dialect, current().url, schema)).toBe(1);
  });

  contract(
    "contract-migrate applies each file once, even with two deploys racing",
    async () => {
      const live = current();
      const dir = join(
        tmpdir(),
        `absolutejs-live-contract-${Bun.randomUUIDv7()}`,
      );
      try {
        await live.exec("DROP TABLE IF EXISTS deployment_contract_migration");
        await live.exec(
          "DROP TABLE IF EXISTS deployment_contract_migration_lock",
        );
        await live.exec("DROP TABLE IF EXISTS counter");
        await live.exec("DROP TABLE IF EXISTS legacy");
        await live.exec("CREATE TABLE legacy (id integer PRIMARY KEY)");
        await live.exec("CREATE TABLE counter (n integer NOT NULL)");
        for (const [id, contract] of [
          ["20260101000000_drop_legacy", "-- post-drain\nDROP TABLE legacy;"],
          [
            "20260102000000_count",
            "INSERT INTO counter (n) VALUES (1);\n--> statement-breakpoint\nINSERT INTO counter (n) VALUES (2);",
          ],
        ] as const) {
          await mkdir(join(dir, id), { recursive: true });
          await writeFile(
            join(dir, id, "migration.sql"),
            "-- see contract.sql\n",
          );
          await writeFile(join(dir, id, "contract.sql"), contract);
        }

        const codes = await Promise.all([
          contractMigrate(dialect, live.url, dir),
          contractMigrate(dialect, live.url, dir),
        ]);
        expect(codes).toEqual([0, 0]);
        expect(await count(live, "SELECT COUNT(*) AS n FROM counter")).toBe(2);
        expect(
          await count(
            live,
            "SELECT COUNT(*) AS n FROM deployment_contract_migration",
          ),
        ).toBe(2);
        await expect(live.exec("SELECT * FROM legacy")).rejects.toThrow();

        expect(await contractMigrate(dialect, live.url, dir)).toBe(0);
        expect(await count(live, "SELECT COUNT(*) AS n FROM counter")).toBe(2);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  contract(
    "contract-migrate rolls back a file that fails and records nothing",
    async () => {
      const live = current();
      const dir = join(
        tmpdir(),
        `absolutejs-live-contract-${Bun.randomUUIDv7()}`,
      );
      try {
        await live.exec("DROP TABLE IF EXISTS deployment_contract_migration");
        await live.exec("DROP TABLE IF EXISTS counter");
        await live.exec("CREATE TABLE counter (n integer NOT NULL)");
        for (const [id, contract] of [
          // Applies cleanly, so the ledger exists for the assertion below.
          ["20260103000000_fine", "DELETE FROM counter;"],
          [
            "20260104000000_broken",
            "INSERT INTO counter (n) VALUES (1);\n--> statement-breakpoint\nINSERT INTO no_such_table (n) VALUES (1);",
          ],
        ] as const) {
          await mkdir(join(dir, id), { recursive: true });
          await writeFile(
            join(dir, id, "migration.sql"),
            "-- see contract.sql\n",
          );
          await writeFile(join(dir, id, "contract.sql"), contract);
        }

        await expect(contractMigrate(dialect, live.url, dir)).rejects.toThrow();
        expect(
          await count(
            live,
            "SELECT COUNT(*) AS n FROM deployment_contract_migration",
          ),
        ).toBe(1);
        // DML rolls back with the failed file on every engine (MySQL's
        // exception is DDL, which commits implicitly).
        expect(await count(live, "SELECT COUNT(*) AS n FROM counter")).toBe(0);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );
};

for (const engine of ENGINES) {
  describe.skipIf(SKIP !== undefined)(`live: ${engine.name}`, () => {
    let live: (Live & { container: string }) | undefined;
    const current = () => {
      if (live === undefined) throw new Error(`${engine.name} did not start`);

      return live;
    };

    beforeAll(async () => {
      live = await engine.start();
    });

    afterAll(async () => {
      await live?.close();
      if (live !== undefined) spawnSync("docker", ["rm", "-f", live.container]);
    });

    liveSuite(engine.dialect, engine.schema, current);

    if (engine.dialect === "cockroach")
      test("a pg-core schema verifies against CockroachDB too", async () => {
        const db = current();
        await db.exec("DROP TABLE IF EXISTS users");
        await db.exec(
          "CREATE TABLE users (id integer PRIMARY KEY, email varchar(255) NOT NULL, nickname varchar(255))",
        );
        expect(await verify("cockroach", db.url, fixture("pgSchema.ts"))).toBe(
          0,
        );
      });

    if (engine.dialect === "postgresql")
      test("a Prisma 7 project: verify-schema via migrate status, check-drift via migrate diff", async () => {
        const db = current();
        // migrate deploy refuses a non-empty schema it has no history for.
        await db.exec("DROP SCHEMA public CASCADE");
        await db.exec("CREATE SCHEMA public");
        await db.exec("DROP DATABASE IF EXISTS shadow");
        await db.exec("CREATE DATABASE shadow");
        const project = join(
          import.meta.dir,
          `fixtures/prisma-tmp-${Bun.randomUUIDv7()}`,
        );
        await cp(fixturePrisma, project, { recursive: true });
        const cwd = process.cwd();
        const flags = {
          "shadow-url": db.url.replace(/\/app$/u, "/shadow"),
          url: db.url,
        };
        process.chdir(project);
        try {
          // Nothing applied yet: the new build's migrations are missing.
          expect(
            await runDb(
              { flags, positional: [], verb: "verify-schema" },
              "json",
            ),
          ).toBe(1);
          const deployed = spawnSync("bunx", ["prisma", "migrate", "deploy"], {
            encoding: "utf8",
            env: { ...process.env, DATABASE_URL: db.url },
          });
          expect(`${deployed.status} ${deployed.stderr}`).toStartWith("0 ");
          expect(
            await runDb(
              { flags, positional: [], verb: "verify-schema" },
              "json",
            ),
          ).toBe(0);

          expect(
            await runDb({ flags, positional: [], verb: "check-drift" }, "json"),
          ).toBe(0);
          const schemaPath = join(project, "prisma/schema.prisma");
          await writeFile(
            schemaPath,
            (await Bun.file(schemaPath).text()).replace(
              "nickname String?",
              "nickname String?\n  age      Int?",
            ),
          );
          expect(
            await runDb({ flags, positional: [], verb: "check-drift" }, "json"),
          ).toBe(1);
        } finally {
          process.chdir(cwd);
          await rm(project, { force: true, recursive: true });
        }
      });

    if (engine.dialect === "singlestore")
      test("contract-migrate refuses SingleStore rather than racing", async () => {
        const dir = join(tmpdir(), `absolutejs-live-s2-${Bun.randomUUIDv7()}`);
        await mkdir(join(dir, "20260101000000_x"), { recursive: true });
        await writeFile(
          join(dir, "20260101000000_x", "contract.sql"),
          "SELECT 1;",
        );
        try {
          await expect(
            contractMigrate("singlestore", current().url, dir),
          ).rejects.toThrow("GET_LOCK");
        } finally {
          await rm(dir, { force: true, recursive: true });
        }
      });

    test("a schema of another dialect is refused, not passed", async () => {
      const other =
        engine.dialect === "mysql" || engine.dialect === "mariadb"
          ? fixture("pgSchema.ts")
          : fixture("mysqlSchema.ts");
      await expect(
        verify(engine.dialect, current().url, other),
      ).rejects.toThrow("cannot verify 1 table export");
    });
  });
}

describe.skipIf(SKIP !== undefined)("live: SQLite file", () => {
  let live: (Live & { dir: string }) | undefined;
  const current = () => {
    if (live === undefined) throw new Error("sqlite did not open");

    return live;
  };

  beforeAll(async () => {
    live = await sqliteEngine();
  });

  afterAll(async () => {
    await live?.close();
    if (live !== undefined)
      await rm(live.dir, { force: true, recursive: true });
  });

  liveSuite("sqlite", fixture("sqliteSchema.ts"), current);

  test("a TEXT PRIMARY KEY without NOT NULL is nullable in SQLite, and says so", async () => {
    const db = current();
    await db.exec("DROP TABLE IF EXISTS users");
    await db.exec(
      "CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL, nickname text)",
    );
    expect(await verify("sqlite", db.url, fixture("sqliteSchema.ts"))).toBe(1);
  });
});
