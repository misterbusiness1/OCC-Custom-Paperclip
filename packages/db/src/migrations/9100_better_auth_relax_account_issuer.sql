-- Better Auth 1.7.3+ identifies accounts by ("provider_id", "account_id") again
-- and never writes "account"."issuer". Databases that ran upstream Paperclip's
-- 0230_better_auth_account_issuer (the Better Auth 1.7.0-1.7.2 lineage) carry
-- "issuer" text NOT NULL, so on 1.7.3+ every sign-up would fail with a NOT NULL
-- violation. Relax the column only when it exists and is still NOT NULL.
--
-- Deliberately narrow:
-- * No-op on databases that never had an "issuer" column (the master lineage).
-- * Keeps every existing issuer value and the "account_issuer_account_id_uq"
--   index. NULL issuers never conflict under that unique index, and release-line
--   migration 9009 runs an unguarded DROP INDEX on it, so the index must still
--   be there if both migrations ever reach the same database.
-- * Safe when two server instances apply migrations at the same time:
--   DROP NOT NULL is metadata-only (no rewrite, no scan) and idempotent, so a
--   second applier waits for the first one's lock and then succeeds as a no-op.
-- * Numbered 9100 so it sorts and journals after every upstream 0xxx migration
--   (0230 included) and after the release lines' 9000-9009 fork migrations,
--   without taking a number either line has used or is likely to use next.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'account'
			AND column_name = 'issuer'
			AND is_nullable = 'NO'
	) THEN
		ALTER TABLE "public"."account" ALTER COLUMN "issuer" DROP NOT NULL;
	END IF;
END $$;
