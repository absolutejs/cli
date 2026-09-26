-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "nickname" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

