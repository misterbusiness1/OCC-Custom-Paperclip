CREATE INDEX IF NOT EXISTS "company_onboarding_seeds_issue_id_fk_idx" ON "company_onboarding_seeds" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_workspace_runtime_leases_owner_issue_id_fk_idx" ON "execution_workspace_runtime_leases" USING btree ("owner_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_workspace_runtime_leases_owner_run_id_fk_idx" ON "execution_workspace_runtime_leases" USING btree ("owner_run_id");
