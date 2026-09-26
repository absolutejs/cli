import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  email: varchar("email", { length: 255 }).notNull(),
  id: int("id").primaryKey(),
  nickname: varchar("nickname", { length: 255 }),
});
