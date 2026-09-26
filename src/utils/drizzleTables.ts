/**
 * Reading Drizzle table definitions for the dialect a project targets.
 *
 * Each dialect has its own table class and its own `getTableConfig`; a table
 * from one dialect's core is not readable by another's. So a schema module is
 * read with the cores its engine accepts, and any table none of them can read
 * is reported by name — never passed over as "not a table", which is how a
 * verification ends up checking nothing and calling that compatible.
 */
import type { Dialect } from "./dbProject";

export type TableShape = {
  columns: { name: string; notNull: boolean }[];
  name: string;
  /** Undefined for the engine's default schema (and always for SQLite). */
  schema: string | undefined;
};

type TableReader = {
  core: string;
  read: (value: unknown) => TableShape | undefined;
};

const shapeOf = (config: {
  columns: { name: string; notNull: boolean }[];
  name: string;
  schema?: string | undefined;
}): TableShape => ({
  columns: config.columns.map((column) => ({
    name: column.name,
    notNull: column.notNull,
  })),
  name: config.name,
  schema: config.schema,
});

const pgReader = async (): Promise<TableReader> => {
  const [{ is }, core] = await Promise.all([
    import("drizzle-orm"),
    import("drizzle-orm/pg-core"),
  ]);

  return {
    core: "pg-core",
    read: (value) =>
      is(value, core.PgTable) ? shapeOf(core.getTableConfig(value)) : undefined,
  };
};

const cockroachReader = async (): Promise<TableReader> => {
  const [{ is }, core] = await Promise.all([
    import("drizzle-orm"),
    import("drizzle-orm/cockroach-core"),
  ]);

  return {
    core: "cockroach-core",
    read: (value) =>
      is(value, core.CockroachTable)
        ? shapeOf(core.getTableConfig(value))
        : undefined,
  };
};

const mysqlReader = async (): Promise<TableReader> => {
  const [{ is }, core] = await Promise.all([
    import("drizzle-orm"),
    import("drizzle-orm/mysql-core"),
  ]);

  return {
    core: "mysql-core",
    read: (value) =>
      is(value, core.MySqlTable)
        ? shapeOf(core.getTableConfig(value))
        : undefined,
  };
};

const singlestoreReader = async (): Promise<TableReader> => {
  const [{ is }, core] = await Promise.all([
    import("drizzle-orm"),
    import("drizzle-orm/singlestore-core"),
  ]);

  return {
    core: "singlestore-core",
    read: (value) =>
      is(value, core.SingleStoreTable)
        ? shapeOf(core.getTableConfig(value))
        : undefined,
  };
};

const sqliteReader = async (): Promise<TableReader> => {
  const [{ is }, core] = await Promise.all([
    import("drizzle-orm"),
    import("drizzle-orm/sqlite-core"),
  ]);

  return {
    core: "sqlite-core",
    read: (value) =>
      is(value, core.SQLiteTable)
        ? shapeOf(core.getTableConfig(value))
        : undefined,
  };
};

const mssqlReader = async (): Promise<TableReader> => {
  const [{ is }, core] = await Promise.all([
    import("drizzle-orm"),
    import("drizzle-orm/mssql-core"),
  ]);

  return {
    core: "mssql-core",
    read: (value) =>
      is(value, core.MsSqlTable)
        ? shapeOf(core.getTableConfig(value))
        : undefined,
  };
};

/** The cores whose tables are valid against each engine. CockroachDB also
 *  accepts pg-core tables, which is how projects targeted it before Drizzle
 *  had a cockroach dialect. */
const readersFor = (dialect: Dialect): Promise<TableReader[]> => {
  switch (dialect) {
    case "postgresql":
      return Promise.all([pgReader()]);
    case "cockroach":
      return Promise.all([cockroachReader(), pgReader()]);
    case "mysql":
    case "mariadb":
      return Promise.all([mysqlReader()]);
    case "singlestore":
      return Promise.all([singlestoreReader()]);
    case "sqlite":
    case "turso":
      return Promise.all([sqliteReader()]);
    case "mssql":
      return Promise.all([mssqlReader()]);
  }
};

export type SchemaTables = {
  /** Exports that are Drizzle tables no reader for this dialect accepts. */
  unreadable: string[];
  tables: TableShape[];
};

/** Every Drizzle table among `exports`, read for `dialect`. */
export const readSchemaTables = async (
  dialect: Dialect,
  exports: [string, unknown][],
): Promise<SchemaTables & { cores: string[] }> => {
  const [{ isTable }, readers] = await Promise.all([
    import("drizzle-orm"),
    readersFor(dialect),
  ]);
  const tables: TableShape[] = [];
  const unreadable: string[] = [];
  for (const [name, value] of exports) {
    // Anything that is not a Drizzle table at all — a relations object, an
    // enum, a helper, a constant — is not the schema's tables.
    if (!isTable(value)) continue;
    const shape = readers
      .map((reader) => reader.read(value))
      .find((read) => read !== undefined);
    if (shape === undefined) unreadable.push(name);
    else tables.push(shape);
  }

  return { cores: readers.map((reader) => reader.core), tables, unreadable };
};
