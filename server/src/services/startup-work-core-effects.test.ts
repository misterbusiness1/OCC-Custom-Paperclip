import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const state = vi.hoisted(() => ({ barrier: null as any }));
vi.mock("./startup-work-barrier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./startup-work-barrier.js")>();
  return {
    ...actual,
    isStartupWorkHeld: () => state.barrier.isHeld(),
    assertStartupWorkAllowed: () => state.barrier.assertWorkAllowed(),
  };
});

import { createStartupWorkBarrier } from "./startup-work-barrier.js";
import { routineService } from "./routines.js";
import { toolActionDeliveryService } from "./tool-action-delivery.js";
import { externalObjectService } from "./external-objects.js";

// Exercise real service entrypoints and the real barrier state machine. A DB
// entry could claim queued work or write a receipt before qualification.
const databaseReached = new Error("database reached after release");
let touchDatabase: ReturnType<typeof vi.fn>;
let wakeup: ReturnType<typeof vi.fn>;
let enabled: ReturnType<typeof vi.fn<() => boolean>>;
let routines: ReturnType<typeof routineService>;
let deliveries: ReturnType<typeof toolActionDeliveryService>;
let objects: ReturnType<typeof externalObjectService>;

beforeEach(() => {
  state.barrier = createStartupWorkBarrier({ PAPERCLIP_STARTUP_WORK_HELD: "true" });
  touchDatabase = vi.fn(() => { throw databaseReached; });
  wakeup = vi.fn();
  enabled = vi.fn(() => true);
  const db = { select: touchDatabase, transaction: touchDatabase } as unknown as Db;
  routines = routineService(db, { heartbeat: { wakeup } as any });
  deliveries = toolActionDeliveryService(db, { wakeup } as any);
  objects = externalObjectService(db, { github: false, enabled });
});

const directCases = [
  ["manual routine", () => routines.runRoutine("routine", { source: "manual" } as any)],
  ["pipeline routine", () => routines.runPipelineStageEntryRoutine("routine", { source: "api" } as any)],
  ["public webhook routine", () => routines.firePublicTrigger("public-trigger", {})],
  ["tool result delivery", () => deliveries.deliver("action")],
  ["external object refresh", () => objects.refreshObject("object", { companyId: "company" })],
  ["issue object refresh", () => objects.refreshIssueObjects("issue", { companyId: "company" })],
] as const;

describe("startup hold at business service boundaries", () => {
  it.each(directCases)("rejects %s before DB/provider/agent access", async (_name, action) => {
    await expect(action()).rejects.toMatchObject({ code: "startup_work_held" });
    expect(touchDatabase).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
    expect(enabled).not.toHaveBeenCalled();
  });

  it("leaves scheduled work untouched without claiming or acknowledging it", async () => {
    expect(await routines.tickScheduledTriggers()).toEqual({ triggered: 0 });
    expect(await deliveries.sweepPending()).toEqual({ scanned: 0, delivered: 0 });
    expect(await objects.refreshDueObjects("company")).toEqual([]);
    expect(await objects.refreshDueObjectsForActiveCompanies()).toEqual({ companies: 0, checked: 0, refreshed: 0 });
    expect(touchDatabase).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
    expect(enabled).not.toHaveBeenCalled();
  });

  it.each(directCases)("allows %s to reach its normal DB path after same-boot release", async (_name, action) => {
    const snapshot = state.barrier.snapshot();
    state.barrier.release({ expectedBootId: snapshot.bootId, expectedGeneration: snapshot.generation, qualificationSha256: "a".repeat(64) });
    await expect(action()).rejects.toBe(databaseReached);
    expect(touchDatabase).toHaveBeenCalledOnce();
  });
});
