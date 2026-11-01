import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guards merges that bring in a migration making "account"."issuer" NOT NULL,
 * such as upstream Paperclip's 0230_better_auth_account_issuer.
 *
 * 9100_better_auth_relax_account_issuer orders correctly only on fresh
 * databases, which bootstrap in journal order. An existing database records
 * 9100 the first time it migrates, and a recorded migration never runs again.
 * A NOT NULL migration merged later is pending there, so it runs after 9100
 * and brings NOT NULL back. Better Auth 1.7.3+ never writes issuer, so every
 * sign-up would then fail with a NOT NULL violation. CI only migrates fresh
 * databases, so no other test notices.
 *
 * Such a merge must add a new relax migration (9100's guarded body in a new
 * file) journaled after the NOT NULL migration and record the pair below.
 */

const RELAX_MIGRATION = "9100_better_auth_relax_account_issuer";

/**
 * Each migration that leaves "account"."issuer" NOT NULL, mapped to the relax
 * migration added in the same change and journaled after it. Add an entry
 * only together with that new relax migration; 9100 cannot be reused, because
 * existing databases have already recorded it.
 */
const ISSUER_NOT_NULL_MIGRATIONS: Record<string, string> = {};

type Migration = { tag: string; sql: string };

const migrationsDir = new URL("./migrations/", import.meta.url);
const fixturesDir = new URL("./__fixtures__/better-auth-issuer/", import.meta.url);
const upstream0230Sql = fs.readFileSync(new URL("upstream-0230-better-auth-account-issuer.sql", fixturesDir), "utf8");
const release9009Sql = fs.readFileSync(new URL("release-9009-hesitant-mockingbird.sql", fixturesDir), "utf8");
const relaxMigrationSql = fs.readFileSync(new URL(`${RELAX_MIGRATION}.sql`, migrationsDir), "utf8");

function journaledMigrations(): Migration[] {
  const journal = JSON.parse(fs.readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  return journal.entries.map(({ tag }) => ({
    tag,
    sql: fs.readFileSync(new URL(`${tag}.sql`, migrationsDir), "utf8"),
  }));
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

const ACCOUNT_TABLE = /\bTABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?(?:"account"|account\b)/i;
const ISSUER_COLUMN = /(?:"issuer"|\bissuer\b)/i;
const NOT_NULL = /(?<!\b(?:DROP|IS)\s+)\bNOT\s+NULL\b/i;
const CHECK_IS_NOT_NULL = /\bCHECK\b[^]*\bIS\s+NOT\s+NULL\b/i;
const DROP_ISSUER_NOT_NULL = /\bALTER\s+COLUMN\s+(?:"issuer"|issuer\b)\s+DROP\s+NOT\s+NULL\b/i;

/** Statements (DO-block bodies included) that make "account"."issuer" NOT NULL. */
function issuerNotNullStatements(sql: string): string[] {
  return stripSqlComments(sql)
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => ACCOUNT_TABLE.test(statement))
    .filter((statement) =>
      statement
        .split(",")
        .some((clause) => ISSUER_COLUMN.test(clause) && (NOT_NULL.test(clause) || CHECK_IS_NOT_NULL.test(clause))),
    );
}

function relaxesIssuer(sql: string): boolean {
  return DROP_ISSUER_NOT_NULL.test(stripSqlComments(sql));
}

/** Problems that would leave existing databases with "account"."issuer" NOT NULL. */
function issuerNotNullProblems(
  migrations: Migration[],
  pairs: Record<string, string> = ISSUER_NOT_NULL_MIGRATIONS,
): string[] {
  const position = new Map(migrations.map((migration, index) => [migration.tag, index]));
  const problems: string[] = [];
  migrations.forEach((migration, index) => {
    if (issuerNotNullStatements(migration.sql).length === 0) return;
    const relax = pairs[migration.tag];
    const relaxIndex = relax === undefined ? undefined : position.get(relax);
    if (relax === undefined) {
      problems.push(
        `${migration.tag} makes "account"."issuer" NOT NULL. Better Auth 1.7.3+ never writes issuer, and ` +
          `${RELAX_MIGRATION} has already run on existing databases, so it will not run again after ` +
          `${migration.tag}. Add a new relax migration (${RELAX_MIGRATION}'s guarded body in a new file) ` +
          `journaled after ${migration.tag}, and record the pair in ISSUER_NOT_NULL_MIGRATIONS ` +
          "(packages/db/src/better-auth-issuer-migration-guard.test.ts).",
      );
    } else if (relax === RELAX_MIGRATION) {
      problems.push(
        `${migration.tag} is paired with ${RELAX_MIGRATION}, which existing databases have already recorded ` +
          "and will not run again. Pair it with a new relax migration.",
      );
    } else if (relaxIndex === undefined) {
      problems.push(`${migration.tag} is paired with ${relax}, which is not in the migration journal.`);
    } else if (relaxIndex <= index) {
      problems.push(`${migration.tag} is paired with ${relax}, which must be journaled after it.`);
    } else if (!relaxesIssuer(migrations[relaxIndex]!.sql)) {
      problems.push(`${migration.tag} is paired with ${relax}, which does not drop NOT NULL from "issuer".`);
    }
  });
  return problems;
}

/** The journal after an upstream sync that brings in 0230: entries stay in file-name order. */
function withUpstream0230(migrations: Migration[], extra: Migration[] = []): Migration[] {
  return [...migrations, { tag: "0230_better_auth_account_issuer", sql: upstream0230Sql }, ...extra].sort((a, b) =>
    a.tag.localeCompare(b.tag),
  );
}

describe("account.issuer NOT NULL merge guard", () => {
  it("flags statements that make account.issuer NOT NULL and ignores the relax migrations", () => {
    expect(issuerNotNullStatements(upstream0230Sql)).toEqual([
      'ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL',
    ]);
    expect(issuerNotNullStatements(relaxMigrationSql)).toEqual([]);
    expect(issuerNotNullStatements(release9009Sql)).toEqual([]);

    for (const sql of [
      'CREATE TABLE "account" ("id" text PRIMARY KEY NOT NULL, "issuer" text NOT NULL, "account_id" text NOT NULL);',
      'ALTER TABLE "account" ADD COLUMN "issuer" text DEFAULT \'local:credential\' NOT NULL;',
      'ALTER TABLE IF EXISTS ONLY public.account ALTER COLUMN issuer SET NOT NULL;',
      'DO $$ BEGIN ALTER TABLE "public"."account" ALTER COLUMN "issuer" SET NOT NULL; END $$;',
      'ALTER TABLE "account" ADD CONSTRAINT "account_issuer_present" CHECK ("issuer" IS NOT NULL);',
    ]) {
      expect(issuerNotNullStatements(sql), sql).toHaveLength(1);
    }
    for (const sql of [
      'ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;',
      'ALTER TABLE "account_links" ALTER COLUMN "issuer" SET NOT NULL;',
      'ALTER TABLE "account" ALTER COLUMN "provider_id" SET NOT NULL;',
      'UPDATE "account" SET "scope" = NULL WHERE "issuer" IS NOT NULL;',
      '-- ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;\nSELECT 1;',
    ]) {
      expect(issuerNotNullStatements(sql), sql).toEqual([]);
    }
  });

  it("finds no migration that leaves account.issuer NOT NULL without a later relax migration", () => {
    const migrations = journaledMigrations();
    expect(migrations.map((migration) => migration.tag)).toContain(RELAX_MIGRATION);
    expect(issuerNotNullProblems(migrations)).toEqual([]);
  });

  it("fails an upstream sync that brings 0230 in until it adds a new relax migration after it", () => {
    const migrations = journaledMigrations();

    const merged = withUpstream0230(migrations);
    expect(merged.findIndex((m) => m.tag.startsWith("0230_"))).toBeLessThan(
      merged.findIndex((m) => m.tag === RELAX_MIGRATION),
    );
    const [problem, ...rest] = issuerNotNullProblems(merged);
    expect(rest).toEqual([]);
    expect(problem).toContain("0230_better_auth_account_issuer makes \"account\".\"issuer\" NOT NULL");
    expect(problem).toContain("Add a new relax migration");

    // Pointing the pair at 9100 does not help: existing databases already ran it.
    expect(
      issuerNotNullProblems(merged, { "0230_better_auth_account_issuer": RELAX_MIGRATION }),
    ).toEqual([expect.stringContaining("will not run again")]);

    const relaxAgain = { tag: "9101_better_auth_relax_account_issuer_again", sql: relaxMigrationSql };
    expect(
      issuerNotNullProblems(withUpstream0230(migrations, [relaxAgain]), {
        "0230_better_auth_account_issuer": relaxAgain.tag,
      }),
    ).toEqual([]);
  });
});
