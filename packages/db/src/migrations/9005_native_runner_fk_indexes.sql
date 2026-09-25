CREATE INDEX IF NOT EXISTS "issue_question_response_deliveries_issue_id_fk_idx" ON "issue_question_response_deliveries" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_question_response_deliveries_source_run_id_fk_idx" ON "issue_question_response_deliveries" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_question_response_deliveries_target_run_id_fk_idx" ON "issue_question_response_deliveries" USING btree ("target_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "native_run_finalizations_run_owner_fk_idx" ON "native_run_finalizations" USING btree ("company_id","issue_id","run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "native_run_results_run_contract_owner_fk_idx" ON "native_run_results" USING btree ("company_id","issue_id","run_id","completion_contract_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_decision_effects_issue_company_fk_idx" ON "status_decision_effects" USING btree ("company_id","issue_id");
