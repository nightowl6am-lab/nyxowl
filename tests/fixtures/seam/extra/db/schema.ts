import { int, text } from "drizzle-orm/pg-core";
import { mysqlTable, pgTable, sqliteTable } from "drizzle-orm";

export const users = pgTable("users", {
  id: text("id"),
  display_name: text("display_name"),
});

export const auditLogs = mysqlTable("audit_logs", {
  id: int("id"),
});

export const settings = sqliteTable("settings", {
  key: text("key"),
});

// A bare reference must not be mistaken for a table definition.
export const marker = pgTable;
