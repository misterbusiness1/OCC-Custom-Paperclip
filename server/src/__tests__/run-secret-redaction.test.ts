import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import type { Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { createRunSecretRedactionRegistry, redactRegisteredSecretValues } from "../services/run-secret-redaction.js";

const secret = "q2a-exact-secret-value";

describe("registered run secret redaction", () => {
  it("redacts exact values across comment and heartbeat/wake projections", () => {
    const result = redactRegisteredSecretValues({
      comment: { body: `agent pasted ${secret} in a comment` },
      heartbeatContext: {
        issue: { description: `do not expose ${secret}` },
        wakeComment: { body: secret },
      },
      wakePayload: {
        comments: [{ body: `prefix-${secret}-suffix` }],
        continuationSummary: { body: secret },
      },
    }, [secret]);

    expect(result).toEqual({
      comment: { body: `agent pasted ${REDACTED_EVENT_VALUE} in a comment` },
      heartbeatContext: {
        issue: { description: `do not expose ${REDACTED_EVENT_VALUE}` },
        wakeComment: { body: REDACTED_EVENT_VALUE },
      },
      wakePayload: {
        comments: [{ body: `prefix-${REDACTED_EVENT_VALUE}-suffix` }],
        continuationSummary: { body: REDACTED_EVENT_VALUE },
      },
    });
  });

  it("redacts run detail, event, and transcript fields and strips registry material", () => {
    const result = redactRegisteredSecretValues({
      contextSnapshot: {
        issueId: "issue-1",
        paperclipSecretRedactions: [{ material: { ciphertext: "encrypted" } }],
      },
      stdoutExcerpt: `stdout ${secret}`,
      events: [{ message: secret, payload: { output: secret } }],
      log: { content: `tool returned ${secret}` },
    }, [secret]);

    expect(result).toEqual({
      contextSnapshot: { issueId: "issue-1" },
      stdoutExcerpt: `stdout ${REDACTED_EVENT_VALUE}`,
      events: [{ message: REDACTED_EVENT_VALUE, payload: { output: REDACTED_EVENT_VALUE } }],
      log: { content: `tool returned ${REDACTED_EVENT_VALUE}` },
    });
  });

  it("replaces longer registered values before overlapping shorter values", () => {
    expect(redactRegisteredSecretValues("token-extended token", ["token-extended", "token"]))
      .toBe(`${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE}`);
  });

  it("preserves Date instances instead of collapsing them to empty objects (PAP-16607)", () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    const result = redactRegisteredSecretValues({
      comment: { body: `agent pasted ${secret}`, createdAt, updatedAt: createdAt },
      nested: [{ finishedAt: createdAt }],
    }, [secret]);

    expect(result.comment.createdAt).toBeInstanceOf(Date);
    expect(result.comment.createdAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
    expect(result.comment.updatedAt).toBeInstanceOf(Date);
    expect(result.nested[0]?.finishedAt).toBeInstanceOf(Date);
    expect(result.comment.body).toBe(`agent pasted ${REDACTED_EVENT_VALUE}`);
  });

  it("preserves Date instances when no secret values are registered", () => {
    const createdAt = new Date("2026-08-06T12:00:00.000Z");
    const result = redactRegisteredSecretValues({ createdAt }, []);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.toISOString()).toBe("2026-08-06T12:00:00.000Z");
  });
});

const { resolveVersion } = vi.hoisted(() => ({ resolveVersion: vi.fn(async ({ material }) => material.value as string) }));
vi.mock("../secrets/provider-registry.js", () => ({ getSecretProvider: () => ({ resolveVersion }) }));

describe("batched run secret redaction", () => {
  beforeEach(() => { resolveVersion.mockReset().mockImplementation(async ({ material }) => material.value as string); });

  function fixture(rows: unknown[]) {
    const where = vi.fn(async (_predicate: import("drizzle-orm").SQL | undefined) => rows);
    const select = vi.fn((_columns: { contextSnapshot: import("drizzle-orm").SQL }) => ({ from: () => ({ where }) }));
    return { registry: createRunSecretRedactionRegistry({ select } as unknown as Db), select, where };
  }

  it("reads only registry JSON once for 200 runs and resolves shared secrets once", async () => {
    const contextSnapshot = { paperclipSecretRedactions: [{ fingerprintSha256: "shared", material: { value: secret } }] };
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `run-${i}`, contextSnapshot }));
    const { registry, select, where } = fixture(rows);
    const result = await registry.redactForRuns("company-1", rows.map(row => ({ ...row, stdoutExcerpt: secret })));
    expect(select).toHaveBeenCalledTimes(1);
    expect(resolveVersion).toHaveBeenCalledTimes(1);
    expect(result.every(run => run.stdoutExcerpt === REDACTED_EVENT_VALUE)).toBe(true);
    expect(result[0].contextSnapshot).toEqual({});
    const dialect = new PgDialect();
    const predicate = dialect.sqlToQuery(where.mock.calls[0][0]);
    expect(predicate.params).toContain("company-1");
    expect(predicate.sql).toContain('"company_id"');
    expect(dialect.sqlToQuery(select.mock.calls[0][0].contextSnapshot).sql).toContain("-> 'paperclipSecretRedactions'");
  });

  it("keeps each run's registry separate and observes new registrations on the next request", async () => {
    const rows = [{ id: "a", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "one", material: { value: secret } }] } }];
    const { registry } = fixture(rows);
    expect(await registry.redactForRuns("company", [{ id: "a", text: secret }, { id: "b", text: secret }]))
      .toEqual([{ id: "a", text: REDACTED_EVENT_VALUE }, { id: "b", text: secret }]);
    rows[0].contextSnapshot.paperclipSecretRedactions.push({ fingerprintSha256: "two", material: { value: "new-secret" } });
    expect(await registry.redactForRuns("company", [{ id: "a", text: "new-secret" }]))
      .toEqual([{ id: "a", text: REDACTED_EVENT_VALUE }]);
  });

  it("does not query for an empty list and fails closed on decryption failure", async () => {
    const { registry, select } = fixture([{ id: "a", contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: "one", material: {} }] } }]);
    expect(await registry.redactForRuns("company", [])).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    resolveVersion.mockRejectedValueOnce(new Error("unavailable"));
    await expect(registry.redactForRuns("company", [{ id: "a", text: secret }])).rejects.toThrow("unavailable");
  });

  it("redacts a full company history beyond SQL compiler and driver parameter limits", async () => {
    const companyId = "a07c1334-f3d6-446e-9aab-349cca2e5a9a";
    const createdAt = new Date("2026-10-01T04:00:00.000Z");
    const runs = Array.from({ length: 130_001 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
      text: secret,
      createdAt,
    }));
    const registeredIds = new Set([runs[0].id, runs[1_000].id, runs.at(-1)!.id]);
    const dialect = new PgDialect();
    const queriedIds: string[] = [];
    const where = vi.fn(async (predicate: import("drizzle-orm").SQL) => {
      // Compile the real predicate: the former unbounded IN query throws here
      // before PostgreSQL can execute it on production-sized company histories.
      const query = dialect.sqlToQuery(predicate);
      expect(query.sql).toContain('"company_id"');
      expect(query.params[0]).toBe(companyId);
      expect(query.params.length).toBeLessThanOrEqual(1_001);
      const ids = query.params.slice(1) as string[];
      for (const id of ids) queriedIds.push(id);
      return ids.map(id => ({
        id,
        contextSnapshot: registeredIds.has(id)
          ? { paperclipSecretRedactions: [{ fingerprintSha256: "shared", material: { value: secret } }] }
          : null,
      }));
    });
    const select = vi.fn(() => ({ from: () => ({ where }) }));
    const registry = createRunSecretRedactionRegistry({ select } as unknown as Db);
    const input = [...runs, runs[0]];
    const result = await registry.redactForRuns(companyId, input);

    expect(queriedIds).toEqual(runs.map(run => run.id));
    expect(result).toHaveLength(input.length);
    expect(result.map(run => run.id)).toEqual(input.map(run => run.id));
    expect(result.every(run => run.createdAt === createdAt)).toBe(true);
    expect(result.every(run => run.text === (registeredIds.has(run.id) ? REDACTED_EVENT_VALUE : secret))).toBe(true);
    expect(resolveVersion).toHaveBeenCalledTimes(1);
    expect(where.mock.calls.length).toBeGreaterThan(1);
  });

  it.each(["lookup", "decryption"] as const)("fails closed when a later batch has a %s failure", async (failure) => {
    const runs = Array.from({ length: 1_001 }, (_, i) => ({ id: `run-${i}`, text: secret }));
    const dialect = new PgDialect();
    const where = vi.fn(async (predicate: import("drizzle-orm").SQL) => {
      const ids = dialect.sqlToQuery(predicate).params.slice(1) as string[];
      if (ids.includes("run-1000") && failure === "lookup") throw new Error("lookup unavailable");
      return ids.map(id => ({
        id,
        contextSnapshot: { paperclipSecretRedactions: [{ fingerprintSha256: id, material: { value: secret, fail: id === "run-1000" } }] },
      }));
    });
    resolveVersion.mockImplementation(async ({ material }) => {
      if (material.fail && failure === "decryption") throw new Error("decryption unavailable");
      return material.value as string;
    });
    const select = vi.fn(() => ({ from: () => ({ where }) }));
    const registry = createRunSecretRedactionRegistry({ select } as unknown as Db);
    await expect(registry.redactForRuns("company", runs)).rejects.toThrow(`${failure} unavailable`);
    expect(where).toHaveBeenCalledTimes(2);
    expect(runs.every(run => run.text === secret)).toBe(true);
  });
});
