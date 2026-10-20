CREATE INDEX IF NOT EXISTS "browser_use_runs_heartbeat_run_id_fk_idx" ON "browser_use_runs" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_use_sessions_issue_id_fk_idx" ON "browser_use_sessions" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_completion_deliveries_target_run_id_fk_idx" ON "chat_completion_deliveries" USING btree ("target_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_task_handoffs_conversation_id_fk_idx" ON "chat_task_handoffs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_github_reviews_run_id_fk_idx" ON "chat_github_reviews" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runner_api_response_reservations_run_id_fk_idx" ON "runner_api_response_reservations" USING btree ("run_id");
