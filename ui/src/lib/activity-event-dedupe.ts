import type { LiveEvent } from "@paperclipai/shared";

/** Browser-session duplicate suppression only; audit persistence remains authoritative. */
export function createActivityEventDedupe(options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
  const maxEntries = options.maxEntries ?? 2048;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Invalid activity dedupe bounds");
  }
  const seen = new Map<string, number>();
  const keyOf = (event: LiveEvent) => {
    const id = event.payload?.activityId;
    return event.type === "activity.logged" && typeof id === "string" && id.length > 0 && id.length <= 128
      && typeof event.companyId === "string" && event.companyId.length <= 128
      ? JSON.stringify([event.companyId, id]) : null;
  };
  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, timestamp] of seen) if (timestamp <= cutoff) seen.delete(key);
  }
  return {
    has(event: LiveEvent) {
      const key = keyOf(event);
      if (key === null) return false;
      prune();
      return seen.has(key);
    },
    /** Record after cache/subscriber processing succeeds so failed processing can retry. */
    record(event: LiveEvent) {
      const key = keyOf(event);
      if (key === null) return;
      prune();
      seen.delete(key);
      seen.set(key, now());
      while (seen.size > maxEntries) seen.delete(seen.keys().next().value!);
    },
  };
}
