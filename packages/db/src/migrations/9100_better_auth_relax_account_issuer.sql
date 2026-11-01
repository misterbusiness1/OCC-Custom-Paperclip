-- Better Auth 1.7.3+ identifies accounts by ("provider_id", "account_id") again
-- and never writes "account"."issuer". Databases that ran upstream Paperclip's
-- 0230_better_auth_account_issuer (the Better Auth 1.7.0-1.7.2 lineage) carry
-- "issuer" text NOT NULL, so on 1.7.3+ every sign-up would fail with a NOT NULL
-- violation. Relax the column only when it exists and is still NOT NULL.
--
-- Deliberately narrow:
-- * No-op on databases that never had an "issuer" column (the master lineage).
--   The guard reads information_schema only and takes no lock on "account".
-- * Keeps every existing issuer value and the "account_issuer_account_id_uq"
--   index. NULL issuers never conflict under that unique index, and release-line
--   migration 9009 runs an unguarded DROP INDEX on it, so the index must still
--   be there if both migrations ever reach the same database.
-- * Locking: DROP NOT NULL is catalog-only (no rewrite, no scan) but needs an
--   ACCESS EXCLUSIVE lock on "account". It waits for every open transaction that
--   has touched the table (a long pg_dump, for example), and while it waits it
--   also blocks new reads of "account", which stalls sign-in. lock_timeout caps
--   that wait at 5s: the migration then fails with 55P03 and nothing changes,
--   server startup exits with that error, and the next start retries it.
-- * Safe when two server instances apply it at the same time: the second one
--   waits for the first one's lock, then succeeds as a no-op.
--
-- Ordering: the number only orders fresh databases, which bootstrap in journal
-- order. An existing database records 9100 the first time it migrates and never
-- runs it again. If 0230 (or anything else that makes "issuer" NOT NULL) is
-- merged later, it runs after 9100 there and brings NOT NULL back, so such a
-- merge needs a new relax migration journaled after it;
-- better-auth-issuer-migration-guard.test.ts fails until it has one.
-- Numbering: upstream owns 0186+ and the release lines use 9000-9009, so
-- master's own migrations continue at 9101 (drizzle-kit takes the last idx + 1).
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
		PERFORM set_config('lock_timeout', '5s', true);
		ALTER TABLE "public"."account" ALTER COLUMN "issuer" DROP NOT NULL;
	END IF;
END $$;
