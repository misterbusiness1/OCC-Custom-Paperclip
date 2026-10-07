import { useRef, type KeyboardEvent } from "react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Identity } from "./Identity";
import {
  approvalExcerpt,
  approvalMissingSourceNote,
  approvalSubject,
  isEmailReplyPayload,
  typeLabel,
} from "./ApprovalPayload";
import {
  ApprovalDecisionSummary,
  useApprovalDraftGate,
  type ApprovalAgentNameResolver,
} from "./ApprovalDecisionSummary";
import {
  ApprovalDecisionActions,
  type ApprovalDecisionActionsHandle,
  type ApprovalPendingAction,
} from "./ApprovalDecisionActions";
import { timeAgo } from "../lib/timeAgo";
import { isKeyboardShortcutTextInputTarget } from "../lib/keyboardShortcuts";
import type { Approval, Agent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "./StatusBadge";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A request the board has left this long is called out in the header. */
const LONG_WAIT_DAYS = 7;

export type ApprovalCardLinkedIssue = {
  id: string;
  identifier?: string | null;
  title?: string | null;
};

function waitingLabel(createdAt: Date | string): { label: string; long: boolean } {
  const elapsed = Date.now() - new Date(createdAt).getTime();
  if (elapsed < HOUR_MS) return { label: "Waiting under an hour", long: false };
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return { label: `Waiting ${hours} ${hours === 1 ? "hour" : "hours"}`, long: false };
  }
  const days = Math.floor(elapsed / DAY_MS);
  return { label: `Waiting ${days} ${days === 1 ? "day" : "days"}`, long: days >= LONG_WAIT_DAYS };
}

export function ApprovalCard({
  approval,
  requesterAgent,
  onApprove,
  onReject,
  onRequestRevision,
  onOpen,
  detailLink,
  isPending = false,
  pendingAction = null,
  linkedIssues,
  enableShortcuts = false,
  resolveAgentName,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  onApprove?: (note?: string) => void;
  onReject?: (note?: string) => void;
  onRequestRevision?: (note: string) => void;
  onOpen?: () => void;
  detailLink?: string;
  isPending?: boolean;
  pendingAction?: ApprovalPendingAction;
  linkedIssues?: ApprovalCardLinkedIssue[];
  /** Shift+A approves, Shift+C asks for changes and Shift+X rejects while the card has focus. */
  enableShortcuts?: boolean;
  /** Lets a hire request name the manager the new agent reports to. */
  resolveAgentName?: ApprovalAgentNameResolver;
}) {
  const actionsRef = useRef<ApprovalDecisionActionsHandle>(null);
  const payload = approval.payload as Record<string, unknown> | null;
  const kindLabel = typeLabel[approval.type] ?? approval.type;
  const subject = approvalExcerpt(approvalSubject(payload, approval.type), 120);
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const showResolutionButtons =
    Boolean(onApprove && onReject) &&
    approval.type !== "budget_override_required" &&
    isActionable;
  const hasFooter = showResolutionButtons || Boolean(detailLink || onOpen);
  const waiting = isActionable ? waitingLabel(approval.createdAt) : null;
  const isEmailReply = approval.type === "request_board_approval" && isEmailReplyPayload(payload);
  const missingSourceNote = approvalMissingSourceNote(approval.type, payload);
  // A long outgoing draft is cut on the card: the first Approve opens it instead of sending.
  const draftGate = useApprovalDraftGate(approval.type, payload);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isKeyboardShortcutTextInputTarget(event.target)) return;
    const actions = actionsRef.current;
    if (!actions) return;
    if (event.key === "A") actions.approve();
    else if (event.key === "C") actions.openRevision();
    else if (event.key === "X") actions.openReject();
    else return;
    event.preventDefault();
  };

  const detailsControl = detailLink ? (
    <Link
      to={detailLink}
      className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-auto px-2 text-xs text-muted-foreground")}
    >
      View details
    </Link>
  ) : onOpen ? (
    <Button variant="ghost" size="sm" className="h-auto px-2 text-xs text-muted-foreground" onClick={onOpen}>
      View details
    </Button>
  ) : null;

  return (
    <Card
      className="block border-border/70 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-approval-card={approval.id}
      tabIndex={enableShortcuts ? -1 : undefined}
      onKeyDown={enableShortcuts && showResolutionButtons ? handleKeyDown : undefined}
    >
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="border-border/70 px-2 py-0.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground"
          >
            {kindLabel}
          </Badge>
          {isEmailReply && (
            <Badge
              variant="outline"
              className="border-border/70 px-2 py-0.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground"
            >
              Email reply
            </Badge>
          )}
          <StatusBadge status={approval.status} />
          {(linkedIssues ?? []).map((issue) => (
            <Link
              key={issue.id}
              to={`/issues/${issue.identifier ?? issue.id}`}
              title={issue.title ?? undefined}
              className="rounded border border-border/70 px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              {issue.identifier ?? issue.id.slice(0, 8)}
            </Link>
          ))}
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
          {waiting ? (
            <span
              className={cn(waiting.long && "font-medium text-amber-700 dark:text-amber-300")}
              title={new Date(approval.createdAt).toLocaleString()}
            >
              {waiting.label}
            </span>
          ) : (
            <span>Created {timeAgo(approval.createdAt)}</span>
          )}
          {missingSourceNote && <span>{missingSourceNote}</span>}
        </div>
      </div>

      <ApprovalDecisionSummary
        type={approval.type}
        payload={payload}
        status={approval.status}
        resolveAgentName={resolveAgentName}
        draftControl={draftGate.draftControl}
        className="mt-4 border-t border-border/60 pt-4"
      />

      {approval.decisionNote && (
        <div className="mt-4 rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">Decision note.</span> {approval.decisionNote}
        </div>
      )}

      {hasFooter ? (
        <div className="mt-4 border-t border-border/60 pt-4">
          {showResolutionButtons && onApprove && onReject ? (
            <ApprovalDecisionActions
              ref={actionsRef}
              subject={subject ?? kindLabel}
              status={approval.status}
              onApprove={onApprove}
              onReject={onReject}
              // A change request is addressed to the requesting agent; without one it would reach nobody.
              onRequestRevision={approval.requestedByAgentId ? onRequestRevision : undefined}
              isPending={isPending}
              pendingAction={pendingAction}
              trailing={detailsControl}
              approveGuard={draftGate.approveGuard}
            />
          ) : (
            <div className="flex justify-end">{detailsControl}</div>
          )}
        </div>
      ) : null}
    </Card>
  );
}
