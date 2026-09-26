import { cockroachTable, int4, text } from "drizzle-orm/cockroach-core";

export const users = cockroachTable("users", {
  email: text("email").notNull(),
  id: int4("id").primaryKey(),
  nickname: text("nickname"),
});
