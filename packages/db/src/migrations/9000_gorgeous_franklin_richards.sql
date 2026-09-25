ALTER TABLE "budget_incidents" DROP CONSTRAINT "budget_incidents_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "budget_incidents" DROP CONSTRAINT "budget_incidents_policy_id_budget_policies_id_fk";
--> statement-breakpoint
ALTER TABLE "budget_incidents" DROP CONSTRAINT "budget_incidents_approval_id_approvals_id_fk";
--> statement-breakpoint
ALTER TABLE "budget_policies" DROP CONSTRAINT "budget_policies_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_policy_id_budget_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
UPDATE "approvals" AS approval
SET
	"status" = 'rejected',
	"decision_note" = COALESCE("decision_note", 'Budget scope no longer exists.'),
	"decided_by_user_id" = COALESCE("decided_by_user_id", 'system'),
	"decided_at" = COALESCE("decided_at", now()),
	"updated_at" = now()
FROM "budget_incidents" AS incident
JOIN "budget_policies" AS policy ON policy."id" = incident."policy_id"
LEFT JOIN "agents" AS agent
	ON policy."scope_type" = 'agent' AND agent."id" = policy."scope_id" AND agent."company_id" = policy."company_id"
LEFT JOIN "projects" AS project
	ON policy."scope_type" = 'project' AND project."id" = policy."scope_id" AND project."company_id" = policy."company_id"
WHERE approval."id" = incident."approval_id"
	AND approval."status" = 'pending'
	AND (
		(policy."scope_type" = 'agent' AND agent."id" IS NULL)
		OR (policy."scope_type" = 'project' AND project."id" IS NULL)
		OR (policy."scope_type" = 'company' AND policy."scope_id" <> policy."company_id")
		OR policy."scope_type" NOT IN ('company', 'agent', 'project')
	);
--> statement-breakpoint
DELETE FROM "budget_policies" AS policy
WHERE
	(policy."scope_type" = 'agent' AND NOT EXISTS (
		SELECT 1 FROM "agents" AS agent
		WHERE agent."id" = policy."scope_id" AND agent."company_id" = policy."company_id"
	))
	OR (policy."scope_type" = 'project' AND NOT EXISTS (
		SELECT 1 FROM "projects" AS project
		WHERE project."id" = policy."scope_id" AND project."company_id" = policy."company_id"
	))
	OR (policy."scope_type" = 'company' AND policy."scope_id" <> policy."company_id")
	OR policy."scope_type" NOT IN ('company', 'agent', 'project');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_budget_policy_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."scope_type" = 'company' THEN
		IF NEW."scope_id" <> NEW."company_id" THEN
			RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Budget company scope does not match company_id';
		END IF;
	ELSIF NEW."scope_type" = 'agent' THEN
		PERFORM 1 FROM "agents"
		WHERE "id" = NEW."scope_id" AND "company_id" = NEW."company_id";
		IF NOT FOUND THEN
			RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Budget agent scope does not exist in company';
		END IF;
	ELSIF NEW."scope_type" = 'project' THEN
		PERFORM 1 FROM "projects"
		WHERE "id" = NEW."scope_id" AND "company_id" = NEW."company_id";
		IF NOT FOUND THEN
			RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Budget project scope does not exist in company';
		END IF;
	ELSE
		RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invalid budget scope type';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "budget_policies_validate_scope" ON "budget_policies";
--> statement-breakpoint
CREATE TRIGGER "budget_policies_validate_scope"
BEFORE INSERT OR UPDATE OF "company_id", "scope_type", "scope_id" ON "budget_policies"
FOR EACH ROW
EXECUTE FUNCTION "validate_budget_policy_scope"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_pending_approvals_for_deleted_budget_policy"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	UPDATE "approvals" AS approval
	SET
		"status" = 'rejected',
		"decision_note" = COALESCE("decision_note", 'Budget scope was deleted.'),
		"decided_by_user_id" = COALESCE("decided_by_user_id", 'system'),
		"decided_at" = COALESCE("decided_at", now()),
		"updated_at" = now()
	FROM "budget_incidents" AS incident
	WHERE incident."policy_id" = OLD."id"
		AND incident."approval_id" = approval."id"
		AND approval."status" = 'pending';
	RETURN OLD;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "budget_policies_reject_pending_approvals" ON "budget_policies";
--> statement-breakpoint
CREATE TRIGGER "budget_policies_reject_pending_approvals"
BEFORE DELETE ON "budget_policies"
FOR EACH ROW
EXECUTE FUNCTION "reject_pending_approvals_for_deleted_budget_policy"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "remove_budget_policies_for_detached_scope"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	DELETE FROM "budget_policies"
	WHERE "company_id" = OLD."company_id"
		AND "scope_type" = TG_ARGV[0]
		AND "scope_id" = OLD."id";
	RETURN OLD;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agents_cleanup_budget_policies" ON "agents";
--> statement-breakpoint
CREATE TRIGGER "agents_cleanup_budget_policies"
AFTER DELETE OR UPDATE OF "company_id" ON "agents"
FOR EACH ROW
EXECUTE FUNCTION "remove_budget_policies_for_detached_scope"('agent');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "projects_cleanup_budget_policies" ON "projects";
--> statement-breakpoint
CREATE TRIGGER "projects_cleanup_budget_policies"
AFTER DELETE OR UPDATE OF "company_id" ON "projects"
FOR EACH ROW
EXECUTE FUNCTION "remove_budget_policies_for_detached_scope"('project');
