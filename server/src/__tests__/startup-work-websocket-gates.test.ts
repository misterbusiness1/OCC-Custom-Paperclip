import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ barrier: null as any }));
vi.mock("../services/startup-work-barrier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/startup-work-barrier.js")>();
  return { ...actual, isStartupWorkHeld: () => state.barrier.isHeld() };
});
import { createStartupWorkBarrier } from "../services/startup-work-barrier.js";
import { setupRunnerPrpWebSocketServer, runnerPrpWebSocketInternals } from "../realtime/runner-prp-ws.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { setupEnvironmentCustomImageTerminalWebSocketServer } from "../realtime/environment-custom-image-terminal-ws.js";

let server: ReturnType<typeof createServer>;
let auth: ReturnType<typeof vi.fn<() => Promise<null>>>;
let provider: ReturnType<typeof vi.fn>;
let cleanup: Array<() => void>;

beforeEach(() => {
  state.barrier = createStartupWorkBarrier({ PAPERCLIP_STARTUP_WORK_HELD: "true" });
  server = createServer();
  auth = vi.fn(async () => null);
  provider = vi.fn(() => { throw new Error("unexpected terminal provider call"); });
  cleanup = [];
  setupRunnerPrpWebSocketServer(server, { apiUrl: "http://127.0.0.1:3100" });
  const terminal = setupEnvironmentCustomImageTerminalWebSocketServer(server, {} as never, {
    customImageService: { getSessionById: provider, refreshSetupSession: provider } as never,
  });
  const live = setupLiveEventsWebSocketServer(server, {} as never, {
    deploymentMode: "authenticated", resolveSessionFromHeaders: auth,
  });
  cleanup.push(() => terminal.close(), () => live.close());
});
afterEach(() => {
  cleanup.forEach((close) => close());
  server.close();
  runnerPrpWebSocketInternals.resetForTests();
});

const paths = [
  ["runner", "/api/runner/v1/connect/00000000-0000-4000-8000-000000000777", "404 Not Found"],
  ["terminal", "/api/environment-custom-image-setup-sessions/session/terminal/ws", "400 Bad Request"],
  ["live events", "/api/companies/company-1/events/ws", "403 Forbidden"],
] as const;
async function upgrade(path: string) {
  const socket = new PassThrough();
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  server.emit("upgrade", { url: path, headers: {} }, socket, Buffer.alloc(0));
  await new Promise<void>((resolve) => setImmediate(resolve));
  socket.destroy();
  return Buffer.concat(chunks).toString("utf8");
}

describe("startup hold across actual server upgrade listeners", () => {
  it.each(paths)("rejects %s before session lookup or terminal access", async (_name, path) => {
    expect(await upgrade(path)).toContain("503 Service Unavailable");
    expect(auth).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  it.each(paths)("restores ordinary %s validation after same-process release", async (_name, path, ordinaryStatus) => {
    const before = state.barrier.snapshot();
    state.barrier.release({ expectedBootId: before.bootId, expectedGeneration: before.generation, qualificationSha256: "b".repeat(64) });
    expect(await upgrade(path)).toContain(ordinaryStatus);
    expect(provider).not.toHaveBeenCalled();
  });
});
