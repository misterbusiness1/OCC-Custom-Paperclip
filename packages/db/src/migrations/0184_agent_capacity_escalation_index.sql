-- Dedupe guard for the active-assignment capacity guardrail (OXFA-24675).
-- One open manager escalation per agent per cap episode; a racing reconcile hits
-- this index and gets a unique violation instead of filing a duplicate.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this forward-only partial unique index is required to make capacity escalation episodes idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_agent_capacity_escalation_uq"
  ON "issues" USING btree ("company_id", "origin_kind", "origin_id")
  WHERE "origin_kind" = 'agent_capacity_escalation'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
