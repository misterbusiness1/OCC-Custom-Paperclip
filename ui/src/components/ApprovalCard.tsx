import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Identity } from "./Identity";
import {
  approvalDecisionBrief,
  approvalExcerpt,
  approvalSubject,
  OriginalRequestBlock,
  typeLabel,
} from "./ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import type { Approval, Agent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "./StatusBadge";

export function ApprovalCard({
  approval,
  requesterAgent,
  onApprove,
  onReject,
  onOpen,
  detailLink,
  isPending = false,
  pendingAction = null,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  onApprove?: () => void;
  onReject?: () => void;
  onOpen?: () => void;
  detailLink?: string;
  isPending?: boolean;
  pendingAction?: "approve" | "reject" | null;
}) {
  const payload = approval.payload as Record<string, unknown> | null;
  const kindLabel = typeLabel[approval.type] ?? approval.type;
  const subject = approvalExcerpt(approvalSubject(payload), 120);
  const brief = approvalDecisionBrief(payload);
  const recommendation = approvalExcerpt(brief.recommendation, 180);
  const reasoning = approvalExcerpt(brief.reasoning, 220);
  const benefit = approvalExcerpt(brief.pros[0] ?? null, 160);
  const tradeoff = approvalExcerpt(brief.cons[0] ?? null, 160);
  const showMissingDecisionFields = approval.type === "request_board_approval";
  const hasBrief = showMissingDecisionFields || Boolean(recommendation || reasoning || benefit || tradeoff);
  const showResolutionButtons =
    Boolean(onApprove && onReject) &&
    approval.type !== "budget_override_required" &&
    (approval.status === "pending" || approval.status === "revision_requested");
  const hasFooter = showResolutionButtons || Boolean(detailLink || onOpen);

  return (
    <Card className="block border-border/70 p-4">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="border-border/70 px-2 py-0.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground"
          >
            {kindLabel}
          </Badge>
          <StatusBadge status={approval.status} />
        </div>
        <h3 className="text-base font-semibold leading-6 text-foreground">
          {subject ?? kindLabel}
        </h3>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {requesterAgent && (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              Requested by <Identity name={requesterAgent.name} size="sm" className="inline-flex" />
            </span>
          )}
          <span>Created {timeAgo(approval.createdAt)}</span>
        </div>
      </div>

      {hasBrief && (
        <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
          {recommendation && (
            <div>
              <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                Recommendation
              </p>
              <p className="mt-1 text-sm leading-5 text-foreground">{recommendation}</p>
            </div>
          )}
          {showMissingDecisionFields && <OriginalRequestBlock payload={payload} compact />}
          {reasoning && (
            <div>
              <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                Why
              </p>
              <p className="mt-1 text-sm leading-5 text-foreground">{reasoning}</p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {(benefit || showMissingDecisionFields) && (
              <div>
                <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                  Benefit
                </p>
                <p className={cn("mt-1 text-sm leading-5", benefit ? "text-foreground" : "text-muted-foreground")}>
                  {benefit ?? "Not supplied."}
                </p>
              </div>
            )}
            {(tradeoff || showMissingDecisionFields) && (
              <div>
                <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                  Tradeoff
                </p>
                <p className={cn("mt-1 text-sm leading-5", tradeoff ? "text-foreground" : "text-muted-foreground")}>
                  {tradeoff ?? "Not supplied."}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {approval.decisionNote && (
        <div className="mt-4 rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">Decision note.</span> {approval.decisionNote}
        </div>
      )}

      {hasFooter ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {showResolutionButtons && (
              <>
                <Button
                  size="sm"
                  onClick={onApprove}
                  disabled={isPending}
                >
                  {pendingAction === "approve" ? "Approving..." : "Approve"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onReject}
                  disabled={isPending}
                >
                  {pendingAction === "reject" ? "Rejecting..." : "Reject"}
                </Button>
              </>
            )}
          </div>
          {(detailLink || onOpen) ? (
            detailLink ? (
              <Link
                to={detailLink}
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-auto px-2 text-xs text-muted-foreground")}
              >
                View details
              </Link>
            ) : (
              <Button variant="ghost" size="sm" className="h-auto px-2 text-xs text-muted-foreground" onClick={onOpen}>
                View details
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
