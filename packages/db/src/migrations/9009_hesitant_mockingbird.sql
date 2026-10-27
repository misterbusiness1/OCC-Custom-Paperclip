-- Better Auth 1.7.3+ returns to provider/account identity. Never merge or
-- discard ambiguous historical accounts: operator reconciliation is required.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "account" GROUP BY "provider_id", "account_id" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate Better Auth provider/account keys; reconcile distinct accounts before upgrading';
  END IF;
END $$;--> statement-breakpoint
DROP INDEX "account_issuer_account_id_uq";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
