import type { Approval } from "@paperclipai/shared";

/** Navigation only. The separate owner service authenticates and re-reads the email. */
export function ownerEmailReviewUrl(
  approval: Pick<Approval, "id" | "companyId" | "status" | "requestedByAgentId" | "payload">,
  config: { origin?: string; companyId?: string; requesterIds?: string },
  appOrigin: string,
): string | null {
  if (!config.origin || !config.companyId || !config.requesterIds
      || approval.companyId !== config.companyId || approval.status !== "approved"
      || !approval.requestedByAgentId
      || !config.requesterIds.split(",").map((id) => id.trim()).includes(approval.requestedByAgentId)
      || typeof approval.payload.channel !== "string"
      || !/^email(?:\b|$)/i.test(approval.payload.channel.trim())) return null;
  try {
    const target = new URL(config.origin);
    if (target.protocol !== "https:" || target.hostname === new URL(appOrigin).hostname
        || target.username || target.password || target.pathname !== "/"
        || target.search || target.hash) return null;
    target.searchParams.set("approvalId", approval.id);
    return target.toString();
  } catch {
    return null;
  }
}
