import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { createActivityEventDedupe } from "./activity-event-dedupe";
const event = (companyId: string, activityId?: string, id = 1): LiveEvent => ({ id, companyId, type: "activity.logged",
  createdAt: "2026-10-04T00:00:00Z", payload: { activityId, action: "issue.updated", entityId: "issue-1" } });
describe("durable activity event identity", () => {
  it("deduplicates the same audit across transport IDs while preserving other audits and companies", () => {
    const dedupe = createActivityEventDedupe();
    const first = event("company-a", "audit-1");
    expect(dedupe.has(first)).toBe(false);
    dedupe.record(first);
    expect(dedupe.has(event("company-a", "audit-1", 200))).toBe(true);
    expect(dedupe.has(event("company-a", "audit-2"))).toBe(false);
    expect(dedupe.has(event("company-b", "audit-1"))).toBe(false);
  });
  it("retains legacy activity and non-activity updates", () => {
    const dedupe = createActivityEventDedupe();
    const legacy = event("company-a");
    dedupe.record(legacy);
    expect(dedupe.has(legacy)).toBe(false);
    const status = { ...event("company-a", "audit-1"), type: "heartbeat.run.status" as const };
    dedupe.record(status);
    expect(dedupe.has(status)).toBe(false);
  });
  it("bounds retention by count and age without recording failed processing", () => {
    let now = 0;
    const dedupe = createActivityEventDedupe({ maxEntries: 2, ttlMs: 100, now: () => now });
    expect(dedupe.has(event("c", "failed"))).toBe(false);
    expect(dedupe.has(event("c", "failed"))).toBe(false);
    for (const id of ["1", "2", "3"]) dedupe.record(event("c", id));
    expect(dedupe.has(event("c", "1"))).toBe(false);
    expect(dedupe.has(event("c", "2"))).toBe(true);
    now = 100;
    expect(dedupe.has(event("c", "2"))).toBe(false);
    expect(dedupe.has(event("c", "3"))).toBe(false);
  });
});
