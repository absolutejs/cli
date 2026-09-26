/**
 * The Prisma side of `check-drift` and `verify-schema`.
 *
 * Prisma owns both questions for its own projects, so these delegate to the
 * project's installed Prisma CLI rather than re-deriving its schema:
 *
 *   check-drift    `prisma migrate diff --from-migrations … --to-schema…
 *                   --exit-code` — do the committed migrations produce the
 *                   schema? (Needs a shadow database; Prisma replays the
 *                   migrations into it.)
 *   verify-schema  `prisma migrate status` — has the live database applied
 *                   every migration the new build ships?
 *
 * The flags moved between majors: ≤6 takes `--to-schema-datamodel` and
 * `--shadow-database-url`; 7 takes `--to-schema` and reads the shadow
 * database from prisma.config.ts. Prisma 8 replaced migrations with contract
 * packages and ships its own gates (`prisma migration check`, `prisma db
 * verify`), so it is refused with a pointer to them.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import type { PrismaProject } from "./dbProject";

export const prismaMajor = (root: string): number => {
  let manifest: string;
  try {
    manifest = Bun.resolveSync("prisma/package.json", root);
  } catch {
    throw new Error(
      "this is a Prisma project but the `prisma` package is not installed — install it (bun add -d prisma) so its CLI can be run",
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  const version =
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, "version")
      : undefined;
  const major =
    typeof version === "string" ? Number.parseInt(version, 10) : Number.NaN;
  if (Number.isNaN(major))
    throw new Error(
      `cannot read the installed Prisma version from ${manifest}`,
    );

  return major;
};

const assertClassicPrisma = (major: number, verb: string) => {
  if (major >= 8)
    throw new Error(
      `${verb} does not support Prisma ${major}: it replaced migration folders with contract packages. Use its own gates — \`prisma migration check\` offline and \`prisma db verify --schema-only\` against the live database`,
    );
  if (major < 5)
    throw new Error(
      `${verb} needs Prisma 5 or newer (found ${major}): older migrate diff has no --exit-code`,
    );
};

export type PrismaResult = {
  output: string;
  status: number | null;
};

const runPrisma = (
  project: PrismaProject,
  args: string[],
  env: Record<string, string | undefined>,
): PrismaResult => {
  const result = spawnSync("bunx", ["prisma", ...args], {
    cwd: project.root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status,
  };
};

export type PrismaDrift =
  | { drift: false }
  | { drift: true; summary: string }
  | { error: string };

export const prismaCheckDrift = (
  project: PrismaProject,
  shadowUrl: string | undefined,
): PrismaDrift => {
  const major = prismaMajor(project.root);
  assertClassicPrisma(major, "check-drift");
  const args = ["migrate", "diff", "--from-migrations", project.migrationsDir];
  const env: Record<string, string | undefined> = {};
  if (major >= 7) {
    args.push("--to-schema", project.schemaPath);
    // Prisma 7 reads the shadow database from prisma.config.ts; a config
    // that reads it from the environment picks this up.
    if (shadowUrl !== undefined) env.SHADOW_DATABASE_URL = shadowUrl;
  } else {
    if (shadowUrl === undefined)
      throw new Error(
        "check-drift on Prisma ≤6 needs a shadow database to replay the migrations into: pass --shadow-url or set SHADOW_DATABASE_URL (a throwaway database; it is reset)",
      );
    args.push(
      "--to-schema-datamodel",
      project.schemaPath,
      "--shadow-database-url",
      shadowUrl,
    );
  }
  args.push("--exit-code");
  const result = runPrisma(project, args, env);
  if (result.status === 0) return { drift: false };
  if (result.status === 2) return { drift: true, summary: result.output };

  return { error: result.output };
};

export const prismaMigrateStatus = (
  project: PrismaProject,
  url: string,
): PrismaResult => {
  const major = prismaMajor(project.root);
  assertClassicPrisma(major, "verify-schema");
  const args = ["migrate", "status"];
  if (major < 7) args.push("--schema", project.schemaPath);

  return runPrisma(project, args, { DATABASE_URL: url });
};
