CREATE TABLE "issue_comment_request_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"descriptor" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"receipt" jsonb,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_comment_request_effects_status_check" CHECK ("issue_comment_request_effects"."status" in ('pending', 'claimed', 'dispatching', 'delivered', 'blocked', 'reconciliation_required', 'cancelled')),
	CONSTRAINT "issue_comment_request_effects_kind_check" CHECK ("issue_comment_request_effects"."kind" in ('workspace_reopen', 'interrupt', 'references', 'steer', 'wake', 'watchdog', 'activity_publication', 'confirmation_expiry', 'external_objects', 'terminal_interaction_expiry', 'source_recovery_revalidation', 'cancel_native_question_run', 'workspace_cleanup', 'sandbox_cleanup', 'scheduled_retry_cancel'))
);
--> statement-breakpoint
CREATE TABLE "issue_comment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"author_user_id" text NOT NULL,
	"responsible_user_id" text,
	"source_trust" jsonb,
	"client_request_id" text NOT NULL,
	"canonical_envelope" jsonb NOT NULL,
	"accepted_comment_updated_at" timestamp with time zone NOT NULL,
	"content_invalidated_at" timestamp with time zone,
	"payload_sha256" text NOT NULL,
	"protocol_version" integer DEFAULT 1 NOT NULL,
	"comment_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_comment_requests_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "issue_comment_requests_status_check" CHECK ("issue_comment_requests"."status" in ('pending', 'delivered', 'blocked', 'reconciliation_required', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "minimum_board_comment_request_protocol_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_comment_request_effects" ADD CONSTRAINT "issue_comment_request_effects_owner_fk" FOREIGN KEY ("company_id","request_id") REFERENCES "public"."issue_comment_requests"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_requests" ADD CONSTRAINT "issue_comment_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_requests" ADD CONSTRAINT "issue_comment_requests_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_requests" ADD CONSTRAINT "issue_comment_requests_comment_company_fk" FOREIGN KEY ("company_id","comment_id") REFERENCES "public"."issue_comments"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_request_effects_ordinal_uq" ON "issue_comment_request_effects" USING btree ("request_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_request_effects_identity_uq" ON "issue_comment_request_effects" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "issue_comment_request_effects_pending_idx" ON "issue_comment_request_effects" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "issue_comment_request_effects_owner_idx" ON "issue_comment_request_effects" USING btree ("company_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_requests_identity_uq" ON "issue_comment_requests" USING btree ("company_id","issue_id","author_user_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_requests_comment_uq" ON "issue_comment_requests" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "issue_comment_requests_issue_idx" ON "issue_comment_requests" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_comment_requests_pending_idx" ON "issue_comment_requests" USING btree ("status","created_at");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: This new request namespace requires permanent deduplication. Production must prebuild the identical index concurrently and verify its definition before the guarded migration; fresh test databases build it transactionally.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_issue_comment_request_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'issue-comment-request:%';--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'agent_wakeup_requests_issue_comment_request_uq'
      AND i.indrelid = 'public.agent_wakeup_requests'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnkeyatts = 2 AND i.indnatts = 2
      AND pg_get_indexdef(i.indexrelid, 1, true) = 'company_id'
      AND pg_get_indexdef(i.indexrelid, 2, true) = 'idempotency_key'
      AND pg_get_expr(i.indpred, i.indrelid) = '(idempotency_key ~~ ''issue-comment-request:%''::text)'
  ) THEN
    RAISE EXCEPTION 'Permanent Board comment wake identity index is missing, invalid, or incompatible';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_board_comment_protocol_nonnegative" CHECK ("instance_settings"."minimum_board_comment_request_protocol_version" >= 0);
--> statement-breakpoint
INSERT INTO "instance_settings" ("singleton_key") VALUES ('default') ON CONFLICT ("singleton_key") DO NOTHING;
