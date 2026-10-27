import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { environmentLeaseFailureReason } from "../services/environment-lease-failure-reason.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("environment lease failure categories", () => {
  it.each(["acpx_turn_failed", "codex_transient_upstream", "process_lost", "setup_failed"])("retains known causal code %s", errorCode => {
    expect(environmentLeaseFailureReason({ status: "failed", errorCode })).toBe(errorCode);
  });
  it.each(["provider rejected Bearer synthetic-sensitive-value", "sk_synthetic_token_123", "unknown_provider_error", "", null])("never copies an unapproved error code: %s", errorCode => {
    expect(environmentLeaseFailureReason({ status: "failed", errorCode })).toBe("run_failed");
  });
  it.each([["timed_out", "run_timed_out"], ["cancelled", "run_cancelled"], ["interrupted", "run_interrupted"]])("uses a stable %s fallback", (status, reason) => {
    expect(environmentLeaseFailureReason({ status, errorCode: "unknown" })).toBe(reason);
  });
  it("handles missing durable run metadata without inventing a provider cause", () => {
    expect(environmentLeaseFailureReason(null)).toBe("run_failed");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("failed local and SSH lease release", () => {
  let db!: ReturnType<typeof createDb>;
  let stop: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const fixture = await startEmbeddedPostgresTestDatabase("lease-failure-cause");
    db = createDb(fixture.connectionString);
    stop = fixture.stop;
  });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(environments).where(eq(environments.driver, "ssh"));
  });
  afterAll(async () => { await stop?.(); });

  async function seed(driver: "local" | "ssh", status: (typeof heartbeatRuns.$inferInsert)["status"], errorCode: string | null) {
    const [company] = await db.insert(companies).values({ name: `Lease cause ${randomUUID()}`, issuePrefix: `LC${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Cause fixture", role: "engineer", adapterType: "process" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, invocationSource: "manual", runtimeMode: "legacy", status, errorCode }).returning();
    const existing = driver === "local" ? await db.query.environments.findFirst({ where: eq(environments.driver, "local") }) : null;
    const environment = existing ?? (await db.insert(environments).values({ name: `Cause fixture ${randomUUID()}`, driver, status: "active", config: {} }).returning())[0];
    const lease = await environmentService(db).acquireLease({ companyId: company.id, environmentId: environment.id, heartbeatRunId: run.id, provider: driver, leasePolicy: "ephemeral", metadata: { driver } });
    return { company, run, lease };
  }

  for (const driver of ["local", "ssh"] as const) {
    it(`${driver} retains the durable cause through heartbeat recovery and the real orchestrator`, async () => {
      const { run, lease } = await seed(driver, "failed", "acpx_turn_failed");
      const result = await heartbeatService(db).reconcileTerminalEnvironmentLeases();
      expect(result).toMatchObject({ released: 1, failed: 0, runIds: [run.id] });
      const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(row).toMatchObject({ status: "failed", failureReason: "acpx_turn_failed" });
    });
    it.each(["acpx_turn_failed", "codex_transient_upstream"])(`${driver} persists causal run code %s`, async errorCode => {
      const { run, lease } = await seed(driver, "failed", errorCode);
      const released = await environmentRuntimeService(db).releaseRunLeases(run.id, "failed");
      expect(released).toHaveLength(1);
      const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(row).toMatchObject({ status: "failed", failureReason: errorCode });
      expect(row.releasedAt).toBeInstanceOf(Date);
    });
    it(`${driver} replaces unsafe provider text with a stable category`, async () => {
      const secretLike = "Bearer synthetic-private-provider-value";
      const { run, lease } = await seed(driver, "failed", secretLike);
      await environmentRuntimeService(db).releaseRunLeases(run.id, "failed");
      const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(row.failureReason).toBe("run_failed");
      expect(JSON.stringify(row)).not.toContain(secretLike);
    });
    it(`${driver} does not manufacture a failure on successful release`, async () => {
      const { run, lease } = await seed(driver, "succeeded", null);
      await environmentRuntimeService(db).releaseRunLeases(run.id, "released");
      const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(row).toMatchObject({ status: "released", failureReason: null });
    });
    it(`${driver} uses the durable timed-out status when no safe error code exists`, async () => {
      const { run, lease } = await seed(driver, "timed_out", null);
      await environmentRuntimeService(db).releaseRunLeases(run.id, "failed");
      const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(row.failureReason).toBe("run_timed_out");
    });
  }
});
