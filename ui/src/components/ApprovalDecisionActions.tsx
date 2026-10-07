import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type ApprovalPendingAction = "approve" | "reject" | "revision" | null;

/** Lets a parent drive the same decisions from keyboard shortcuts. */
export interface ApprovalDecisionActionsHandle {
  approve: () => void;
  openRevision: () => void;
  openReject: () => void;
}

type Mode = "note" | "revision" | "reject" | null;

type DecidedApproval = { id: string; updatedAt: Date | string };

/**
 * A decision is stored before the refetched approval reaches the page. Until
 * the page shows an approval at least as new as the decision, the old controls
 * must stay locked: a second click would repeat a decision that already went
 * through.
 */
export function useSettlingApprovals() {
  const [decidedAt, setDecidedAt] = useState<Record<string, number>>({});
  const markDecided = useCallback((approval: DecidedApproval | null | undefined) => {
    if (!approval?.id) return;
    const at = new Date(approval.updatedAt).getTime();
    if (Number.isNaN(at)) return;
    setDecidedAt((current) => ({ ...current, [approval.id]: at }));
  }, []);
  const isSettling = useCallback(
    (approval: DecidedApproval) => {
      const at = decidedAt[approval.id];
      return at !== undefined && new Date(approval.updatedAt).getTime() < at;
    },
    [decidedAt],
  );
  return { markDecided, isSettling };
}

/**
 * Board decision buttons shared by the approval card, the approval detail page
 * and the Inbox. A decision can carry a note for the requester; asking for
 * changes requires one, and a rejection is confirmed before it is sent.
 */
export const ApprovalDecisionActions = forwardRef<
  ApprovalDecisionActionsHandle,
  {
    /** Names the approval in each button's accessible label. */
    subject: string;
    status: string;
    onApprove: (note?: string) => void;
    onReject: (note?: string) => void;
    /** Omit where requesting changes is not available; the button is then hidden. */
    onRequestRevision?: (note: string) => void;
    isPending?: boolean;
    pendingAction?: ApprovalPendingAction;
    buttonClassName?: string;
    approveClassName?: string;
    className?: string;
    /** Rendered at the end of the button row, e.g. a link to the detail page. */
    trailing?: ReactNode;
    /**
     * Asked on every Approve, from the button or the imperative handle. A
     * message holds the approval back and is shown beside the buttons; null
     * lets it send. Reject and Request changes are never held back.
     */
    approveGuard?: () => string | null;
  }
>(function ApprovalDecisionActions(
  {
    subject,
    status,
    onApprove,
    onReject,
    onRequestRevision,
    isPending = false,
    pendingAction = null,
    buttonClassName,
    approveClassName,
    className,
    trailing,
    approveGuard,
  },
  ref,
) {
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState("");
  const [heldBackMessage, setHeldBackMessage] = useState<string | null>(null);
  const noteId = useId();
  const heldBackId = useId();
  const trimmedNote = note.trim();
  const canRequestRevision = Boolean(onRequestRevision) && status === "pending";
  const confirming = mode === "revision" || mode === "reject";

  // A decision that lands changes the status; start the next one from a clean slate.
  useEffect(() => {
    setMode(null);
    setNote("");
    setHeldBackMessage(null);
  }, [status]);

  const approve = () => {
    if (isPending || confirming) return;
    const heldBack = approveGuard?.() ?? null;
    setHeldBackMessage(heldBack);
    if (heldBack) return;
    onApprove(trimmedNote || undefined);
  };
  const openRevision = () => {
    if (isPending || !canRequestRevision) return;
    setHeldBackMessage(null);
    setMode("revision");
  };
  const openReject = () => {
    if (isPending) return;
    setHeldBackMessage(null);
    setMode("reject");
  };
  const cancel = () => {
    setMode(null);
    setNote("");
  };

  useImperativeHandle(ref, () => ({ approve, openRevision, openReject }));

  return (
    <div className={cn("space-y-3", className)}>
      {mode && (
        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3">
          {mode === "reject" && <p className="text-sm font-medium text-foreground">Reject this request?</p>}
          <label htmlFor={noteId} className="block text-xs font-medium text-foreground">
            {mode === "revision"
              ? "What should change?"
              : mode === "reject"
                ? "Reason (optional)"
                : "Note for the requester (optional)"}
          </label>
          <Textarea
            id={noteId}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={
              mode === "revision"
                ? "The requester sees this when asked to revise"
                : "Sent to the requester with your decision"
            }
            rows={2}
            autoFocus
            disabled={isPending}
          />
          {mode === "revision" && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className={buttonClassName}
                onClick={() => onRequestRevision?.(trimmedNote)}
                disabled={isPending || !trimmedNote}
              >
                {pendingAction === "revision" ? "Sending..." : "Send request"}
              </Button>
              <Button variant="outline" size="sm" className={buttonClassName} onClick={cancel} disabled={isPending}>
                Cancel
              </Button>
            </div>
          )}
          {mode === "reject" && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                size="sm"
                className={buttonClassName}
                onClick={() => onReject(trimmedNote || undefined)}
                disabled={isPending}
              >
                {pendingAction === "reject" ? "Rejecting..." : "Reject request"}
              </Button>
              <Button variant="outline" size="sm" className={buttonClassName} onClick={cancel} disabled={isPending}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Always present, so the message is announced when it appears; it takes no room while empty. */}
      <p
        id={heldBackId}
        role="status"
        aria-live="polite"
        className="text-sm font-medium leading-5 text-foreground empty:hidden"
      >
        {heldBackMessage}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className={cn(buttonClassName, approveClassName)}
            onClick={approve}
            disabled={isPending || confirming}
            aria-label={`Approve: ${subject}`}
            aria-describedby={heldBackMessage ? heldBackId : undefined}
          >
            {pendingAction === "approve" ? "Approving..." : "Approve"}
          </Button>
          {canRequestRevision && (
            <Button
              variant="outline"
              size="sm"
              className={buttonClassName}
              onClick={openRevision}
              disabled={isPending || confirming}
              aria-label={`Request changes: ${subject}`}
            >
              Request changes
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            className={buttonClassName}
            onClick={openReject}
            disabled={isPending || confirming}
            aria-label={`Reject: ${subject}`}
          >
            Reject
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!confirming && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-2 text-xs text-muted-foreground"
              onClick={() => (mode === "note" ? cancel() : setMode("note"))}
              disabled={isPending}
              aria-expanded={mode === "note"}
            >
              {mode === "note" ? "Remove note" : "Add a note"}
            </Button>
          )}
          {trailing}
        </div>
      </div>
    </div>
  );
});
