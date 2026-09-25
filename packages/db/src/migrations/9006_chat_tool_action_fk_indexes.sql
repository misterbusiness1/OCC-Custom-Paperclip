CREATE INDEX IF NOT EXISTS "chat_conversations_issue_id_fk_idx" ON "chat_conversations" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_publications_issue_id_fk_idx" ON "chat_publications" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_publications_company_issue_fk_idx" ON "chat_publications" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_teams_file_transfers_issue_id_fk_idx" ON "chat_teams_file_transfers" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_conversation_agent_id_fk_idx" ON "issues" USING btree ("conversation_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_action_deliveries_issue_id_fk_idx" ON "tool_action_deliveries" USING btree ("issue_id");
