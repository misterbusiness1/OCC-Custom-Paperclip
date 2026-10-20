import { useId, useMemo, useRef, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { AgentIdentity } from "./AgentIdentity";
import {
  approvalAskLine,
  APPROVAL_TITLE_LENGTH,
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
  type ApprovalNoteMode,
  type ApprovalPendingAction,
} from "./ApprovalDecisionActions";
import {
  ApprovalChangesAskedFor,
  approvalChangesAskedFor,
  ApprovalRevisedNotice,
  ApprovalWaitingOnRequester,
  composeApproveGuards,
  useApprovalRevisionGuard,
  type ApprovalRevisionMemory,
} from "./ApprovalRevision";
import { timeAgo } from "../lib/timeAgo";
import { isKeyboardShortcutTextInputTarget } from "../lib/keyboardShortcuts";
import type { Approval, Agent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "./StatusBadge";
import { ApprovalSectionHeadingLevel } from "./ApprovalSectionLabel";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A request the board has left this long is called out in the header. */
const LONG_WAIT_DAYS = 7;
/** A closed request says when it was closed, in place of when it was created. */
const DECIDED_LEAD: Record<string, string> = {
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

/** What a closed row says when its request holds a text that was typed and not sent. */
const UNSENT_NOTE_LABEL: Record<ApprovalNoteMode, string> = {
  note: "Note not sent",
  revision: "Change request not sent",
  reject: "Rejection reason not sent",
};

export type ApprovalCardLinkedIssue = {
  id: string;
  identifier?: string | null;
  title?: string | null;
};

/**
 * The "View details" link, on the card and on the queue's compact rows. It is 16px tall. On a
 * touch screen its tap area is 44px tall (16 + 2 x 14) and no wider than the link. The row keeps
 * its height. The area stops short of the next row: rows are 12px apart, and it passes the
 * row's edge by 1px at most.
 */
export const APPROVAL_DETAILS_LINK_CLASS = cn(
  buttonVariants({ variant: "ghost", size: "sm" }),
  "h-auto px-2 text-xs text-muted-foreground",
  "relative pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-3.5",
);

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
  detailLinkState,
  isPending = false,
  pendingAction = null,
  error = null,
  onDismissError,
  defaultNote,
  defaultNoteMode,
  onNoteChange,
  unsentNote = null,
  revisionMemory,
  linkedIssues,
  enableShortcuts = false,
  resolveAgentName,
  collapsible = false,
  open = true,
  onOpenChange,
  focusable = false,
  announceError = true,
  changesAskedFor = null,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  onApprove?: (note?: string) => void;
  onReject?: (note?: string) => void;
  onRequestRevision?: (note: string) => void;
  onOpen?: () => void;
  detailLink?: string;
  /** Carried by the "View details" link as its navigation state, for the page it opens. */
  detailLinkState?: unknown;
  isPending?: boolean;
  pendingAction?: ApprovalPendingAction;
  /** What went wrong with the last decision sent from this card; shown beside its buttons. */
  error?: string | null;
  /** Called when the board edits the note after an error. */
  onDismissError?: () => void;
  /** A text already typed for this request; the decision controls start with it, its panel open. */
  defaultNote?: string;
  /** The panel that text was typed in: a note, a change request or a rejection reason. */
  defaultNoteMode?: ApprovalNoteMode;
  /** Called with the text and its panel whenever the board edits, moves or discards it. */
  onNoteChange?: (note: string, mode: ApprovalNoteMode | null) => void;
  /**
   * The request holds a text that was typed and not sent. A closed row has no field to show it in,
   * so its header says so; the open card shows the text itself.
   */
  unsentNote?: ApprovalNoteMode | null;
  /**
   * Where a page keeps the version first shown of each request and the revisions confirmed, so that
   * they outlast this card being closed, paged, filtered or taken off the list and brought back.
   */
  revisionMemory?: ApprovalRevisionMemory;
  linkedIssues?: ApprovalCardLinkedIssue[];
  /** Shift+A approves, Shift+C asks for changes and Shift+X rejects while the card has focus. */
  enableShortcuts?: boolean;
  /** Lets a hire request name the manager the new agent reports to, and a Board approval the agent that wrote its original request. */
  resolveAgentName?: ApprovalAgentNameResolver;
  /**
   * For a queue: the header becomes a button that opens and closes the card. A closed card is one
   * compact row and carries no summary and no decision controls, so nothing is decided from it.
   */
  collapsible?: boolean;
  /** Whether a collapsible card is open. A card that is not collapsible is always open. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Lets the page move focus to the card itself, also when shortcuts are off. */
  focusable?: boolean;
  /**
   * Whether the card's error line is an alert. A page that announces every outcome in a live region
   * of its own passes false: the error is then spoken once, by the page, and not again each time the
   * card is closed or opened and the line is drawn anew.
   */
  announceError?: boolean;
  /**
   * The change request the reader sent for this request earlier on this visit. The server keeps
   * the note on the resubmitted request and the card shows that one. This copy is used only when
   * the request carries none (an older server deleted it). Shown above the summary, as plain text.
   */
  changesAskedFor?: string | null;
}) {
  const actionsRef = useRef<ApprovalDecisionActionsHandle>(null);
  const bodyId = useId();
  const titleId = useId();
  const metaId = useId();
  const rowErrorId = useId();
  const isOpen = !collapsible || open;
  const payload = approval.payload as Record<string, unknown> | null;
  const kindLabel = typeLabel[approval.type] ?? approval.type;
  // Converted once per payload: a queue draws its rows again on every hover and key press.
  const subject = useMemo(
    () => approvalExcerpt(approvalSubject(payload, approval.type), APPROVAL_TITLE_LENGTH),
    [payload, approval.type],
  );
  // Sent back for changes: the requester has it now. The card offers no one-click decision on the
  // version the board asked to change; the detail page keeps Approve and Reject.
  const isSentBack = approval.status === "revision_requested";
  const showResolutionButtons =
    Boolean(onApprove && onReject) &&
    approval.type !== "budget_override_required" &&
    approval.status === "pending";
  const hasFooter = showResolutionButtons || isSentBack || Boolean(detailLink || onOpen || error);
  // Only a pending request is waiting on the board.
  const waiting = approval.status === "pending" ? waitingLabel(approval.createdAt) : null;
  const decidedLead = approval.decidedAt ? DECIDED_LEAD[approval.status] : undefined;
  const isEmailReply = approval.type === "request_board_approval" && isEmailReplyPayload(payload);
  const missingSourceNote = approvalMissingSourceNote(approval.type, payload);
  // A long outgoing draft is cut on the card: the first Approve opens it instead of sending.
  const draftGate = useApprovalDraftGate(approval.type, payload);
  // A request resubmitted while this card is open is not approved until the board confirms it read the revision.
  const revision = useApprovalRevisionGuard(approval, revisionMemory);
  const approveGuard = composeApproveGuards(revision.approveGuard, draftGate.approveGuard);
  const title = subject ?? kindLabel;
  // One line of what is asked, for the closed row only. A request titled by its own recommendation does not repeat it.
  const ask = useMemo(
    () => (isOpen ? null : approvalAskLine(approval.type, payload)),
    [isOpen, approval.type, payload],
  );
  const askLine = ask && ask.text !== title ? ask : null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A held key decides nothing: the next card takes focus as soon as a decision lands.
    if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (isKeyboardShortcutTextInputTarget(event.target)) return;
    const actions = actionsRef.current;
    if (!actions) return;
    // Compared without case: with Caps Lock on, Shift+A arrives as "a". Shift is required above,
    // so a plain "a" (or a plain "A" typed with Caps Lock) decides nothing.
    const key = event.key.toLowerCase();
    if (key === "a") actions.approve();
    else if (key === "c") actions.openRevision();
    else if (key === "x") actions.openReject();
    else return;
    event.preventDefault();
  };

  const detailsControl = detailLink ? (
    <Link
      to={detailLink}
      state={detailLinkState}
      className={APPROVAL_DETAILS_LINK_CLASS}
      // A list has one such link per request: its name says which request it opens.
      aria-label={`View details: ${title}`}
    >
      View details
    </Link>
  ) : onOpen ? (
    <Button
      variant="ghost"
      size="sm"
      className="h-auto px-2 text-xs text-muted-foreground"
      aria-label={`View details: ${title}`}
      onClick={onOpen}
    >
      View details
    </Button>
  ) : null;

  const badgeClass =
    "border-border/70 px-2 py-0.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground";
  const badges = (
    <>
      <Badge variant="outline" className={badgeClass}>
        {kindLabel}
      </Badge>
      {isEmailReply && (
        <Badge variant="outline" className={badgeClass}>
          Email reply
        </Badge>
      )}
      <StatusBadge status={approval.status} />
      {(linkedIssues ?? []).map((issue) => (
        <Link
          key={issue.id}
          to={`/issues/${issue.identifier ?? issue.id}`}
          title={issue.title ?? undefined}
          className={cn(
            // At least 24px tall: a target of its own, not a sliver on the header's click area.
            "inline-flex min-h-6 items-center rounded border border-border/70 px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            // Stays a link of its own, above the header button's click area.
            collapsible && "relative z-10",
          )}
        >
          {issue.identifier ?? issue.id.slice(0, 8)}
        </Link>
      ))}
    </>
  );
  const meta = (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground",
        // Above the header button's click area: the exact times show on hover and the text can be
        // selected. A click here does not open or close the card; the title line does.
        collapsible && "relative z-10",
      )}
    >
      {requesterAgent && (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          Requested by <AgentIdentity agent={requesterAgent} size="sm" className="inline-flex" />
        </span>
      )}
      {waiting ? (
        <span
          className={cn(waiting.long && "font-medium text-amber-700 dark:text-amber-300")}
          title={new Date(approval.createdAt).toLocaleString()}
        >
          {waiting.label}
        </span>
      ) : decidedLead && approval.decidedAt ? (
        <span title={new Date(approval.decidedAt).toLocaleString()}>
          {decidedLead} {timeAgo(approval.decidedAt)}
        </span>
      ) : (
        <span>Created {timeAgo(approval.createdAt)}</span>
      )}
      {missingSourceNote && <span>{missingSourceNote}</span>}
      {/* A closed row has no notice and no buttons, so it says these two things itself. */}
      {!isOpen && revision.revised && (
        <span className="font-medium text-amber-700 dark:text-amber-300">Revised while this page was open</span>
      )}
      {!isOpen && isPending && <span>Sending your decision...</span>}
      {!isOpen && unsentNote && showResolutionButtons && (
        <span className="font-medium text-foreground" data-approval-unsent-note="">
          {UNSENT_NOTE_LABEL[unsentNote]}
        </span>
      )}
    </div>
  );

  const body = (
    // The card's title is an h3, so the labels of its sections are headings one level below it.
    <ApprovalSectionHeadingLevel.Provider value={4}>
      <ApprovalRevisedNotice guard={revision} className="mt-4" />

      <ApprovalChangesAskedFor
        note={approvalChangesAskedFor(approval) ?? changesAskedFor}
        className="mt-4 border-t border-border/60 pt-4"
      />

      <ApprovalDecisionSummary
        type={approval.type}
        payload={payload}
        status={approval.status}
        requestedByAgentId={approval.requestedByAgentId}
        resolveAgentName={resolveAgentName}
        draftControl={draftGate.draftControl}
        className="mt-4 border-t border-border/60 pt-4"
      />

      {/* On a pending request the note is the change request it answers, shown above the summary. */}
      {approval.decisionNote && !isSentBack && approval.status !== "pending" && (
        <div
          className="mt-4 whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3 text-xs leading-5 text-muted-foreground"
          data-approval-decision-note
        >
          <span className="font-medium text-foreground">Decision note.</span> {approval.decisionNote}
        </div>
      )}

      {hasFooter ? (
        <div className="mt-4 border-t border-border/60 pt-4">
          {showResolutionButtons && onApprove && onReject ? (
            <ApprovalDecisionActions
              ref={actionsRef}
              subject={title}
              status={approval.status}
              onApprove={onApprove}
              onReject={onReject}
              // A change request is addressed to the requesting agent; without one it would reach nobody.
              onRequestRevision={approval.requestedByAgentId ? onRequestRevision : undefined}
              isPending={isPending}
              pendingAction={pendingAction}
              trailing={detailsControl}
              approveGuard={approveGuard}
              approveHoldKey={revision.reviewCount}
              // A revision to confirm comes first: the button says "Read full reply" only when the press will open it.
              approveLabel={revision.revised ? undefined : draftGate.approveLabel}
              error={error}
              announceError={announceError}
              onDismissError={onDismissError}
              defaultNote={defaultNote}
              defaultNoteMode={defaultNoteMode}
              onNoteChange={onNoteChange}
            />
          ) : (
            <div className="space-y-3">
              {isSentBack && (
                <ApprovalWaitingOnRequester approval={approval} requesterName={requesterAgent?.name ?? null} />
              )}
              {/* A request that can no longer be decided here keeps the error its last decision came back with. */}
              {(error || detailsControl) && (
                <div className={cn("flex flex-wrap items-center gap-3", error ? "justify-between" : "justify-end")}>
                  {error ? (
                    <p
                      role={announceError ? "alert" : undefined}
                      className="min-w-0 break-words text-sm font-medium leading-5 text-destructive"
                      data-approval-decision-error=""
                    >
                      {error}
                    </p>
                  ) : null}
                  {detailsControl}
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}
    </ApprovalSectionHeadingLevel.Provider>
  );

  if (collapsible) {
    const Chevron = isOpen ? ChevronDown : ChevronRight;
    return (
      <Card
        className={cn(
          "block min-w-0 scroll-mt-16 border-border/70 p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:scroll-mt-2",
          // The open card is marked whether or not it holds focus. Shift+A, Shift+C and Shift+X act
          // on it only while focus is inside it: J, K, a click or Tab puts it there.
          // The strong token: the usual ring colour is under 3:1 against the page in the light theme.
          isOpen && "border-primary ring-1 ring-primary focus-visible:ring-primary",
        )}
        // The page moves focus to the card itself; a group named by the title says where that is.
        role="group"
        aria-labelledby={titleId}
        data-approval-card={approval.id}
        tabIndex={enableShortcuts || focusable ? -1 : undefined}
        onKeyDown={enableShortcuts && showResolutionButtons && isOpen ? handleKeyDown : undefined}
      >
        {/* The button's click area is stretched over this header; the task links sit above it. */}
        <div
          className={cn(
            "relative min-w-0 space-y-1 rounded-lg px-4 pt-3",
            isOpen ? "pb-0" : "pb-3 hover:bg-accent/40",
          )}
        >
          <div id={metaId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {badges}
            {meta}
          </div>
          <h3
            className={cn(
              "font-semibold text-foreground",
              isOpen ? "text-base leading-6" : "text-sm leading-5",
            )}
          >
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={bodyId}
              // Kind, status, requester, how long it has waited and what a closed row flags are read
              // with the title, and so is the error a closed row shows.
              aria-describedby={!isOpen && error ? `${metaId} ${rowErrorId}` : metaId}
              onClick={() => onOpenChange?.(!isOpen)}
              className="flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Chevron
                aria-hidden
                className={cn("h-4 w-4 shrink-0 text-muted-foreground", isOpen ? "mt-1" : "mt-0.5")}
              />
              <span id={titleId} className={cn("min-w-0", isOpen ? "break-words" : "truncate")}>
                {title}
              </span>
            </button>
          </h3>
          {askLine && (
            <p className="truncate pl-5.5 text-xs leading-5 text-muted-foreground" data-approval-ask="">
              <span className="font-medium">{askLine.label}:</span> {askLine.text}
            </p>
          )}
          {!isOpen && error && (
            <p
              id={rowErrorId}
              role={announceError ? "alert" : undefined}
              // Above the header's click area, so the message can be selected and copied. Two lines
              // at most: a long message must not make the row push the card being read down the
              // page. The whole message is on hover here, and above the buttons once the card is open.
              className="relative z-10 line-clamp-2 break-words pl-5.5 text-xs font-medium leading-5 text-destructive"
              title={error}
              data-approval-row-error=""
            >
              {error}
            </p>
          )}
        </div>
        <div id={bodyId} hidden={!isOpen} className="px-4 pb-4">
          {isOpen ? body : null}
        </div>
      </Card>
    );
  }

  return (
    <Card
      className={cn(
        "block min-w-0 scroll-mt-16 border-border/70 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:scroll-mt-2",
        // With shortcuts on, the card that holds focus is the one they act on: mark it for mouse focus too.
        enableShortcuts &&
          "focus-within:border-primary focus-within:ring-1 focus-within:ring-primary focus-visible:ring-primary",
      )}
      role="group"
      aria-labelledby={titleId}
      data-approval-card={approval.id}
      tabIndex={enableShortcuts || focusable ? -1 : undefined}
      onKeyDown={enableShortcuts && showResolutionButtons ? handleKeyDown : undefined}
    >
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">{badges}</div>
        <h3 id={titleId} className="text-base font-semibold leading-6 text-foreground">
          {title}
        </h3>
        {meta}
      </div>
      {body}
    </Card>
  );
}
