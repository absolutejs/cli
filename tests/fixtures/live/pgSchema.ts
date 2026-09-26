import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  email: text("email").notNull(),
  id: integer("id").primaryKey(),
  nickname: text("nickname"),
});
