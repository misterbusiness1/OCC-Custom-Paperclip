-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. Production rollouts prebuild this reverse-FK index concurrently before applying the migration.
CREATE INDEX IF NOT EXISTS "activity_log_agent_id_fk_idx" ON "activity_log" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_config_revisions_created_by_agent_id_fk_idx" ON "agent_config_revisions" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_task_sessions_agent_id_fk_idx" ON "agent_task_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secret_proposals_origin_issue_id_fk_idx" ON "company_secret_proposals" USING btree ("origin_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_test_runs_issue_id_fk_idx" ON "company_skill_test_runs" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_agent_id_fk_idx" ON "cost_events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_bundles_origin_issue_id_fk_idx" ON "decision_bundles" USING btree ("origin_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_annotation_anchor_snapshots_document_id_fk_idx" ON "document_annotation_anchor_snapshots" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_annotation_comments_document_id_fk_idx" ON "document_annotation_comments" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_annotation_comments_issue_id_fk_idx" ON "document_annotation_comments" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_annotation_threads_document_id_fk_idx" ON "document_annotation_threads" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_annotation_threads_issue_id_fk_idx" ON "document_annotation_threads" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_memberships_document_id_fk_idx" ON "document_memberships" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_revisions_created_by_agent_id_fk_idx" ON "document_revisions" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_created_by_agent_id_fk_idx" ON "documents" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_locked_by_agent_id_fk_idx" ON "documents" USING btree ("locked_by_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_updated_by_agent_id_fk_idx" ON "documents" USING btree ("updated_by_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_object_mentions_source_issue_id_fk_idx" ON "external_object_mentions" USING btree ("source_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_exports_issue_id_fk_idx" ON "feedback_exports" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "finance_events_issue_id_fk_idx" ON "finance_events" USING btree ("issue_id");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. Production rollouts prebuild this reverse-FK index concurrently before applying the migration.
CREATE INDEX IF NOT EXISTS "heartbeat_run_events_agent_id_fk_idx" ON "heartbeat_run_events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_run_watchdog_decisions_evaluation_issue_id_fk_idx" ON "heartbeat_run_watchdog_decisions" USING btree ("evaluation_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connection_token_issuances_issue_id_fk_idx" ON "connection_token_issuances" USING btree ("issue_id");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. Production rollouts prebuild this reverse-FK index concurrently before applying the migration.
CREATE INDEX IF NOT EXISTS "issue_comments_author_agent_id_fk_idx" ON "issue_comments" USING btree ("author_agent_id");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. Production rollouts prebuild this reverse-FK index concurrently before applying the migration.
CREATE INDEX IF NOT EXISTS "issue_comments_deleted_by_agent_id_fk_idx" ON "issue_comments" USING btree ("deleted_by_agent_id");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. Production rollouts prebuild this reverse-FK index concurrently before applying the migration.
CREATE INDEX IF NOT EXISTS "issue_comments_derived_author_agent_id_fk_idx" ON "issue_comments" USING btree ("derived_author_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_plan_decompositions_source_issue_id_fk_idx" ON "issue_plan_decompositions" USING btree ("source_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_recovery_actions_owner_agent_id_fk_idx" ON "issue_recovery_actions" USING btree ("owner_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_recovery_actions_previous_owner_agent_id_fk_idx" ON "issue_recovery_actions" USING btree ("previous_owner_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_recovery_actions_return_owner_agent_id_fk_idx" ON "issue_recovery_actions" USING btree ("return_owner_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_relations_created_by_agent_id_fk_idx" ON "issue_relations" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_relations_issue_id_fk_idx" ON "issue_relations" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_relations_related_issue_id_fk_idx" ON "issue_relations" USING btree ("related_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_tree_hold_members_issue_id_fk_idx" ON "issue_tree_hold_members" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_tree_hold_members_parent_issue_id_fk_idx" ON "issue_tree_hold_members" USING btree ("parent_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_tree_holds_root_issue_id_fk_idx" ON "issue_tree_holds" USING btree ("root_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_watchdogs_issue_id_fk_idx" ON "issue_watchdogs" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_watchdogs_watchdog_issue_id_fk_idx" ON "issue_watchdogs" USING btree ("watchdog_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_assignee_agent_id_fk_idx" ON "issues" USING btree ("assignee_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_created_by_agent_id_fk_idx" ON "issues" USING btree ("created_by_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_parent_issue_id_fk_idx" ON "routines" USING btree ("parent_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_cards_document_id_fk_idx" ON "status_cards" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_cards_generating_issue_id_fk_idx" ON "status_cards" USING btree ("generating_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "summary_slots_generating_issue_id_fk_idx" ON "summary_slots" USING btree ("generating_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_action_requests_issue_id_fk_idx" ON "tool_action_requests" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_events_issue_id_fk_idx" ON "tool_call_events" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_issue_id_fk_idx" ON "tool_gateway_sessions" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_invocations_issue_id_fk_idx" ON "tool_invocations" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_mcp_gateways_approval_issue_id_fk_idx" ON "tool_mcp_gateways" USING btree ("approval_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_mcp_gateways_issue_id_fk_idx" ON "tool_mcp_gateways" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_runtime_slots_issue_id_fk_idx" ON "tool_runtime_slots" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_runtime_services_issue_id_fk_idx" ON "workspace_runtime_services" USING btree ("issue_id");
