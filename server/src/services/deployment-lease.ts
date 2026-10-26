import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { z } from "zod";
import {
  deploymentLeasePermitSchema, deploymentLeaseAcquireSchema, deploymentLeaseAdoptSchema, deploymentLeaseRenewSchema,
  type DeploymentLeasePermit, type DeploymentLeaseStatus,
} from "@paperclipai/shared";
export { deploymentLeasePermitSchema } from "@paperclipai/shared";
export type { DeploymentLeasePermit, DeploymentLeaseStatus } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { startupWorkBarrier } from "./startup-work-barrier.js";

const KEY = "deployment-drain/v1";
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const generationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const stateSchema = z.object({
  v: z.literal(1), generation: generationSchema, tokenHash: tokenSchema.nullable(),
  ownerBootId: z.string().uuid().nullable(), startedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(), draining: z.boolean(),
  drainStartedAt: z.string().datetime().nullable(),
}).strict();
type State = z.infer<typeof stateSchema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReadDb = Pick<Db | Tx, "select">;
export type DeploymentLeaseAudit = (tx: Tx, event: string, status: DeploymentLeaseStatus) => Promise<void>;
const empty = (): State => ({ v: 1, generation: 0, tokenHash: null, ownerBootId: null,
  startedAt: null, expiresAt: null, draining: false, drainStartedAt: null });
function fail(code: string): never { throw new HttpError(409, code, { code }); }
function parse(raw: unknown): State {
  const value = stateSchema.safeParse(raw);
  if (!value.success) throw new HttpError(503, "deployment_lease_state_invalid");
  const s = value.data;
  if ((s.tokenHash === null) !== (s.ownerBootId === null && s.startedAt === null && s.expiresAt === null)
    || (s.tokenHash !== null && (!s.ownerBootId || !s.startedAt || !s.expiresAt))
    || (s.draining !== (s.drainStartedAt !== null)) || (s.draining && !s.tokenHash)) {
    throw new HttpError(503, "deployment_lease_state_invalid");
  }
  return s;
}
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** A private singleton, never the public/default settings row. Expiry never clears a drain. */
export function deploymentLeaseService(db: Db, options: { bootId?: string } = {}) {
  const bootId = options.bootId ?? startupWorkBarrier.snapshot().bootId;
  const status = (s: State, now: Date): DeploymentLeaseStatus => ({ protocolVersion: 1,
    generation: s.generation, bootId, ownerBootId: s.ownerBootId, owned: s.tokenHash !== null,
    expired: s.expiresAt !== null && Date.parse(s.expiresAt) <= now.getTime(),
    startedAt: s.startedAt, expiresAt: s.expiresAt, draining: s.draining, drainStartedAt: s.drainStartedAt });
  async function clock(source: Pick<Db | Tx, "execute">): Promise<Date> {
    const rows = await source.execute(sql`select clock_timestamp() as now`);
    const value = rows[0]?.now;
    const now = value instanceof Date ? value : new Date(value as string);
    if (!Number.isFinite(now.getTime())) throw new HttpError(503, "deployment_lease_clock_unavailable");
    return now;
  }
  async function read(source: ReadDb): Promise<State> {
    const rows = await source.select({ general: instanceSettings.general }).from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, KEY)).limit(1);
    return rows.length ? parse(rows[0].general) : empty();
  }
  async function locked<T>(run: (tx: Tx, state: State, now: Date) => Promise<T>): Promise<T> {
    return db.transaction(async tx => {
      await tx.insert(instanceSettings).values({ singletonKey: KEY, general: empty() })
        .onConflictDoNothing({ target: instanceSettings.singletonKey });
      const rows = await tx.select({ general: instanceSettings.general }).from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, KEY)).for("update");
      return run(tx, parse(rows[0]?.general), await clock(tx));
    });
  }
  async function write(tx: Tx, next: State) {
    // Validate before storage as well; malformed durable state must never fail open.
    await tx.update(instanceSettings).set({ general: parse(next), updatedAt: sql`clock_timestamp()` })
      .where(eq(instanceSettings.singletonKey, KEY));
  }
  function checkGeneration(s: State, expected: number) {
    if (s.generation !== expected) fail("deployment_lease_generation_mismatch");
  }
  function checkBoot(expected: string) {
    if (expected !== bootId) fail("deployment_lease_boot_mismatch");
  }
  function checkOwner(s: State, input: DeploymentLeasePermit, now: Date, adopting = false) {
    checkBoot(input.expectedBootId); checkGeneration(s, input.expectedLeaseGeneration);
    if (!s.tokenHash || !s.expiresAt) fail("deployment_lease_required");
    if (Date.parse(s.expiresAt) <= now.getTime()) fail("deployment_lease_expired");
    if (!timingSafeEqual(Buffer.from(s.tokenHash, "hex"), Buffer.from(tokenHash(input.ownerToken), "hex"))) {
      fail("deployment_lease_owner_mismatch");
    }
    if (!adopting && s.ownerBootId !== bootId) fail("deployment_lease_adoption_required");
  }
  async function auditWrite(tx: Tx, event: string, next: State, now: Date, audit?: DeploymentLeaseAudit) {
    const snap = status(next, now);
    await audit?.(tx, event, snap);
    await write(tx, next);
    return snap;
  }
  return {
    async get(): Promise<DeploymentLeaseStatus> { return status(await read(db), await clock(db)); },
    async isDraining(): Promise<boolean> { return (await read(db)).draining; },
    async acquire(raw: unknown, audit?: DeploymentLeaseAudit) {
      const input = deploymentLeaseAcquireSchema.parse(raw);
      return locked(async (tx, s, now) => {
        checkBoot(input.expectedBootId); checkGeneration(s, input.expectedLeaseGeneration);
        if (s.tokenHash && (!s.expiresAt || Date.parse(s.expiresAt) > now.getTime())) fail("deployment_lease_owned");
        if (s.tokenHash && !input.takeOverExpired) fail("deployment_lease_takeover_required");
        const ownerToken = randomBytes(32).toString("hex");
        const next: State = { ...s, generation: s.generation + 1, tokenHash: tokenHash(ownerToken), ownerBootId: bootId,
          startedAt: now.toISOString(), expiresAt: new Date(now.getTime() + input.ttlMs).toISOString() };
        const result = await auditWrite(tx, s.tokenHash ? "taken_over" : "acquired", next, now, audit);
        return { ...result, ownerToken };
      });
    },
    async adopt(raw: unknown, audit?: DeploymentLeaseAudit) {
      const input = deploymentLeaseAdoptSchema.parse(raw);
      return locked(async (tx, s, now) => {
        checkOwner(s, input, now, true);
        if (s.ownerBootId !== input.expectedOwnerBootId || s.ownerBootId === bootId) fail("deployment_lease_owner_boot_mismatch");
        return auditWrite(tx, "adopted", { ...s, ownerBootId: bootId, generation: s.generation + 1 }, now, audit);
      });
    },
    async renew(raw: unknown, audit?: DeploymentLeaseAudit) {
      const input = deploymentLeaseRenewSchema.parse(raw);
      return locked(async (tx, s, now) => {
        checkOwner(s, input, now);
        return auditWrite(tx, "renewed", { ...s, generation: s.generation + 1,
          expiresAt: new Date(now.getTime() + input.ttlMs).toISOString() }, now, audit);
      });
    },
    async release(raw: unknown, audit?: DeploymentLeaseAudit) {
      const input = deploymentLeasePermitSchema.parse(raw);
      return locked(async (tx, s, now) => {
        checkOwner(s, input, now);
        if (s.draining) fail("deployment_lease_drain_active");
        return auditWrite(tx, "released", { ...empty(), generation: s.generation + 1 }, now, audit);
      });
    },
    async transitionDrain<T>(rawPermit: unknown, draining: boolean,
      run: (tx: Tx, lease: DeploymentLeaseStatus | null, prior: DeploymentLeaseStatus | null) => Promise<T>): Promise<{ result: T; lease: DeploymentLeaseStatus | null }> {
      return locked(async (tx, s, now) => {
        // Legacy maintenance drains remain compatible only in the complete absence
        // of an owned lease. Even an expired owner retains its drain and fence.
        if (!s.tokenHash) {
          if (rawPermit !== undefined) fail("deployment_lease_required");
          return { result: await run(tx, null, null), lease: null };
        }
        if (rawPermit === undefined) fail("deployment_lease_required");
        const input = deploymentLeasePermitSchema.parse(rawPermit); checkOwner(s, input, now);
        const next = { ...s, generation: s.generation + 1, draining,
          drainStartedAt: draining ? s.drainStartedAt ?? now.toISOString() : null };
        const snap = status(next, now); const result = await run(tx, snap, status(s, now));
        await write(tx, next);
        return { result, lease: snap };
      });
    },
    async withOwner<T>(raw: unknown, run: () => T, options: { requireDraining?: boolean; audit?: DeploymentLeaseAudit } = {}): Promise<T> {
      const input = deploymentLeasePermitSchema.parse(raw);
      return locked(async (tx, s, now) => {
        checkOwner(s, input, now);
        if (options.requireDraining && !s.draining) fail("deployment_lease_drain_required");
        await options.audit?.(tx, "released", status(s, now));
        return run();
      });
    },
  };
}
