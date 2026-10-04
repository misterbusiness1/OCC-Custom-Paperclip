import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";

/** Immutable accepted Board intent. Content remains exclusively in the governed comment. */
export const issueCommentRequests = pgTable("issue_comment_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull(),
  authorUserId: text("author_user_id").notNull(),
  responsibleUserId: text("responsible_user_id"),
  sourceTrust: jsonb("source_trust").$type<Record<string, unknown> | null>(),
  clientRequestId: text("client_request_id").notNull(),
  canonicalEnvelope: jsonb("canonical_envelope").$type<Record<string, unknown>>().notNull(),
  acceptedCommentUpdatedAt: timestamp("accepted_comment_updated_at", { withTimezone: true }).notNull(),
  contentInvalidatedAt: timestamp("content_invalidated_at", { withTimezone: true }),
  payloadSha256: text("payload_sha256").notNull(),
  protocolVersion: integer("protocol_version").notNull().default(1),
  commentId: uuid("comment_id").notNull(),
  status: text("status").notNull().default("pending"),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  requestUq: uniqueIndex("issue_comment_requests_identity_uq").on(table.companyId, table.issueId, table.authorUserId, table.clientRequestId),
  companyIdUq: unique("issue_comment_requests_company_id_uq").on(table.companyId, table.id),
  commentUq: uniqueIndex("issue_comment_requests_comment_uq").on(table.commentId),
  issueFk: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id], name: "issue_comment_requests_issue_company_fk" }).onDelete("cascade"),
  commentFk: foreignKey({ columns: [table.companyId, table.commentId], foreignColumns: [issueComments.companyId, issueComments.id], name: "issue_comment_requests_comment_company_fk" }).onDelete("cascade"),
  issueIdx: index("issue_comment_requests_issue_idx").on(table.companyId, table.issueId),
  pendingIdx: index("issue_comment_requests_pending_idx").on(table.status, table.createdAt),
  statusCheck: check("issue_comment_requests_status_check", sql`${table.status} in ('pending', 'delivered', 'blocked', 'reconciliation_required', 'cancelled')`),
}));

/** Recorded control-plane effects, never executable closures or caller-authored commands. */
export const issueCommentRequestEffects = pgTable("issue_comment_request_effects", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  requestId: uuid("request_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  kind: text("kind").notNull(),
  descriptor: jsonb("descriptor").$type<Record<string, unknown>>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("pending"),
  generation: integer("generation").notNull().default(0),
  attemptCount: integer("attempt_count").notNull().default(0),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  receipt: jsonb("receipt").$type<Record<string, unknown>>(),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  requestFk: foreignKey({ columns: [table.companyId, table.requestId], foreignColumns: [issueCommentRequests.companyId, issueCommentRequests.id], name: "issue_comment_request_effects_owner_fk" }).onDelete("cascade"),
  ordinalUq: uniqueIndex("issue_comment_request_effects_ordinal_uq").on(table.requestId, table.ordinal),
  identityUq: uniqueIndex("issue_comment_request_effects_identity_uq").on(table.companyId, table.idempotencyKey),
  pendingIdx: index("issue_comment_request_effects_pending_idx").on(table.status, table.updatedAt),
  ownerIdx: index("issue_comment_request_effects_owner_idx").on(table.companyId, table.requestId),
  statusCheck: check("issue_comment_request_effects_status_check", sql`${table.status} in ('pending', 'claimed', 'dispatching', 'delivered', 'blocked', 'reconciliation_required', 'cancelled')`),
  kindCheck: check("issue_comment_request_effects_kind_check", sql`${table.kind} in ('workspace_reopen', 'interrupt', 'references', 'steer', 'wake', 'watchdog', 'activity_publication', 'confirmation_expiry', 'external_objects', 'terminal_interaction_expiry', 'source_recovery_revalidation', 'cancel_native_question_run', 'workspace_cleanup', 'sandbox_cleanup', 'scheduled_retry_cancel')`),
}));
