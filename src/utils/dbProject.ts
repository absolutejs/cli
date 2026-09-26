/**
 * Which ORM a project uses and which database engine it targets.
 *
 * Every `db` verb that touches SQL has to know the engine: the introspection
 * catalog, the lock primitive and the ledger's column types all differ. The
 * answer comes from the project's own configuration — `drizzle.config.*`'s
 * `dialect`, or the Prisma schema's datasource `provider` — and only falls
 * back to the connection URL's scheme when neither exists. When none of those
 * say, the verb refuses; it never assumes PostgreSQL.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

export const DIALECTS = [
  "postgresql",
  "cockroach",
  "mysql",
  "mariadb",
  "singlestore",
  "sqlite",
  "turso",
  "mssql",
] as const;

export type Dialect = (typeof DIALECTS)[number];

export type Flags = Record<string, string | boolean>;

export type DrizzleProject = {
  configPath: string | undefined;
  dialect: Dialect;
  /** `out` from the Drizzle config: where its migrations live. */
  migrationsDir: string | undefined;
  orm: "drizzle";
  /** `schema` from the Drizzle config, when it names one module. */
  schemaModule: string | undefined;
};

export type PrismaProject = {
  dialect: Dialect;
  migrationsDir: string;
  orm: "prisma";
  root: string;
  schemaPath: string;
};

export type Project = DrizzleProject | PrismaProject;

const DIALECT_ALIASES: Record<string, Dialect> = {
  cockroachdb: "cockroach",
  libsql: "turso",
  pg: "postgresql",
  postgres: "postgresql",
  sqlserver: "mssql",
};

/** Engines an ORM can target that this CLI does not verify, and why. */
const REFUSED: Record<string, string> = {
  gel: "Gel is not supported: drizzle-kit only pulls a Gel schema (there is no generate), so there are no migrations for these verbs to gate",
  mongodb:
    "MongoDB is not supported: these verbs gate SQL migrations and a SQL catalog, and a Prisma MongoDB project has neither",
};

export const stringFlag = (flags: Flags, name: string): string | undefined => {
  const value = flags[name];
  if (typeof value === "boolean") throw new Error(`--${name} requires a value`);

  return value;
};

const isDialect = (value: string): value is Dialect =>
  DIALECTS.some((dialect) => dialect === value);

/** A dialect name from a flag, a config file or a provider, or an error that
 *  says which source named something unusable. */
export const parseDialect = (name: string, source: string): Dialect => {
  const normalized = name.trim().toLowerCase();
  const refused = REFUSED[normalized];
  if (refused !== undefined) throw new Error(`${refused} (from ${source})`);
  const dialect = DIALECT_ALIASES[normalized] ?? normalized;
  if (isDialect(dialect)) return dialect;

  throw new Error(
    `unknown database dialect "${name}" (from ${source}). supported: ${DIALECTS.join(", ")}`,
  );
};

/** What the connection URL's scheme says. Ambiguous on its own for
 *  CockroachDB, which speaks `postgresql://`, so only a fallback. */
export const dialectFromUrl = (url: string): Dialect | undefined => {
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(url)?.[1]?.toLowerCase();
  switch (scheme) {
    case "postgres":
    case "postgresql":
      return "postgresql";
    case "mysql":
      return "mysql";
    case "mariadb":
      return "mariadb";
    case "singlestore":
      return "singlestore";
    case "sqlserver":
    case "mssql":
      return "mssql";
    case "libsql":
      return "turso";
    case "file":
    case "sqlite":
      return "sqlite";
    default:
      return undefined;
  }
};

const DRIZZLE_CONFIG_NAMES = [
  "drizzle.config.ts",
  "drizzle.config.mts",
  "drizzle.config.cts",
  "drizzle.config.js",
  "drizzle.config.mjs",
  "drizzle.config.cjs",
  "drizzle.config.json",
];

type DrizzleConfigFields = {
  dialect: string | undefined;
  out: string | undefined;
  schema: string | undefined;
};

const stringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const field: unknown = Reflect.get(value, key);

  return typeof field === "string" ? field : undefined;
};

const fieldsOf = (config: unknown): DrizzleConfigFields => ({
  dialect: stringField(config, "dialect"),
  out: stringField(config, "out"),
  schema: stringField(config, "schema"),
});

/** The fields a config states literally, for a config that cannot be
 *  imported here (drizzle-kit not resolvable, a throwing top level). */
const staticFields = (source: string): DrizzleConfigFields => {
  const literal = (key: string) =>
    new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`, "u").exec(
      source,
    )?.[1];

  return {
    dialect: literal("dialect"),
    out: literal("out"),
    schema: literal("schema"),
  };
};

const readDrizzleConfig = async (
  path: string,
): Promise<DrizzleConfigFields> => {
  const source = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return fieldsOf(JSON.parse(source));
  try {
    const loaded: unknown = await import(path);
    const fields = fieldsOf(
      typeof loaded === "object" && loaded !== null
        ? Reflect.get(loaded, "default")
        : undefined,
    );
    if (fields.dialect !== undefined) return fields;
  } catch {
    // Fall through to what the file states literally.
  }

  return staticFields(source);
};

const findDrizzleConfig = (flags: Flags): string | undefined => {
  const explicit = stringFlag(flags, "config");
  if (explicit !== undefined) {
    const path = resolve(explicit);
    if (!existsSync(path))
      throw new Error(`--config ${explicit}: no such file`);

    return path;
  }

  return DRIZZLE_CONFIG_NAMES.map((name) => resolve(name)).find((path) =>
    existsSync(path),
  );
};

const PRISMA_SCHEMA_CANDIDATES = [
  "prisma/schema.prisma",
  "schema.prisma",
  "prisma/schema",
];

const findPrismaSchema = (flags: Flags): string | undefined => {
  const explicit = stringFlag(flags, "prisma-schema");
  if (explicit !== undefined) {
    const path = resolve(explicit);
    if (!existsSync(path))
      throw new Error(`--prisma-schema ${explicit}: no such file`);

    return path;
  }

  return PRISMA_SCHEMA_CANDIDATES.map((name) => resolve(name)).find((path) =>
    existsSync(path),
  );
};

/** The schema text, whether a single file or a multi-file schema folder. */
const prismaSources = (schemaPath: string): string[] =>
  statSync(schemaPath).isDirectory()
    ? readdirSync(schemaPath, { recursive: true })
        .map(String)
        .filter((entry) => entry.endsWith(".prisma"))
        .map((entry) => readFileSync(join(schemaPath, entry), "utf8"))
    : [readFileSync(schemaPath, "utf8")];

export const prismaProvider = (schemaPath: string): string => {
  for (const source of prismaSources(schemaPath)) {
    const provider =
      /datasource\s+\w+\s*\{[^}]*?\bprovider\s*=\s*"([^"]+)"/u.exec(
        source,
      )?.[1];
    if (provider !== undefined) return provider;
  }
  throw new Error(
    `${schemaPath} has no datasource provider — cannot tell which database it targets`,
  );
};

const DEFAULT_DRIZZLE_OUT = "drizzle";

/**
 * Resolve the project. `url` is only consulted when nothing in the project
 * names the engine.
 */
export const detectProject = async (
  flags: Flags,
  url: string | undefined,
): Promise<Project> => {
  const orm = stringFlag(flags, "orm");
  if (orm !== undefined && orm !== "drizzle" && orm !== "prisma")
    throw new Error(`--orm must be drizzle or prisma, not "${orm}"`);
  const dialectFlag = stringFlag(flags, "dialect");
  const flagged =
    dialectFlag === undefined
      ? undefined
      : parseDialect(dialectFlag, "--dialect");

  const configPath = orm === "prisma" ? undefined : findDrizzleConfig(flags);
  if (configPath !== undefined) {
    const fields = await readDrizzleConfig(configPath);
    const dialect =
      flagged ??
      (fields.dialect === undefined
        ? undefined
        : parseDialect(fields.dialect, configPath));
    if (dialect === undefined)
      throw new Error(
        `${configPath} does not state a dialect — pass --dialect <${DIALECTS.join("|")}>`,
      );

    return {
      configPath,
      dialect: refineMySqlFamily(dialect, url),
      migrationsDir:
        fields.out === undefined
          ? undefined
          : resolve(dirname(configPath), fields.out),
      orm: "drizzle",
      schemaModule:
        fields.schema === undefined || /[*?{[]/u.test(fields.schema)
          ? undefined
          : resolve(dirname(configPath), fields.schema),
    };
  }

  const schemaPath = orm === "drizzle" ? undefined : findPrismaSchema(flags);
  if (schemaPath !== undefined) {
    // Prisma keeps migrations beside the schema file — for a schema folder,
    // inside it or beside it depending on the version, so take whichever is
    // there.
    const inside = join(schemaPath, "migrations");
    const migrationsDir =
      statSync(schemaPath).isDirectory() && existsSync(inside)
        ? inside
        : join(dirname(schemaPath), "migrations");

    return {
      dialect:
        flagged ??
        refineMySqlFamily(
          parseDialect(prismaProvider(schemaPath), schemaPath),
          url,
        ),
      migrationsDir,
      orm: "prisma",
      root: process.cwd(),
      schemaPath,
    };
  }
  if (orm === "prisma")
    throw new Error(
      "--orm prisma but no Prisma schema found (looked for prisma/schema.prisma, schema.prisma, prisma/schema/; pass --prisma-schema <path>)",
    );

  const fromUrl = url === undefined ? undefined : dialectFromUrl(url);
  const dialect = flagged ?? fromUrl;
  if (dialect === undefined)
    throw new Error(
      `cannot tell which database this project targets: no drizzle.config.* or Prisma schema here, and ${url === undefined ? "no connection URL" : "the connection URL's scheme is not one it recognizes"}. pass --dialect <${DIALECTS.join("|")}>`,
    );

  return {
    configPath: undefined,
    dialect,
    migrationsDir: undefined,
    orm: "drizzle",
    schemaModule: undefined,
  };
};

/** Drizzle and Prisma both call MariaDB "mysql"; a `mariadb://` URL is the
 *  only place the difference shows. */
const refineMySqlFamily = (dialect: Dialect, url: string | undefined) =>
  dialect === "mysql" && url !== undefined && dialectFromUrl(url) === "mariadb"
    ? "mariadb"
    : dialect;

export const defaultMigrationsDir = (project: Project | undefined): string =>
  project?.migrationsDir ?? resolve(DEFAULT_DRIZZLE_OUT);
