import { int, mssqlTable, nvarchar } from "drizzle-orm/mssql-core";

export const users = mssqlTable("users", {
  email: nvarchar("email", { length: 255 }).notNull(),
  id: int("id").primaryKey(),
  nickname: nvarchar("nickname", { length: 255 }),
});
