// One process lifetime, shared by route, routine and scheduler services.
// Operator task-drain controls deliberately cannot reopen this gate.
let stopping = false;
const claims = new Set<Promise<void>>();

export function beginHeartbeatShutdown(): void {
  stopping = true;
}

export function isHeartbeatShuttingDown(): boolean {
  return stopping;
}

/** Register before the first await; finish only after commit or rollback. */
export function beginHeartbeatClaim(): (() => void) | null {
  if (stopping) return null;
  let resolve!: () => void;
  const settled = new Promise<void>((done) => { resolve = done; });
  claims.add(settled);
  return () => {
    claims.delete(settled);
    resolve();
  };
}

export async function waitForHeartbeatClaimsToSettle(): Promise<void> {
  while (claims.size > 0) await Promise.all([...claims]);
}

// Tests model independent process lifetimes. This is never exposed by a route
// or operator control, and cannot run in a production process.
export function resetHeartbeatShutdownForTests(): void {
  if (process.env.NODE_ENV !== "test" || process.env.VITEST !== "true") {
    throw new Error("Heartbeat shutdown reset is restricted to Vitest");
  }
  if (claims.size > 0) throw new Error("Cannot reset with heartbeat claims in flight");
  stopping = false;
}
