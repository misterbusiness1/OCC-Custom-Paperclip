#!/usr/bin/env -S node --import tsx
/** Read-only guard. The release operator owns qualification pins, lock, and writer observation. */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createDb, closeRegisteredClients } from "../packages/db/src/client.js";
import { assertCommentRequestRollbackSafe } from "../server/src/services/issue-comment-requests.js";
import { readPinnedJson, validateReleaseEvidence } from "./check-board-comment-protocol-release-policy.mjs";

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
