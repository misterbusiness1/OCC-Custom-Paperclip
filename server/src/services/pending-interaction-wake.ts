import { and, eq } from "drizzle-orm";
import { issueThreadInteractions, type Db, type issues } from "@paperclipai/db";
import { evaluateIssueThreadInteractionResolverAudience } from "./issue-thread-interaction-resolution.js";
import { isIssueReviewVerdictInteraction, resolveIssueReviewRequester } from "./issue-review-policy.js";

export type PendingInteractionWake = "authorized" | "invalid" | null;

/** A review invitation permits responding to its card, never taking task ownership. */
export async function verifyPendingInteractionWake(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    contextSnapshot: Record<string, unknown>;
    issue: Pick<typeof issues.$inferSelect,
      "id" | "companyId" | "status" | "reviewPolicy" | "createdByAgentId" | "createdByUserId">;
  },
): Promise<PendingInteractionWake> {
  const context = input.contextSnapshot;
  // Resource retries replace wakeReason but retain the original source and card.
  if (context.wakeReason !== "interaction_pending" && context.source !== "issue.interaction.created") return null;
  const id = context.interactionId;
  if (context.source !== "issue.interaction.created" || typeof id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    || input.issue.companyId !== input.companyId || context.issueId !== input.issue.id) return "invalid";
  const interaction = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, id),
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issue.id),
    eq(issueThreadInteractions.status, "pending"),
    eq(issueThreadInteractions.addresseeAgentId, input.agentId),
  )).then(rows => rows[0] ?? null);
  if (!interaction) return "invalid";

  let additionalRestriction;
  if (input.issue.status === "in_review"
    && ["request_confirmation", "request_checkbox_confirmation"].includes(interaction.kind)
    && await isIssueReviewVerdictInteraction(db, { issue: input.issue, interaction })) {
    const requester = await resolveIssueReviewRequester(db, input.issue);
    additionalRestriction = {
      policy: input.issue.reviewPolicy ?? "anyone",
      source: "issue_review" as const,
      excludedActor: requester ? { type: requester.type, id: requester.id } : null,
    };
  }
  const payload = interaction.payload;
  const decision = evaluateIssueThreadInteractionResolverAudience({
    actor: { type: "agent", agentId: input.agentId, runId: input.runId },
    interaction,
    additionalRestriction,
    governedAction: interaction.kind === "request_confirmation"
      && (("toolAction" in payload && payload.toolAction !== undefined)
        || ("secretProposal" in payload && payload.secretProposal !== undefined)),
  });
  return decision.allowed ? "authorized" : "invalid";
}
