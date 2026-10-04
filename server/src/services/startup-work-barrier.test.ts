import { describe, expect, it } from "vitest";
import {
  createStartupWorkBarrier,
  STARTUP_WORK_HELD_ENV,
  StartupWorkBarrierError,
  type StartupWorkRelease,
} from "./startup-work-barrier.js";

const digest = "a".repeat(64);
const heldBoot = () => createStartupWorkBarrier({ [STARTUP_WORK_HELD_ENV]: "true" });
const releaseInput = (barrier: ReturnType<typeof heldBoot>): StartupWorkRelease => ({
  expectedBootId: barrier.snapshot().bootId,
  expectedGeneration: barrier.snapshot().generation,
  qualificationSha256: digest,
});

describe("startup work barrier", () => {
  it.each([undefined, "false"])("preserves ordinary startup for %s", (value) => {
    const barrier = createStartupWorkBarrier({ [STARTUP_WORK_HELD_ENV]: value });
    expect(barrier.snapshot()).toMatchObject({ configuredHold: false, held: false, generation: 0, qualificationSha256: null });
    expect(() => barrier.assertWorkAllowed()).not.toThrow();
    expect(() => barrier.release(releaseInput(barrier))).toThrow("startup_work_not_held");
  });

  it.each(["", "1", "0", "TRUE", "False", "yes", "on", " true "])("rejects ambiguous operator configuration %j", (value) => {
    expect(() => createStartupWorkBarrier({ [STARTUP_WORK_HELD_ENV]: value })).toThrow("startup_work_hold_invalid");
  });

  it("blocks work before a qualified transition and records the release digest", () => {
    const barrier = heldBoot();
    expect(barrier.isHeld()).toBe(true);
    expect(() => barrier.assertWorkAllowed()).toThrow("startup_work_held");
    const initial = barrier.snapshot();
    expect(barrier.release(releaseInput(barrier))).toEqual({
      ...initial, generation: 1, held: false, qualificationSha256: digest,
    });
    expect(barrier.isHeld()).toBe(false);
    expect(() => barrier.assertWorkAllowed()).not.toThrow();
    expect(initial.held).toBe(true);
  });

  it("does not let an old process qualification release a new held boot", () => {
    const old = heldBoot();
    const permit = releaseInput(old);
    old.release(permit);
    const restarted = heldBoot();
    expect(restarted.snapshot().bootId).not.toBe(old.snapshot().bootId);
    expect(() => restarted.release(permit)).toThrow("startup_work_boot_mismatch");
    expect(restarted.snapshot()).toMatchObject({ held: true, generation: 0, qualificationSha256: null });
  });

  it.each([-1, 1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects stale or invalid generation %s without opening", (expectedGeneration) => {
    const barrier = heldBoot();
    expect(() => barrier.release({ ...releaseInput(barrier), expectedGeneration })).toThrow("startup_work_generation_mismatch");
    expect(barrier.isHeld()).toBe(true);
  });

  it.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64), null])("rejects an invalid qualification digest without opening", (qualificationSha256) => {
    const barrier = heldBoot();
    expect(() => barrier.release({ ...releaseInput(barrier), qualificationSha256 } as StartupWorkRelease)).toThrow("startup_work_qualification_invalid");
    expect(barrier.snapshot()).toMatchObject({ held: true, generation: 0, qualificationSha256: null });
  });

  it("rejects replay even when the caller supplies the new generation", () => {
    const barrier = heldBoot();
    const permit = releaseInput(barrier);
    barrier.release(permit);
    expect(() => barrier.release(permit)).toThrow("startup_work_generation_mismatch");
    expect(() => barrier.release(releaseInput(barrier))).toThrow("startup_work_not_held");
    expect(barrier.snapshot().qualificationSha256).toBe(digest);
  });

  it("allows only one of concurrent release attempts to consume the observation", async () => {
    const barrier = heldBoot();
    const permit = releaseInput(barrier);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() => barrier.release(permit))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
    expect(barrier.snapshot().generation).toBe(1);
  });

  it("captures operator configuration once and exposes no mutable state or rehold", () => {
    const env = { [STARTUP_WORK_HELD_ENV]: "true" };
    const barrier = createStartupWorkBarrier(env);
    env[STARTUP_WORK_HELD_ENV] = "false";
    expect(barrier.isHeld()).toBe(true);
    expect(Reflect.set(barrier.snapshot(), "held", false)).toBe(false);
    expect(Reflect.set(barrier, "isHeld", () => false)).toBe(false);
    expect("rehold" in barrier).toBe(false);
  });

  it("returns a stable error code without reflecting input values", () => {
    const barrier = heldBoot();
    try {
      barrier.release({ ...releaseInput(barrier), expectedBootId: "private-untrusted-input" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(StartupWorkBarrierError);
      expect(error).toMatchObject({ code: "startup_work_boot_mismatch", message: "startup_work_boot_mismatch" });
      expect(String(error)).not.toContain("private-untrusted-input");
    }
  });
  it("defers startup continuations until successful release and resumes them asynchronously once", async () => {
    const barrier = heldBoot();
    const calls: string[] = [];
    const wait = barrier.waitUntilReleased().then(() => calls.push("resumed"));
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(() => barrier.release({ ...releaseInput(barrier), expectedBootId: "wrong" })).toThrow();
    await Promise.resolve();
    expect(calls).toEqual([]);
    barrier.release(releaseInput(barrier));
    expect(calls).toEqual([]);
    await wait;
    expect(calls).toEqual(["resumed"]);
    await expect(barrier.waitUntilReleased()).resolves.toBeUndefined();
  });

  it("does not block ordinary startup continuations", async () => {
    await expect(createStartupWorkBarrier({}).waitUntilReleased()).resolves.toBeUndefined();
  });

});
