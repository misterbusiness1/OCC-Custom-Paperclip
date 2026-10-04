import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { beginHeartbeatClaim, beginHeartbeatShutdown, isHeartbeatShuttingDown, resetHeartbeatShutdownForTests, waitForHeartbeatClaimsToSettle } from "./heartbeat-shutdown-admission.js";

beforeEach(() => resetHeartbeatShutdownForTests());
afterEach(() => vi.unstubAllEnvs());

it("closes synchronously and waits for every admitted claim without allowing new claims", async () => {
  const first = beginHeartbeatClaim()!;
  const second = beginHeartbeatClaim()!;
  beginHeartbeatShutdown();
  expect(isHeartbeatShuttingDown()).toBe(true);
  expect(beginHeartbeatClaim()).toBeNull();
  let settled = false;
  const waiting = waitForHeartbeatClaimsToSettle().then(() => { settled = true; });
  first();
  await Promise.resolve();
  expect(settled).toBe(false);
  second();
  await waiting;
  expect(settled).toBe(true);
  expect(beginHeartbeatClaim()).toBeNull();
});

it("refuses a test lifetime reset while a claim remains unfinished", () => {
  const finish = beginHeartbeatClaim()!;
  beginHeartbeatShutdown();
  expect(() => resetHeartbeatShutdownForTests()).toThrow("claims in flight");
  expect(isHeartbeatShuttingDown()).toBe(true);
  finish();
});

it("cannot reset the shutdown gate in a production process", () => {
  beginHeartbeatShutdown();
  vi.stubEnv("NODE_ENV", "production");
  expect(() => resetHeartbeatShutdownForTests()).toThrow("restricted to Vitest");
  expect(isHeartbeatShuttingDown()).toBe(true);
});
