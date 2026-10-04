import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { observedSwitch, readPinnedJson, validateConnectedDatabase, validateReleaseEvidence } from "./check-board-comment-protocol-release-policy.mjs";

const image = `sha256:${"a".repeat(64)}`;
const source = "b".repeat(40);
const now = Date.parse("2026-10-03T00:00:00Z");
function evidence(phase = "pre-swap") {
  const live = ["activation", "dispatcher-ready", "held-release"].includes(phase);
  const held = phase !== "activation";
  const admission = phase !== "dispatcher-ready" && live;
  const bootId = "12345678-1234-1234-1234-123456789abc";
  return {
    phase, expectedImage: image, expectedSource: source, now,
    qualification: { schema: "paperclip.board-comment-protocol-qualification.v1", imageDigest: image,
      sourceCommit: source, protocolVersion: 1, sourceCapabilitySha256: "c".repeat(64), protocolContractVerified: true },
    observation: { schema: "paperclip.board-comment-release-observation.v1", observedAt: new Date(now).toISOString(),
      writerInventoryComplete: true, releaseLockHeld: true, databaseIdentityVerified: true,
      databaseIdentity: { database: "paperclip", systemIdentifier: "1234", migrationLedgerSha256: "d".repeat(64) },
      bootstrapReadinessVerified: true,
      admissionsInFlight: 0, dispatchesInFlight: 0, migrationAttestationVerified: true,
      dispatcherReadinessVerified: true, dispatcherReadinessImageDigest: image,
      writers: [{ id: "app-1", running: live, serving: live, flagsSource: "container_inspect",
        imageDigest: image, sourceCommit: source, admissionEnabled: admission, dispatchEnabled: live,
        processBootId: bootId, startupWork: { bootId, generation: held ? 0 : 1, configuredHold: true,
          held, qualificationSha256: held ? null : "e".repeat(64) },
        runtimeControlsSource: "authenticated_startup_work_endpoint",
        configuredControls: { admission, dispatch: live }, effectiveControls: { admission: held ? false : admission, dispatch: !held && live } }] },
  };
}

test("qualification content must match an external SHA256 pin", () => {
  const bytes = Buffer.from(JSON.stringify(evidence().qualification));
  const pin = createHash("sha256").update(bytes).digest("hex");
  assert.equal(readPinnedJson(bytes, pin, "qualification").protocolVersion, 1);
  assert.throws(() => readPinnedJson(Buffer.from(bytes.toString().replace('"protocolVersion":1', '"protocolVersion":0')), pin, "qualification"), /digest_mismatch/);
  assert.throws(() => readPinnedJson(bytes, undefined, "qualification"), /pin_required/);
});
for (const phase of ["pre-swap", "dispatcher-ready", "held-release", "activation", "rollback"]) {
  test(`valid ${phase} evidence yields a target version, not deployment`, () => {
    const result = validateReleaseEvidence(evidence(phase));
    assert.equal(result.targetProtocolVersion, 1);
    assert.equal(result.imageDigest, image);
  });
}
for (const [label, mutate, error] of [
  ["wrong image", x => { x.qualification.imageDigest = `sha256:${"d".repeat(64)}`; }, /target_mismatch/],
  ["mutable image tag", x => { x.expectedImage = "paperclip:latest"; }, /immutable_target/],
  ["wrong source", x => { x.qualification.sourceCommit = "e".repeat(40); }, /target_mismatch/],
  ["self-declared capability without source attestation", x => { delete x.qualification.sourceCapabilitySha256; }, /capability_attestation/],
  ["unqualified protocol", x => { x.qualification.protocolContractVerified = false; }, /not_qualified/],
  ["negative protocol", x => { x.qualification.protocolVersion = -1; }, /protocol_invalid/],
  ["NaN protocol", x => { x.qualification.protocolVersion = NaN; }, /protocol_invalid/],
  ["old observation", x => { x.observation.observedAt = new Date(now - 30_001).toISOString(); }, /not_fresh/],
  ["future observation", x => { x.observation.observedAt = new Date(now + 1).toISOString(); }, /not_fresh/],
  ["incomplete writer inventory", x => { x.observation.writerInventoryComplete = false; }, /inventory_required/],
  ["no deployment lock", x => { x.observation.releaseLockHeld = false; }, /release_lock/],
  ["unknown database", x => { x.observation.databaseIdentityVerified = false; }, /database_identity/],
  ["active admission", x => { x.observation.admissionsInFlight = 1; }, /not_quiescent/],
  ["active dispatch", x => { x.observation.dispatchesInFlight = 1; }, /not_quiescent/],
  ["desired instead of observed flags", x => { x.observation.writers[0].flagsSource = "compose"; }, /effective_switch/],
  ["duplicate writer identity", x => { x.observation.writers.push({ ...x.observation.writers[0] }); }, /identity_invalid/],
  ["old writer still running", x => { x.observation.writers[0].running = true; }, /not_stopped/],
  ["admission on before swap", x => { x.observation.writers[0].admissionEnabled = "true"; }, /switches_not_off/],
  ["dispatch on before swap", x => { x.observation.writers[0].dispatchEnabled = true; }, /switches_not_off/],
]) {
  test(`rejects ${label}`, () => { const x = evidence(); mutate(x); assert.throws(() => validateReleaseEvidence(x), error); });
}
for (const [label, mutate, error] of [
  ["legacy target activation", x => { x.qualification.protocolVersion = 0; }, /protocol_support/],
  ["unattested migration", x => { x.observation.migrationAttestationVerified = false; }, /migration_attestation/],
  ["no serving writer", x => { x.observation.writers = []; }, /serving_writer/],
  ["mixed images", x => { x.observation.writers.push({ ...x.observation.writers[0], id: "old", imageDigest: `sha256:${"f".repeat(64)}` }); }, /mixed_or_unknown/],
  ["mismatched source", x => { x.observation.writers[0].sourceCommit = "f".repeat(40); }, /mixed_or_unknown/],
  ["dispatcher disabled", x => { x.observation.writers[0].dispatchEnabled = "false"; }, /dispatcher_disabled/],
  ["admission disabled", x => { x.observation.writers[0].admissionEnabled = false; }, /wrong_phase/],
  ["dispatcher not ready", x => { x.observation.dispatcherReadinessVerified = false; }, /readiness_required/],
  ["readiness for old image", x => { x.observation.dispatcherReadinessImageDigest = `sha256:${"f".repeat(64)}`; }, /wrong_image/],
]) {
  test(`activation rejects ${label}`, () => { const x = evidence("activation"); mutate(x); assert.throws(() => validateReleaseEvidence(x), error); });
}
test("dispatcher readiness keeps admission off", () => {
  const x = evidence("dispatcher-ready"); x.observation.writers[0].admissionEnabled = true;
  assert.throws(() => validateReleaseEvidence(x), /wrong_phase/);
});
test("effective switch parsing defaults off and rejects ambiguous input", () => {
  for (const value of [undefined, null, "", "false", false]) assert.equal(observedSwitch(value), false);
  for (const value of ["true", true]) assert.equal(observedSwitch(value), true);
  for (const value of ["yes", "0", "1", "TRUE", "False", {}, [], 0, 1]) assert.throws(() => observedSwitch(value), /invalid_observed_switch/);
});
test("validation does not mutate evidence", () => {
  const x = evidence("activation"), before = JSON.stringify(x);
  validateReleaseEvidence(x); assert.equal(JSON.stringify(x), before);
});

test("numeric env spellings cannot falsely prove dispatcher readiness", () => {
  const x = evidence("dispatcher-ready");
  x.observation.writers[0].dispatchEnabled = "1";
  assert.throws(() => validateReleaseEvidence(x), /invalid_observed_switch/);
});

for (const [label, mutate, error] of [
  ["wrong boot", x => { x.observation.writers[0].processBootId = "different"; }, /boot_identity/],
  ["replayed generation", x => { x.observation.writers[0].startupWork.generation = 1; }, /fresh_held/],
  ["previously consumed permit", x => { x.observation.writers[0].startupWork.qualificationSha256 = "f".repeat(64); }, /fresh_held/],
  ["unheld boot", x => { x.observation.writers[0].startupWork.held = false; }, /fresh_held/],
  ["not configured to hold", x => { x.observation.writers[0].startupWork.configuredHold = false; }, /fresh_held/],
  ["effective dispatch active", x => { x.observation.writers[0].effectiveControls.dispatch = true; }, /effective_controls/],
  ["effective admission active", x => { x.observation.writers[0].effectiveControls.admission = true; }, /effective_controls/],
  ["configured mismatch", x => { x.observation.writers[0].configuredControls.admission = false; }, /configured_control/],
  ["bootstrap incomplete", x => { x.observation.bootstrapReadinessVerified = false; }, /bootstrap_readiness/],
  ["ledger missing", x => { x.observation.databaseIdentity.migrationLedgerSha256 = null; }, /ledger_pin/],
]) test(`held release rejects ${label}`, () => {
  const x=evidence("held-release");mutate(x);assert.throws(() => validateReleaseEvidence(x),error);
});
test("held readiness never substitutes for activation", () => {
  const x=evidence("held-release");x.phase="activation";
  assert.throws(() => validateReleaseEvidence(x), /activation_work_not_released/);
});
test("connected database identity and ledger are checked separately from operator boolean", () => {
  const expected=evidence("held-release").observation.databaseIdentity;
  validateConnectedDatabase(expected,{...expected});
  for(const key of ["database","systemIdentifier","migrationLedgerSha256"])
    assert.throws(() => validateConnectedDatabase(expected,{...expected,[key]:"other"}), /connected_database/);
});
