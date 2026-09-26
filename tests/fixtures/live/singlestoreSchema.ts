import { int, singlestoreTable, varchar } from "drizzle-orm/singlestore-core";

export const users = singlestoreTable("users", {
  email: varchar("email", { length: 255 }).notNull(),
  id: int("id").primaryKey(),
  nickname: varchar("nickname", { length: 255 }),
});
