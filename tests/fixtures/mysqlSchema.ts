import { int, mysqlTable, text } from "drizzle-orm/mysql-core";

export const orders = mysqlTable("orders", {
  id: int("id").primaryKey(),
  note: text("note"),
});
