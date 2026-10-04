import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const COMMIT = /^[a-f0-9]{40}$/;
const PHASES = new Set(["pre-swap", "dispatcher-ready", "held-release", "activation", "rollback"]);

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

/** The expected digest must come from approved qualification, not from this file itself. */
export function readPinnedJson(bytes, expectedDigest, label) {
  requireCondition(SHA256.test(expectedDigest ?? ""), `${label}_pin_required`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  requireCondition(actual === expectedDigest, `${label}_digest_mismatch`);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label}_invalid`);
    return value;
  } catch {
    throw new Error(`${label}_invalid`);
  }
}

/** Resolve actual inspected container flags; missing flags default off. No capability comes from env. */
export function observedSwitch(value) {
  if (value === undefined || value === null || value === "") return false;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("invalid_observed_switch");
}

/** Check the database actually connected by the CLI, not just an operator boolean. */
export function validateConnectedDatabase(expected, actual) {
  requireCondition(expected && /^[0-9]+$/.test(expected.systemIdentifier ?? "")
    && typeof expected.database === "string" && expected.database.length > 0
    && (expected.migrationLedgerSha256 === null || SHA256.test(expected.migrationLedgerSha256 ?? "")),
  "database_identity_pin_required");
  requireCondition(expected.systemIdentifier === actual?.systemIdentifier
    && expected.database === actual?.database && expected.migrationLedgerSha256 === actual?.migrationLedgerSha256,
  "connected_database_identity_or_ledger_changed");
}

export function validateReleaseEvidence({ phase, qualification, observation, expectedImage, expectedSource, now = Date.now() }) {
  requireCondition(PHASES.has(phase), "invalid_release_phase");
  requireCondition(IMAGE.test(expectedImage ?? "") && COMMIT.test(expectedSource ?? ""), "immutable_target_required");
  requireCondition(qualification.schema === "paperclip.board-comment-protocol-qualification.v1", "qualification_schema_invalid");
  requireCondition(qualification.imageDigest === expectedImage && qualification.sourceCommit === expectedSource, "qualification_target_mismatch");
  requireCondition(Number.isSafeInteger(qualification.protocolVersion) && qualification.protocolVersion >= 0, "qualification_protocol_invalid");
  requireCondition(SHA256.test(qualification.sourceCapabilitySha256 ?? ""), "source_capability_attestation_required");
  requireCondition(qualification.protocolContractVerified === true, "protocol_contract_not_qualified");
  requireCondition(observation.schema === "paperclip.board-comment-release-observation.v1", "observation_schema_invalid");
  const at = Date.parse(observation.observedAt);
  requireCondition(Number.isFinite(at) && now - at >= 0 && now - at <= 30_000, "observation_not_fresh");
  requireCondition(observation.writerInventoryComplete === true && Array.isArray(observation.writers), "writer_inventory_required");
  requireCondition(observation.releaseLockHeld === true, "release_lock_required");
  requireCondition(observation.databaseIdentityVerified === true, "database_identity_required");
  validateConnectedDatabase(observation.databaseIdentity, observation.databaseIdentity);
  requireCondition(observation.admissionsInFlight === 0 && observation.dispatchesInFlight === 0, "requests_not_quiescent");
  const identities = new Set();
  for (const writer of observation.writers) {
    requireCondition(typeof writer.id === "string" && writer.id.length > 0 && !identities.has(writer.id), "writer_identity_invalid");
    identities.add(writer.id);
    requireCondition(typeof writer.running === "boolean" && typeof writer.serving === "boolean", "writer_state_unknown");
    requireCondition(writer.flagsSource === "container_inspect", "effective_switch_observation_required");
  }
  const live = observation.writers.filter((writer) => writer.running || writer.serving);
  if (phase === "pre-swap" || phase === "rollback") {
    requireCondition(live.length === 0, "old_writers_not_stopped");
    for (const writer of observation.writers) {
      requireCondition(!observedSwitch(writer.admissionEnabled) && !observedSwitch(writer.dispatchEnabled), "swap_switches_not_off");
    }
  } else {
    requireCondition(qualification.protocolVersion > 0, "activation_requires_protocol_support");
    requireCondition(observation.migrationAttestationVerified === true, "migration_attestation_required");
    requireCondition(SHA256.test(observation.databaseIdentity.migrationLedgerSha256 ?? ""), "migration_ledger_pin_required");
    requireCondition(live.length > 0, "serving_writer_required");
    for (const writer of live) {
      requireCondition(writer.running && writer.serving && writer.imageDigest === expectedImage && writer.sourceCommit === expectedSource, "mixed_or_unknown_writers");
      requireCondition(observedSwitch(writer.dispatchEnabled), "dispatcher_disabled");
      requireCondition(observedSwitch(writer.admissionEnabled) === (phase !== "dispatcher-ready"), "admission_switch_wrong_phase");
      const boot = writer.startupWork;
      requireCondition(boot && UUID.test(boot.bootId ?? "") && writer.processBootId === boot.bootId
        && Number.isSafeInteger(boot.generation) && boot.generation >= 0, "runtime_boot_identity_required");
      requireCondition(writer.runtimeControlsSource === "authenticated_startup_work_endpoint", "runtime_control_observation_required");
      requireCondition(writer.configuredControls?.admission === observedSwitch(writer.admissionEnabled)
        && writer.configuredControls?.dispatch === observedSwitch(writer.dispatchEnabled), "configured_control_inspect_mismatch");
      if (phase === "dispatcher-ready" || phase === "held-release") {
        requireCondition(boot.configuredHold === true && boot.held === true && boot.generation === 0
          && boot.qualificationSha256 === null, "fresh_held_boot_required");
        requireCondition(writer.effectiveControls?.admission === false && writer.effectiveControls?.dispatch === false,
          "held_effective_controls_must_be_off");
        requireCondition(observation.bootstrapReadinessVerified === true, "held_bootstrap_readiness_required");
      } else {
        requireCondition(boot.held === false && writer.effectiveControls?.admission === true
          && writer.effectiveControls?.dispatch === true, "activation_work_not_released");
      }
    }
    if (phase === "activation") {
      requireCondition(observation.dispatcherReadinessVerified === true, "dispatcher_readiness_required");
      requireCondition(observation.dispatcherReadinessImageDigest === expectedImage, "dispatcher_readiness_wrong_image");
    }
  }
  return { phase, imageDigest: expectedImage, sourceCommit: expectedSource, targetProtocolVersion: qualification.protocolVersion,
    databaseIdentity: observation.databaseIdentity,
    qualifiedBoots: live.map(writer => ({ writerId: writer.id, bootId: writer.startupWork.bootId,
      generation: writer.startupWork.generation })) };
}
