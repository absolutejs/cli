/**
 * Per-engine connections, catalogs and locks for the live `db` verbs.
 *
 * Each engine family gets its own driver and its own SQL:
 *
 *   postgresql, cockroach       Bun SQL (postgres wire)
 *   mysql, mariadb, singlestore Bun SQL (mysql wire)
 *   sqlite, turso (file:)       bun:sqlite
 *   turso (libsql://, http://)  @libsql/client, an optional peer
 *   mssql                       mssql (node-mssql), an optional peer
 *
 * Rows come back from every driver as untyped values, so everything read
 * from a catalog goes through a checked accessor rather than a cast: a driver
 * that hands back a shape nobody expected fails loudly instead of comparing
 * `undefined` against the schema.
 */
import { Database } from "bun:sqlite";
import process from "node:process";
import { SQL } from "bun";
import type { Dialect } from "./dbProject";
import { statementsIn, type ContractMigrationFile } from "./migrationPhases";

export type Row = Record<string, unknown>;

/** `schema.table` → column → NOT NULL in the database. */
export type LiveColumns = Map<string, Map<string, boolean>>;

export type LiveCatalog = {
  columns: LiveColumns;
  /** Where an unqualified table lives: `public`, the current MySQL
   *  database, the login's default SQL Server schema, SQLite's `main`. */
  defaultSchema: string;
};

const asRows = (value: unknown): Row[] => {
  if (!Array.isArray(value))
    throw new Error("the database driver returned something other than rows");

  return value.map((row: unknown) => {
    if (typeof row !== "object" || row === null)
      throw new Error("the database driver returned a row that is not a row");

    return Object.fromEntries(Object.entries(row));
  });
};

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  throw new Error(
    `catalog row has no text column "${key}" (got ${JSON.stringify(Object.keys(row))})`,
  );
};

const integer = (row: Row, key: string): number => {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return Number(value);
  throw new Error(`catalog row has no integer column "${key}"`);
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

/** Ledger and lock-table names are interpolated as identifiers, so they are
 *  held to a shape every engine accepts unquoted-safe. */
export const assertIdentifier = (name: string, flag: string): string => {
  if (!IDENTIFIER.test(name))
    throw new Error(
      `--${flag} "${name}" must be a plain identifier (letters, digits, underscore; at most 63)`,
    );

  return name;
};

const tableKey = (schema: string, table: string) => `${schema}.${table}`;

const addColumn = (
  live: LiveColumns,
  schema: string,
  table: string,
  column: string,
  notNull: boolean,
) => {
  const key = tableKey(schema, table);
  const columns = live.get(key) ?? new Map<string, boolean>();
  columns.set(column, notNull);
  live.set(key, columns);
};

// ---------------------------------------------------------------------------
// Connection strings
// ---------------------------------------------------------------------------

type Family = "mssql" | "mysql" | "postgres" | "sqlite";

export const familyOf = (dialect: Dialect): Family => {
  switch (dialect) {
    case "postgresql":
    case "cockroach":
      return "postgres";
    case "mysql":
    case "mariadb":
    case "singlestore":
      return "mysql";
    case "sqlite":
    case "turso":
      return "sqlite";
    case "mssql":
      return "mssql";
  }
};

const SCHEMES: Record<Family, string[]> = {
  mssql: ["mssql", "sqlserver"],
  mysql: ["mysql", "mariadb", "singlestore"],
  postgres: ["postgres", "postgresql"],
  sqlite: ["file", "sqlite", "libsql", "http", "https", "ws", "wss"],
};

const schemeOf = (url: string) =>
  /^([a-z][a-z0-9+.-]*):/iu.exec(url)?.[1]?.toLowerCase();

/** A URL for one engine handed to another fails with a driver error at best
 *  and connects to the wrong thing at worst; say so up front. */
const assertUrlFits = (dialect: Dialect, url: string) => {
  const scheme = schemeOf(url);
  const family = familyOf(dialect);
  // Bare paths (SQLite) and ADO strings (SQL Server) have no scheme.
  if (scheme === undefined && (family === "sqlite" || family === "mssql"))
    return;
  if (scheme !== undefined && SCHEMES[family].includes(scheme)) return;
  throw new Error(
    `the connection URL (${scheme ?? "no scheme"}://) does not fit the project's ${dialect} dialect`,
  );
};

const isRemoteLibsql = (url: string) =>
  ["libsql", "http", "https", "ws", "wss"].includes(schemeOf(url) ?? "");

/** `file:./app.db`, `sqlite:///abs.db`, `file:///abs.db`, or a bare path. */
export const sqlitePath = (url: string): string => {
  const withoutQuery = url.replace(/\?.*$/u, "");
  const match = /^(?:file|sqlite):(?:\/\/)?(.*)$/iu.exec(withoutQuery);
  const path = match?.[1] ?? withoutQuery;
  if (path === "" || path === ":memory:")
    throw new Error(
      "an in-memory SQLite database has no schema to verify or migrate",
    );

  return path;
};

const bunSql = (dialect: Dialect, url: string): SQL => {
  const family = familyOf(dialect);
  if (family === "postgres") return new SQL(url, { adapter: "postgres" });
  // Bun has no singlestore:// scheme; the wire protocol is MySQL's.
  const normalized = url.replace(/^singlestore:/iu, "mysql:");

  return new SQL(normalized, {
    adapter: dialect === "mariadb" ? "mariadb" : "mysql",
  });
};

/** Prisma writes SQL Server as `sqlserver://host:port;key=value;...`; the
 *  mssql driver reads ADO strings. */
export const mssqlConnectionString = (url: string): string => {
  const match = /^sqlserver:\/\/([^;]*)(.*)$/iu.exec(url);
  if (match === null) return url;
  const [, hostPort = "", rest = ""] = match;
  const [host, port] = hostPort.split(":");
  const pairs = rest
    .split(";")
    .filter((pair) => pair.includes("="))
    .map((pair) => {
      const [key = "", ...value] = pair.split("=");
      const renamed: Record<string, string> = {
        user: "User Id",
        username: "User Id",
      };

      return `${renamed[key.trim().toLowerCase()] ?? key.trim()}=${value.join("=")}`;
    });

  return [
    `Server=${host ?? ""}${port === undefined ? "" : `,${port}`}`,
    ...pairs,
  ].join(";");
};

const openMssql = async (url: string) => {
  const { default: mssql } = await import("mssql").catch(() => {
    throw new Error(
      "SQL Server needs the `mssql` package: add it to the project (bun add mssql)",
    );
  });
  const pool = await new mssql.ConnectionPool(
    mssqlConnectionString(url),
  ).connect();

  return { mssql, pool };
};

const openLibsql = async (url: string) => {
  const { createClient } = await import("@libsql/client").catch(() => {
    throw new Error(
      "a remote Turso/libSQL database needs the `@libsql/client` package: add it to the project (bun add @libsql/client)",
    );
  });

  return createClient({
    authToken: process.env.DATABASE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN,
    url,
  });
};

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

const catalogFromInformationSchema = (
  rows: Row[],
  defaultSchema: string,
): LiveCatalog => {
  const columns: LiveColumns = new Map();
  for (const row of rows)
    addColumn(
      columns,
      text(row, "table_schema"),
      text(row, "table_name"),
      text(row, "column_name"),
      text(row, "is_nullable") === "NO",
    );

  return { columns, defaultSchema };
};

// Upper-case catalog names: SQL Server under a case-sensitive collation only
// knows them that way, and PostgreSQL folds them back down.
const INFORMATION_SCHEMA_COLUMNS = `
  SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name,
         COLUMN_NAME AS column_name, IS_NULLABLE AS is_nullable
  FROM INFORMATION_SCHEMA.COLUMNS`;

const SQLITE_COLUMNS = `
  SELECT m.name AS table_name, p.name AS column_name, p."notnull" AS not_null,
         p.pk AS pk, p.type AS type
  FROM sqlite_master m JOIN pragma_table_info(m.name) p
  WHERE m.type IN ('table', 'view')`;

const catalogFromSqlite = (rows: Row[]): LiveCatalog => {
  const primaryKeyWidth = new Map<string, number>();
  for (const row of rows)
    if (integer(row, "pk") > 0) {
      const table = text(row, "table_name");
      primaryKeyWidth.set(table, (primaryKeyWidth.get(table) ?? 0) + 1);
    }
  const columns: LiveColumns = new Map();
  for (const row of rows) {
    const table = text(row, "table_name");
    // SQLite lets a PRIMARY KEY column hold NULL unless it is declared NOT
    // NULL — except a lone INTEGER PRIMARY KEY, which is the rowid.
    const rowid =
      integer(row, "pk") > 0 &&
      primaryKeyWidth.get(table) === 1 &&
      text(row, "type").toUpperCase() === "INTEGER";
    addColumn(
      columns,
      "main",
      table,
      text(row, "column_name"),
      integer(row, "not_null") === 1 || rowid,
    );
  }

  return { columns, defaultSchema: "main" };
};

export const liveCatalog = async (
  dialect: Dialect,
  url: string,
): Promise<LiveCatalog> => {
  assertUrlFits(dialect, url);
  const family = familyOf(dialect);

  if (family === "sqlite") {
    if (isRemoteLibsql(url)) {
      const client = await openLibsql(url);
      try {
        const result = await client.execute(SQLITE_COLUMNS);

        return catalogFromSqlite(
          result.rows.map((row) =>
            Object.fromEntries(
              result.columns.map((name, index) => [name, row[index]]),
            ),
          ),
        );
      } finally {
        client.close();
      }
    }
    const db = new Database(sqlitePath(url), { readonly: true });
    try {
      return catalogFromSqlite(asRows(db.query(SQLITE_COLUMNS).all()));
    } finally {
      db.close();
    }
  }

  if (family === "mssql") {
    const { pool } = await openMssql(url);
    try {
      const [columns, current] = await Promise.all([
        pool.request().query(INFORMATION_SCHEMA_COLUMNS),
        pool.request().query("SELECT SCHEMA_NAME() AS default_schema"),
      ]);

      return catalogFromInformationSchema(
        asRows(columns.recordset),
        text(asRows(current.recordset)[0] ?? {}, "default_schema"),
      );
    } finally {
      await pool.close();
    }
  }

  const sql = bunSql(dialect, url);
  try {
    const current =
      family === "postgres"
        ? "SELECT current_schema() AS default_schema"
        : "SELECT DATABASE() AS default_schema";
    const [columns, schema] = await Promise.all([
      sql.unsafe(INFORMATION_SCHEMA_COLUMNS),
      sql.unsafe(current),
    ]);

    return catalogFromInformationSchema(
      asRows(columns),
      text(asRows(schema)[0] ?? {}, "default_schema"),
    );
  } finally {
    await sql.close();
  }
};

// ---------------------------------------------------------------------------
// Contract migrations
// ---------------------------------------------------------------------------

export type ContractRun = {
  ledger: string;
  lock: string;
  migrations: ContractMigrationFile[];
  onApplied: (id: string) => void;
};

const LOCK_TIMEOUT_SECONDS = 600;

/**
 * PostgreSQL: one transaction per file holding a transaction-scoped advisory
 * lock. DDL is transactional, so the file and its ledger row commit together.
 *
 * CockroachDB accepts `pg_advisory_xact_lock` but does not lock on it, and a
 * row lock taken inside a transaction that then runs DDL is released when the
 * DDL executes (measured: a second deploy acquires it mid-file). So the lock
 * lives in its own transaction on its own connection — a write intent on a
 * lock-table row, held for the whole run — and each file runs in a separate
 * transaction that starts, and so reads the ledger, only after the lock is
 * held.
 */
const applyPostgres = async (
  dialect: Dialect,
  url: string,
  run: ContractRun,
): Promise<string[]> => {
  const { ledger, lock } = run;
  const lockTable = `${ledger}_lock`;
  const cockroach = dialect === "cockroach";
  const sql = bunSql(dialect, url);
  const applied: string[] = [];
  const createLedger = `
    CREATE TABLE IF NOT EXISTS "${ledger}" (
      "id" text PRIMARY KEY NOT NULL,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )`;
  const applyEach = async () => {
    for (const migration of run.migrations) {
      const statements = statementsIn(migration.sql);
      const didApply = await sql.begin(async (tx) => {
        if (!cockroach) {
          await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
          await tx.unsafe(createLedger);
        }
        // Read under the lock: a deploy that waited on it may find the file
        // already applied by the one that held it.
        const seen = asRows(
          await tx.unsafe(`SELECT 1 FROM "${ledger}" WHERE "id" = $1`, [
            migration.id,
          ]),
        );
        if (seen.length > 0) return false;
        for (const statement of statements) await tx.unsafe(statement);
        await tx.unsafe(`INSERT INTO "${ledger}" ("id") VALUES ($1)`, [
          migration.id,
        ]);

        return true;
      });
      if (didApply) {
        applied.push(migration.id);
        run.onApplied(migration.id);
      }
    }
  };
  try {
    if (!cockroach) await applyEach();
    else {
      await sql.unsafe(createLedger);
      await sql.unsafe(
        `CREATE TABLE IF NOT EXISTS "${lockTable}" ("name" text PRIMARY KEY NOT NULL)`,
      );
      await sql.unsafe(
        `INSERT INTO "${lockTable}" ("name") VALUES ($1) ON CONFLICT DO NOTHING`,
        [lock],
      );
      await sql.begin(async (lockTx) => {
        await lockTx.unsafe(
          `UPDATE "${lockTable}" SET "name" = "name" WHERE "name" = $1`,
          [lock],
        );
        await applyEach();
      });
    }
  } finally {
    await sql.close();
  }

  return applied;
};

/**
 * MySQL and MariaDB: a named session lock (`GET_LOCK`) on one reserved
 * connection for the whole run, and each file in a transaction with its
 * ledger row. MySQL commits implicitly around DDL, though, so only a file's
 * DML is atomic with its ledger row: a crash after a DDL statement leaves the
 * file partly applied and unrecorded, and the next run retries it — write
 * contract DDL to be re-runnable (IF EXISTS). The lock still guarantees two
 * deploys never run a file at once.
 */
const applyMySql = async (
  dialect: Dialect,
  url: string,
  run: ContractRun,
): Promise<string[]> => {
  const { ledger, lock } = run;
  if (lock.length > 64)
    throw new Error(`--lock must be at most 64 characters on ${dialect}`);
  const sql = bunSql(dialect, url);
  const applied: string[] = [];
  try {
    const conn = await sql.reserve();
    try {
      const [got] = asRows(
        await conn.unsafe("SELECT GET_LOCK(?, ?) AS acquired", [
          lock,
          LOCK_TIMEOUT_SECONDS,
        ]),
      );
      if (got === undefined || integer(got, "acquired") !== 1)
        throw new Error(
          `could not take the "${lock}" lock within ${LOCK_TIMEOUT_SECONDS}s — another contract-migrate is running`,
        );
      try {
        await conn.unsafe(`
          CREATE TABLE IF NOT EXISTS \`${ledger}\` (
            \`id\` varchar(255) NOT NULL PRIMARY KEY,
            \`applied_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
          )`);
        for (const migration of run.migrations) {
          const seen = asRows(
            await conn.unsafe(`SELECT 1 FROM \`${ledger}\` WHERE \`id\` = ?`, [
              migration.id,
            ]),
          );
          if (seen.length > 0) continue;
          const statements = statementsIn(migration.sql);
          // DML rolls back with the file; DDL commits where it stands.
          await conn.begin(async (tx) => {
            for (const statement of statements) await tx.unsafe(statement);
            await tx.unsafe(`INSERT INTO \`${ledger}\` (\`id\`) VALUES (?)`, [
              migration.id,
            ]);
          });
          applied.push(migration.id);
          run.onApplied(migration.id);
        }
      } finally {
        await conn.unsafe("SELECT RELEASE_LOCK(?)", [lock]);
      }
    } finally {
      conn.release();
    }
  } finally {
    await sql.close();
  }

  return applied;
};

/**
 * SQL Server: one transaction per file holding a transaction-owned
 * `sp_getapplock`. DDL is transactional, so the file and its ledger row
 * commit together.
 */
const applyMssql = async (url: string, run: ContractRun): Promise<string[]> => {
  const { ledger, lock } = run;
  const { mssql, pool } = await openMssql(url);
  const applied: string[] = [];
  try {
    for (const migration of run.migrations) {
      const tx = new mssql.Transaction(pool);
      await tx.begin();
      let didApply = false;
      try {
        const got = await new mssql.Request(tx)
          .input("resource", mssql.NVarChar(255), lock)
          .input("timeout", mssql.Int, LOCK_TIMEOUT_SECONDS * 1000).query(`
            DECLARE @result int;
            EXEC @result = sp_getapplock @Resource = @resource,
              @LockMode = 'Exclusive', @LockOwner = 'Transaction',
              @LockTimeout = @timeout;
            SELECT @result AS result;`);
        const [result] = asRows(got.recordset);
        if (result === undefined || integer(result, "result") < 0)
          throw new Error(
            `could not take the "${lock}" lock within ${LOCK_TIMEOUT_SECONDS}s — another contract-migrate is running`,
          );
        await new mssql.Request(tx).batch(`
          IF OBJECT_ID(N'${ledger}', N'U') IS NULL
            CREATE TABLE [${ledger}] (
              [id] nvarchar(255) NOT NULL PRIMARY KEY,
              [applied_at] datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
            )`);
        const seen = await new mssql.Request(tx)
          .input("id", mssql.NVarChar(255), migration.id)
          .query(`SELECT 1 AS seen FROM [${ledger}] WHERE [id] = @id`);
        if (asRows(seen.recordset).length === 0) {
          for (const statement of statementsIn(migration.sql))
            await new mssql.Request(tx).batch(statement);
          await new mssql.Request(tx)
            .input("id", mssql.NVarChar(255), migration.id)
            .query(`INSERT INTO [${ledger}] ([id]) VALUES (@id)`);
          didApply = true;
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
      if (didApply) {
        applied.push(migration.id);
        run.onApplied(migration.id);
      }
    }
  } finally {
    await pool.close();
  }

  return applied;
};

const SQLITE_LEDGER = (ledger: string) => `
  CREATE TABLE IF NOT EXISTS "${ledger}" (
    "id" text PRIMARY KEY NOT NULL,
    "applied_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`;

/**
 * SQLite: one `BEGIN IMMEDIATE` transaction per file. IMMEDIATE takes the
 * database's write lock up front, which is the lock; DDL is transactional,
 * so the file and its ledger row commit together.
 */
const applySqliteFile = (path: string, run: ContractRun): string[] => {
  const { ledger } = run;
  const db = new Database(path, { readwrite: true });
  const applied: string[] = [];
  try {
    db.run(`PRAGMA busy_timeout = ${LOCK_TIMEOUT_SECONDS * 1000}`);
    for (const migration of run.migrations) {
      const statements = statementsIn(migration.sql);
      const apply = db.transaction(() => {
        db.run(SQLITE_LEDGER(ledger));
        if (
          db.query(`SELECT 1 FROM "${ledger}" WHERE "id" = ?`).get(migration.id)
        )
          return false;
        for (const statement of statements) db.run(statement);
        db.run(`INSERT INTO "${ledger}" ("id") VALUES (?)`, [migration.id]);

        return true;
      });
      if (apply.immediate()) {
        applied.push(migration.id);
        run.onApplied(migration.id);
      }
    }
  } finally {
    db.close();
  }

  return applied;
};

/** Remote libSQL: a `write` transaction is libSQL's BEGIN IMMEDIATE. */
const applyLibsql = async (
  url: string,
  run: ContractRun,
): Promise<string[]> => {
  const { ledger } = run;
  const client = await openLibsql(url);
  const applied: string[] = [];
  try {
    for (const migration of run.migrations) {
      const tx = await client.transaction("write");
      let didApply = false;
      try {
        await tx.execute(SQLITE_LEDGER(ledger));
        const seen = await tx.execute({
          args: [migration.id],
          sql: `SELECT 1 FROM "${ledger}" WHERE "id" = ?`,
        });
        if (seen.rows.length === 0) {
          for (const statement of statementsIn(migration.sql))
            await tx.execute(statement);
          await tx.execute({
            args: [migration.id],
            sql: `INSERT INTO "${ledger}" ("id") VALUES (?)`,
          });
          didApply = true;
        }
        await tx.commit();
      } finally {
        tx.close();
      }
      if (didApply) {
        applied.push(migration.id);
        run.onApplied(migration.id);
      }
    }
  } finally {
    client.close();
  }

  return applied;
};

export const applyContractMigrations = async (
  dialect: Dialect,
  url: string,
  run: ContractRun,
): Promise<string[]> => {
  assertUrlFits(dialect, url);
  switch (dialect) {
    case "postgresql":
    case "cockroach":
      return applyPostgres(dialect, url, run);
    case "mysql":
    case "mariadb":
      return applyMySql(dialect, url, run);
    case "mssql":
      return applyMssql(url, run);
    case "sqlite":
    case "turso":
      return isRemoteLibsql(url)
        ? applyLibsql(url, run)
        : applySqliteFile(sqlitePath(url), run);
    case "singlestore":
      throw new Error(
        "contract-migrate does not support SingleStore: it has no named session lock (GET_LOCK) and its DDL is not transactional, so two deploys racing could both apply a contract file. Apply contract.sql through your own serialized step",
      );
  }
};
