import process from "node:process";
import { defineConfig } from "prisma/config";

export default defineConfig({
  datasource: {
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
    url: process.env.DATABASE_URL ?? "",
  },
  migrations: { path: "prisma/migrations" },
  schema: "prisma/schema.prisma",
});
