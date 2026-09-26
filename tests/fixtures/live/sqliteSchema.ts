import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  email: text("email").notNull(),
  id: integer("id").primaryKey(),
  nickname: text("nickname"),
});
