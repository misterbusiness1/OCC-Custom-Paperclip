import { describe, expect, it } from "vitest";
import { decideRevisionRecovery, revisionIdentity } from "./revision-outcome.js";

const now = new Date("2026-10-21T18:00:00Z");
const base = { status: "revision_requested", decidedAt: new Date(now.getTime() - 60 * 60_000), now,
  attemptCount: 0, lastAttemptAt: null as Date | null, blocker: null as string | null,
  activeExecution: false, invokable: true };

describe("revision domain outcomes", () => {
  it("a successful no-op remains unresolved and requires follow-through", () => {
    expect(decideRevisionRecovery(base)).toMatchObject({ outcome: "unresolved", action: "retry" });
  });
  it.each(["pending", "approved", "rejected"])("uses actual same-card %s status", status => {
    expect(decideRevisionRecovery({ ...base, status })).toMatchObject({
      outcome: status === "pending" ? "resubmitted" : "disposed", action: "none",
    });
  });
  it("preserves a named human or dependency blocker without spending retry budget", () => {
    expect(decideRevisionRecovery({ ...base, blocker: "interaction:human-1", attemptCount: 3 }))
      .toMatchObject({ outcome: "durable_blocker", action: "none", blocker: "interaction:human-1" });
  });
  it("does not treat a queued/running/deferred turn as completion or duplicate it", () => {
    expect(decideRevisionRecovery({ ...base, activeExecution: true }))
      .toMatchObject({ outcome: "unresolved", action: "none" });
  });
  it("bounds retries including failed and skipped delivery", () => {
    expect(decideRevisionRecovery({ ...base, attemptCount: 3 })).toMatchObject({ action: "escalate" });
    expect(decideRevisionRecovery({ ...base, attemptCount: 1, lastAttemptAt: new Date(now.getTime() - 10 * 60_000) }))
      .toMatchObject({ action: "none", nextFollowUpAt: "2026-10-21T18:05:00.000Z" });
  });
  it("ages unresolved revisions to named intervention even without retries", () => {
    expect(decideRevisionRecovery({ ...base, decidedAt: new Date(now.getTime() - 24 * 60 * 60_000) }))
      .toMatchObject({ action: "escalate" });
  });
  it("never resets revision identity on payload edits and distinguishes repeated decisions", () => {
    expect(revisionIdentity("a", now)).toBe(revisionIdentity("a", now));
    expect(revisionIdentity("a", now)).not.toBe(revisionIdentity("a", new Date(now.getTime() + 1)));
  });
});
