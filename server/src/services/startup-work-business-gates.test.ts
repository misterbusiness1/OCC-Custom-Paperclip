import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { createStartupWorkBarrier } from "./startup-work-barrier.js";

const gate = vi.hoisted(() => ({ barrier: null as ReturnType<typeof createStartupWorkBarrier> | null }));
vi.mock("./startup-work-barrier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./startup-work-barrier.js")>();
  return { ...actual, isStartupWorkHeld: () => gate.barrier!.isHeld(), assertStartupWorkAllowed: () => gate.barrier!.assertWorkAllowed() };
});
import { createStartupWorkBarrier as createBarrier } from "./startup-work-barrier.js";
import { emailChannelService } from "./email-channels.js";
import { chatChannelService } from "./chat-channels.js";
import { createPluginJobScheduler } from "./plugin-job-scheduler.js";
import { createPluginEventBus } from "./plugin-event-bus.js";
import { createPluginWorkerHandle } from "./plugin-worker-manager.js";

const release = () => {
  const current = gate.barrier!.snapshot();
  gate.barrier!.release({ expectedBootId: current.bootId, expectedGeneration: current.generation, qualificationSha256: "a".repeat(64) });
};
const untouchedDb = () => {
  const select = vi.fn(() => { throw new Error("test database reached"); });
  return { db: { select } as unknown as Db, select };
};

beforeEach(() => { gate.barrier = createBarrier({ PAPERCLIP_STARTUP_WORK_HELD: "true" }); });
afterEach(() => { vi.useRealTimers(); });

describe("held startup business effect entrypoints", () => {
  it("keeps email timer registered but performs no polling until release", async () => {
    vi.useFakeTimers();
    const { db, select } = untouchedDb();
    const service = emailChannelService(db, {} as never);
    service.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(select).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(select).toHaveBeenCalled();
    await service.shutdown();
  });

  it("rejects direct email admission and sending before touching credentials/database", async () => {
    const { db, select } = untouchedDb();
    const service = emailChannelService(db, {} as never);
    await expect(service.admit({} as never, {})).rejects.toMatchObject({ code: "startup_work_held" });
    await expect(service.queueSend("company", {} as never, {} as never)).rejects.toMatchObject({ code: "startup_work_held" });
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects direct chat publication and provider reconciliation before provider work", async () => {
    const { db, select } = untouchedDb();
    const service = chatChannelService(db, { publicBaseUrl: "http://127.0.0.1:3100", heartbeat: {} } as never);
    await expect(service.reconcileProviderRuntimes()).rejects.toMatchObject({ code: "startup_work_held" });
    await expect(service.processPendingPublications()).rejects.toMatchObject({ code: "startup_work_held" });
    await expect(service.publishComment("endpoint", "conversation", "comment")).rejects.toMatchObject({ code: "startup_work_held" });
    expect(select).not.toHaveBeenCalled();
  });

  it("blocks plugin scheduled and manual jobs before database claims or worker calls", async () => {
    const { db, select } = untouchedDb();
    const call = vi.fn();
    const scheduler = createPluginJobScheduler({ db, jobStore: {} as never, workerManager: { call } as never });
    await scheduler.tick();
    await expect(scheduler.triggerJob("job")).rejects.toMatchObject({ code: "startup_work_held" });
    expect(select).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects plugin events explicitly while held then delivers once after release", async () => {
    const bus = createPluginEventBus();
    const handler = vi.fn();
    bus.forPlugin("plugin").subscribe("issue.created", handler);
    const event = { eventType: "issue.created", companyId: "company", payload: {} } as never;
    await expect(bus.emit(event)).rejects.toMatchObject({ code: "startup_work_held" });
    expect(handler).not.toHaveBeenCalled();
    release();
    await bus.emit(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("blocks direct plugin worker startup and business RPC without spawning a process", async () => {
    const worker = createPluginWorkerHandle("fixture", { entrypoint: "/does-not-exist" } as never);
    await expect(worker.start()).rejects.toMatchObject({ code: "startup_work_held" });
    await expect(worker.call("runJob", {} as never)).rejects.toMatchObject({ code: "startup_work_held" });
    expect(worker.diagnostics().status).toBe("stopped");
  });
  it("holds every exported chat delivery pump and direct publication entrypoint", async () => {
    const { db, select } = untouchedDb();
    const service = chatChannelService(db, { publicBaseUrl: "http://127.0.0.1:3100", heartbeat: {} } as never);
    const names = ["handleWebhook", "replayDelivery", "replayPublication", "resolveAction", "resolvePublication", "publishBoardMessage", "reconcileProviderRuntimes", "processPendingPublications", "enqueueInboundWakeupPublications", "schedulePendingPublications", "processPendingDeliveries", "processFailedChatRunRetry", "processFailedChatRunRetries", "processPendingGitHubWebhookIngress", "processFailedGitHubWebhookDeliveries", "processPendingProviderEffects", "processPendingReceiptReactions", "processPendingSlackFileUploadReceipts", "processPendingSlackSessionStops", "processPendingSlackSessionSyncs"] as const;
    for (const name of names) {
      await expect(Promise.resolve().then(() => (service[name] as (...args: unknown[]) => Promise<unknown>)())).rejects.toMatchObject({ code: "startup_work_held", status: 503 });
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("holds all direct email write/recovery entrypoints before any database work", async () => {
    const { db, select } = untouchedDb();
    const service = emailChannelService(db, {} as never);
    for (const name of ["setup", "queueSend", "webhook", "admit", "control", "reconnect", "resolveUncertain"] as const) {
      await expect(Promise.resolve().then(() => (service[name] as (...args: unknown[]) => Promise<unknown>)())).rejects.toMatchObject({ code: "startup_work_held", status: 503 });
    }
    expect(select).not.toHaveBeenCalled();
  });

});
