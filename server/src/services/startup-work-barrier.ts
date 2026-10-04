import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";

export const STARTUP_WORK_HELD_ENV = "PAPERCLIP_STARTUP_WORK_HELD";

export type StartupWorkBarrierSnapshot = Readonly<{
  bootId: string;
  generation: number;
  configuredHold: boolean;
  held: boolean;
  qualificationSha256: string | null;
}>;

export type StartupWorkRelease = {
  expectedBootId: string;
  expectedGeneration: number;
  qualificationSha256: string;
};

export type StartupWorkBarrierErrorCode =
  | "startup_work_hold_invalid"
  | "startup_work_held"
  | "startup_work_boot_mismatch"
  | "startup_work_generation_mismatch"
  | "startup_work_qualification_invalid"
  | "startup_work_not_held";

export class StartupWorkBarrierError extends HttpError {
  constructor(readonly code: StartupWorkBarrierErrorCode) {
    // Do not include caller input or environment values in logs/errors.
    super(code === "startup_work_held" ? 503 : 409, code, { code });
    this.name = "StartupWorkBarrierError";
  }
}

/**
 * A startup-only barrier, not a drain or a database-quiescence assertion.
 *
 * The caller must authenticate and qualify the release before calling release().
 * The digest records that qualification; this module does not verify its contents.
 * Ordinary startup is unchanged. A held boot must be explicitly released, and
 * restarting with the hold configured creates a new held boot with a new identity.
 * There is deliberately no dynamic rehold: work may already be in flight after
 * release, so closing a boolean could not truthfully establish quiescence.
 */
export function createStartupWorkBarrier(
  env: Record<string, string | undefined> = process.env,
) {
  const configuredValue = env[STARTUP_WORK_HELD_ENV];
  if (configuredValue !== undefined && configuredValue !== "false" && configuredValue !== "true") {
    throw new StartupWorkBarrierError("startup_work_hold_invalid");
  }
  const configuredHold = configuredValue === "true";
  const bootId = randomUUID();
  let held = configuredHold;
  let generation = 0;
  let qualificationSha256: string | null = null;
  let resolveReleased: () => void = () => {};
  const released = held ? new Promise<void>((resolve) => { resolveReleased = resolve; }) : Promise.resolve();

  function snapshot(): StartupWorkBarrierSnapshot {
    return Object.freeze({ bootId, generation, configuredHold, held, qualificationSha256 });
  }

  function assertWorkAllowed(): void {
    if (held) throw new StartupWorkBarrierError("startup_work_held");
  }

  function release(input: StartupWorkRelease): StartupWorkBarrierSnapshot {
    if (input?.expectedBootId !== bootId) {
      throw new StartupWorkBarrierError("startup_work_boot_mismatch");
    }
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration !== generation) {
      throw new StartupWorkBarrierError("startup_work_generation_mismatch");
    }
    if (typeof input.qualificationSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.qualificationSha256)) {
      throw new StartupWorkBarrierError("startup_work_qualification_invalid");
    }
    if (!held) throw new StartupWorkBarrierError("startup_work_not_held");

    // No await or callbacks between validation and the transition: concurrent
    // release attempts cannot consume the same boot/generation twice.
    held = false;
    generation += 1;
    qualificationSha256 = input.qualificationSha256;
    resolveReleased();
    return snapshot();
  }

  return Object.freeze({ snapshot, isHeld: () => held, waitUntilReleased: () => released, assertWorkAllowed, release });
}

export const startupWorkBarrier = createStartupWorkBarrier();
export const isStartupWorkHeld = () => startupWorkBarrier.isHeld();
export const assertStartupWorkAllowed = () => startupWorkBarrier.assertWorkAllowed();

export const waitForStartupWorkRelease = () => startupWorkBarrier.waitUntilReleased();
