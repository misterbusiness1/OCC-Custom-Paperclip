import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCodexProviderAccountKey } from "@paperclipai/adapter-codex-local/server";
import {
  agents, agentWakeupRequests, authUsers, companies, companyMemberships,
  completionContracts, createDb, heartbeatRuns, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { environmentService } from "../services/environments.js";
import { heartbeatService } from "../services/heartbeat.js";
import { nativeCompletionFeedback } from "../services/native-runtime/native-completion-feedback.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import {
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
} from "../vendor/paperclip-runner/testing.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("native review provider admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService> | undefined;
  let adapterCalls = 0;
  let backendCalls = 0;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-review-admission-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-native-review-admission-"));
    registerServerAdapter({
      type: "codex_local",
      execute: async () => {
        adapterCalls++;
        throw new Error("This claim test must not execute an adapter");
      },
      testEnvironment: async () => ({ adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter("codex_local");
    if (root) await fs.rm(root, { recursive: true, force: true });
    await database?.cleanup();
  });

  it("holds a fresh review during a provider wait, then commits probe provenance without changing its worker assignee", async () => {
    const companyId = randomUUID(), workerId = randomUUID(), reviewerId = randomUUID();
    const issueId = randomUUID(), sourceRunId = randomUUID(), contractId = randomUUID();
    const sessionId = randomUUID(), runnerInstanceId = randomUUID(), reviewRunId = randomUUID();
    const responsibleUserId = randomUUID();
    const accountId = "synthetic-native-review-account";
    const providerAccountKey = createCodexProviderAccountKey(companyId, accountId);
    const home = path.join(root, "reviewer-codex");
    await fs.mkdir(home, { mode: 0o700 });
    await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({
      tokens: { account_id: accountId, access_token: "synthetic-not-a-provider-credential" },
    }), { mode: 0o600 });
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Review owner", email: `${responsibleUserId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Native review admission", issuePrefix: "NRA", defaultResponsibleUserId: responsibleUserId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: responsibleUserId, status: "active", membershipRole: "member" });
    await environmentService(db).ensureLocalEnvironment(companyId);
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Original worker", adapterType: "codex_local", status: "idle" },
      { id: reviewerId, companyId, name: "Review lead", adapterType: "codex_local", status: "idle",
        adapterConfig: { agentCommand: "node ./synthetic-acp.js", stateDir: path.join(root, "state"), env: { CODEX_HOME: home, OPENAI_API_KEY: "" } },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Review completed work", status: "in_progress", assigneeAgentId: workerId, responsibleUserId, workMode: "standard" });
    await db.insert(completionContracts).values({
      id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "phase6-v1", objective: "Review", criteria: [{ id: "objective", requirement: "Review" }] },
      canonicalSha256: "native-review-admission-contract", createdByActorType: "system", createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: workerId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: sessionId, runnerInstanceId,
      completionContractId: contractId, completionContractSha256: "native-review-admission-contract", contextSnapshot: { issueId },
    });
    // Generate the applied decision, pending interaction, and durable wake through
    // the real completion/finalization path rather than fabricating review facts.
    const port = new PaperclipControlPlanePort(db, {
      companyId, issueId, runId: sourceRunId, agentId: workerId, sessionId,
      completionContractId: contractId, completionContractSha256: "native-review-admission-contract",
      sourceInstanceId: runnerInstanceId, controlPlaneSourceInstanceId: "native-review-admission-control",
    });
    await port.openRun({ identity: { companyId, issueId, runId: sourceRunId, agentId: workerId, sessionId }, backendKind: "mock", sourceInstanceId: runnerInstanceId });
    const result = {
      ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: "phase6-v1" },
      reportedWorkDisposition: "needs_review" as const,
      attentionRequests: [{ kind: "review" as const, summary: "Review the completed work", ownerClass: "agent" as const, targetAgentId: reviewerId }],
    };
    await expect(nativeCompletionFeedback(db, sourceRunId, result)).resolves.toContain("Completion report accepted");
    await port.completeRun({ result, terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, reportedWorkDisposition: "needs_review" }, callerResultId: "native-review-admission-result" });
    await finalizeNativeRun({ db, runId: sourceRunId, workspaceFinalizeStatus: "succeeded" });
    const [interaction] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.issueId, issueId), eq(issueThreadInteractions.addresseeAgentId, reviewerId)));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, reviewerId));
    expect(interaction).toMatchObject({ status: "pending", kind: "request_confirmation", sourceRunId });
    expect(wake).toMatchObject({ status: "queued", reason: "native_completion_review" });
    const nativeReviewDecisionId = (interaction.payload as { target: { revisionId: string } }).target.revisionId;
    await db.insert(heartbeatRuns).values({
      id: reviewRunId, companyId, agentId: reviewerId, status: "queued", runtimeMode: "native", nativeIssueId: issueId,
      invocationSource: "automation", triggerDetail: "system", wakeupRequestId: wake.id,
      contextSnapshot: { issueId, wakeReason: "native_completion_review", nativeReviewInteractionId: interaction.id, nativeReviewDecisionId },
    });
    await db.update(agentWakeupRequests).set({ runId: reviewRunId }).where(eq(agentWakeupRequests.id, wake.id));
    const [failure] = await db.insert(heartbeatRuns).values({
      companyId, agentId: reviewerId, status: "failed", startedAt: new Date(Date.now() - 2000), finishedAt: new Date(Date.now() - 1000),
      errorCode: "codex_transient_upstream", resultJson: { errorFamily: "transient_upstream", providerHttpStatus: 429, retryNotBefore: new Date(Date.now() + 60_000).toISOString() },
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local", providerAccountKey } },
    }).returning();
    let releasePreparation!: () => void;
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
    let preparationCalls = 0;
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      beforeProviderScopePreparation: async runId => {
        expect(runId).toBe(reviewRunId);
        preparationCalls++;
        await preparation;
      },
      nativeSessionBackendFactory: () => {
        backendCalls++;
        throw new Error("This claim test must not create a native backend");
      },
    });
    try {
      await heartbeat.resumeQueuedRuns();
      expect(await heartbeat.getRun(reviewRunId)).toMatchObject({ status: "queued", startedAt: null, activeIdentityContextId: null });
      const [waitingWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      const [waitingIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(waitingWake).toMatchObject({ status: "queued", claimedAt: null });
      expect(waitingIssue).toMatchObject({ status: "in_review", assigneeAgentId: workerId, executionRunId: null });
      expect(preparationCalls).toBe(0);

      await db.update(heartbeatRuns).set({ resultJson: { ...failure.resultJson, retryNotBefore: new Date(Date.now() - 1000).toISOString() } }).where(eq(heartbeatRuns.id, failure.id));
      await heartbeat.resumeQueuedRuns();
      await vi.waitFor(() => expect(preparationCalls).toBe(1), { timeout: 10_000 });
      const claimed = await heartbeat.getRun(reviewRunId);
      expect(claimed).toMatchObject({ status: "running", runnerProfileJson: { adapterDispatch: {
        providerAdmissionScopeKind: "account", providerAccountKey, providerAccountRecoveryOf: failure.id, providerAgentRecoveryOf: null,
      } } });
      const [claimedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      const [claimedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(claimedWake).toMatchObject({ status: "claimed", runId: reviewRunId });
      expect(claimedWake.claimedAt).toBeInstanceOf(Date);
      expect(claimedIssue).toMatchObject({ status: "in_review", assigneeAgentId: workerId, executionRunId: reviewRunId, executionAgentNameKey: "review lead" });
      expect(adapterCalls).toBe(0);
      expect(backendCalls).toBe(0);
    } finally {
      // Cancel while the provider-preparation barrier is held. Its following
      // conditional stamp cannot retain ownership, so no native turn can start.
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(heartbeatRuns.id, reviewRunId), inArray(heartbeatRuns.status, ["queued", "running"])));
      await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, wake.id));
      releasePreparation();
      await heartbeat.drainActiveRunExecutions();
      expect(adapterCalls).toBe(0);
      expect(backendCalls).toBe(0);
    }
  }, 30_000);
});
