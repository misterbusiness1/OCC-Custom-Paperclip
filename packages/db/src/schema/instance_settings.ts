import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, integer, check } from "drizzle-orm/pg-core";
import { environments } from "./environments.js";

export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    minimumBoardCommentRequestProtocolVersion: integer("minimum_board_comment_request_protocol_version").notNull().default(0),
    singletonKey: text("singleton_key").notNull().default("default"),
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    general: jsonb("general").$type<Record<string, unknown>>().notNull().default({}),
    experimental: jsonb("experimental").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    minimumBoardCommentRequestProtocolCheck: check("instance_settings_board_comment_protocol_nonnegative", sql`${table.minimumBoardCommentRequestProtocolVersion} >= 0`),
    singletonKeyIdx: uniqueIndex("instance_settings_singleton_key_idx").on(table.singletonKey),
  }),
);
