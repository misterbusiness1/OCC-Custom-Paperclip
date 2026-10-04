#!/usr/bin/env -S node --import tsx
/** Read-only guard. The release operator owns qualification pins, lock, and writer observation. */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { createDb, closeRegisteredClients } from "../packages/db/src/client.js";
import { assertCommentRequestRollbackSafe } from "../server/src/services/issue-comment-requests.js";
import { readPinnedJson, validateConnectedDatabase, validateReleaseEvidence } from "./check-board-comment-protocol-release-policy.mjs";

// Resolve the DB workspace dependency; the repository root does not depend on drizzle-orm.
const { sql } = createRequire(new URL("../packages/db/package.json", import.meta.url))("drizzle-orm");

async function main() {
  const { values } = parseArgs({ options: {
    phase: { type: "string" },
    qualification: { type: "string" }, "qualification-sha256": { type: "string" },
    observation: { type: "string" }, "observation-sha256": { type: "string" },
    "target-image": { type: "string" }, "target-source": { type: "string" },
  }, strict: true, allowPositionals: false });
  if (!values.qualification || !values.observation) throw new Error("pinned_evidence_files_required");
  const qualification = readPinnedJson(await readFile(values.qualification), values["qualification-sha256"], "qualification");
  const observation = readPinnedJson(await readFile(values.observation), values["observation-sha256"], "observation");
  const decision = validateReleaseEvidence({ phase: values.phase, qualification, observation,
    expectedImage: values["target-image"], expectedSource: values["target-source"] });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("database_connection_required");
  const db = createDb(url, { maxConnections: 1, connectTimeoutSeconds: 5,
    applicationName: "paperclip-comment-release-preflight" });
  try {
    const identity = await db.execute(sql`select current_database() as database,
      (select system_identifier::text from pg_control_system()) as "systemIdentifier",
      to_regclass('drizzle.__drizzle_migrations') is not null as "hasLedger"`);
    if (identity.length !== 1 || typeof identity[0]?.hasLedger !== "boolean") throw new Error("database_identity_unobservable");
    let migrationLedgerSha256: string | null = null;
    if (identity[0].hasLedger) {
      const ledger = await db.execute(sql`select encode(sha256(convert_to(
        string_agg(id::text||':'||hash||':'||created_at::text,',' order by id),'UTF8')),'hex') as digest
        from drizzle.__drizzle_migrations`);
      if (ledger.length !== 1 || (ledger[0]?.digest !== null && typeof ledger[0]?.digest !== "string")) throw new Error("migration_ledger_unobservable");
      migrationLedgerSha256 = ledger[0].digest as string | null;
    }
    validateConnectedDatabase(observation.databaseIdentity, { database: identity[0].database,
      systemIdentifier: identity[0].systemIdentifier, migrationLedgerSha256 });
    // A settled row still forbids downgrade. This service also handles a pre-migration DB.
    await assertCommentRequestRollbackSafe(db, decision.targetProtocolVersion);
    console.log(JSON.stringify({ ...decision, passed: true, checkedAt: new Date().toISOString() }));
  } finally {
    await closeRegisteredClients(url);
  }
}

main().catch(() => {
  // Driver errors can contain connection details. Never print raw exception messages here.
  console.error("Board comment protocol release preflight failed; no deployment is authorized.");
  process.exitCode = 1;
});
