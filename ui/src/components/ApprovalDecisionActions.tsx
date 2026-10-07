import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type ApprovalDecisionKind = "approve" | "reject" | "revision";
export type ApprovalPendingAction = ApprovalDecisionKind | null;

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

const DECISION_ERROR_LEAD: Record<ApprovalDecisionKind, string> = {
  approve: "Error while approving",
  reject: "Error while rejecting",
  revision: "Error while requesting changes",
};

/**
 * The line shown when a decision request comes back as an error. The server
 * stores a decision before it runs what follows from it (activating a hire,
 * the activity log, waking the requester), so an error does not prove the
 * decision was not recorded: the text reports the error and does not say the
 * request is still undecided.
 */
export function approvalDecisionErrorText(action: ApprovalDecisionKind, error: unknown, subject?: string | null) {
  const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "the request did not complete";
  return `${DECISION_ERROR_LEAD[action]}${subject ? ` ${subject}` : ""}: ${detail}`;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Decision state for a list of approvals, kept per approval id: which action
 * is on its way and the last error it came back with. Two decisions sent close
 * together each keep their own busy state and their own error, and a second
 * decision for a request that is still sending is refused.
 */
export function useApprovalDecisionFeedback() {
  const [inFlight, setInFlight] = useState<Record<string, ApprovalDecisionKind>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Read at click time, before the state above has rendered.
  const sending = useRef(new Set<string>());

  /** Marks the decision as sent and clears the request's last error. False when one is already on its way. */
  const start = useCallback((id: string, action: ApprovalDecisionKind) => {
    if (sending.current.has(id)) return false;
    sending.current.add(id);
    setInFlight((current) => ({ ...current, [id]: action }));
    setErrors((current) => withoutKey(current, id));
    return true;
  }, []);
  /** Ends the busy state; an error text stays on the request until it is retried or dismissed. */
  const settle = useCallback((id: string, error?: string | null) => {
    sending.current.delete(id);
    setInFlight((current) => withoutKey(current, id));
    if (error) setErrors((current) => ({ ...current, [id]: error }));
  }, []);
  const clearError = useCallback((id: string) => {
    setErrors((current) => withoutKey(current, id));
  }, []);
  const clearErrors = useCallback(() => setErrors({}), []);

  return { inFlight, errors, start, settle, clearError, clearErrors };
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
    /** When this value changes, the reason Approve was last held back is dealt with and its message is removed. */
    approveHoldKey?: string | number;
    /** What went wrong with the last decision sent from here; shown directly above the buttons. */
    error?: string | null;
    /** Called when the board edits the note, so a parent can drop an error that no longer describes the draft. */
    onDismissError?: () => void;
    /**
     * A note the board had already typed for this request, for controls that are drawn again after
     * an approval was undone or failed. The note panel starts open with it; focus is left alone.
     */
    defaultNote?: string;
    /** Called with the new text whenever the board edits or discards the note. */
    onNoteChange?: (note: string) => void;
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
    approveHoldKey,
    error = null,
    onDismissError,
    defaultNote,
    onNoteChange,
  },
  ref,
) {
  const [mode, setMode] = useState<Mode>(defaultNote?.trim() ? "note" : null);
  const [note, setNote] = useState(defaultNote?.trim() ? defaultNote : "");
  const [heldBackMessage, setHeldBackMessage] = useState<string | null>(null);
  const noteId = useId();
  const noteLabelId = useId();
  const rejectPromptId = useId();
  const heldBackId = useId();
  const errorId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const revisionButtonRef = useRef<HTMLButtonElement>(null);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const noteButtonRef = useRef<HTMLButtonElement>(null);
  // The panel whose opener gets focus back once the panel has closed.
  const returnFocusTo = useRef<Mode>(null);
  const trimmedNote = note.trim();
  const canRequestRevision = Boolean(onRequestRevision) && status === "pending";
  const confirming = mode === "revision" || mode === "reject";

  // A decision that lands changes the status; start the next one from a clean slate.
  const previousStatus = useRef(status);
  useEffect(() => {
    const from = previousStatus.current;
    previousStatus.current = status;
    // The first run, with nothing decided yet: a note the controls started with stays.
    if (from === status) return;
    // A request that comes back as pending was resubmitted by its requester: what the board was typing stays.
    if (from === "revision_requested" && status === "pending") return;
    setMode(null);
    setNote("");
    setHeldBackMessage(null);
  }, [status]);

  useEffect(() => {
    setHeldBackMessage(null);
  }, [approveHoldKey]);

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
    returnFocusTo.current = mode;
    setMode(null);
    setNote("");
    onNoteChange?.("");
  };

  // Opening a panel, or turning the note panel into a confirmation, puts the cursor in its field.
  // Closing one hands focus back to the button that opened it, which is disabled until this render.
  // A panel that is open from the start (a restored note) does not take focus.
  const previousMode = useRef(mode);
  useEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    if (mode) {
      noteRef.current?.focus();
      return;
    }
    const opener =
      returnFocusTo.current === "revision"
        ? revisionButtonRef.current
        : returnFocusTo.current === "reject"
          ? rejectButtonRef.current
          : returnFocusTo.current === "note"
            ? noteButtonRef.current
            : null;
    returnFocusTo.current = null;
    opener?.focus();
  }, [mode]);

  const sendRevision = () => {
    if (isPending || !trimmedNote) return;
    onRequestRevision?.(trimmedNote);
  };
  const sendReject = () => {
    if (isPending) return;
    onReject(trimmedNote || undefined);
  };

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || isPending) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  // Ctrl+Enter or Cmd+Enter sends the open confirmation. The note panel has no such key: it would approve.
  const handleNoteKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    if (event.shiftKey || event.altKey || event.nativeEvent.isComposing || !confirming) return;
    event.preventDefault();
    event.stopPropagation();
    if (mode === "revision") sendRevision();
    else sendReject();
  };

  useImperativeHandle(ref, () => ({ approve, openRevision, openReject }));

  return (
    <div className={cn("space-y-3", className)} aria-busy={isPending}>
      {mode && (
        <div
          role="group"
          aria-labelledby={mode === "reject" ? rejectPromptId : noteLabelId}
          className="space-y-2 rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3"
          onKeyDown={handlePanelKeyDown}
        >
          {mode === "reject" && (
            <p id={rejectPromptId} className="text-sm font-medium text-foreground">
              Reject this request?
            </p>
          )}
          <label id={noteLabelId} htmlFor={noteId} className="block text-xs font-medium text-foreground">
            {mode === "revision"
              ? "What should change?"
              : mode === "reject"
                ? "Reason (optional)"
                : "Note for the requester (optional)"}
          </label>
          <Textarea
            id={noteId}
            ref={noteRef}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              onNoteChange?.(event.target.value);
              if (error) onDismissError?.();
            }}
            onKeyDown={handleNoteKeyDown}
            aria-describedby={mode === "reject" ? rejectPromptId : undefined}
            aria-required={mode === "revision" ? true : undefined}
            placeholder={
              mode === "revision"
                ? "The requester sees this when asked to revise"
                : "Sent to the requester with your decision"
            }
            rows={2}
            disabled={isPending}
          />
          {mode === "revision" && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className={buttonClassName}
                onClick={sendRevision}
                disabled={isPending || !trimmedNote}
                aria-label={`${pendingAction === "revision" ? "Sending request for changes" : "Send request for changes"}: ${subject}`}
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
                onClick={sendReject}
                disabled={isPending}
                aria-label={`${pendingAction === "reject" ? "Rejecting" : "Reject request"}: ${subject}`}
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

      {error ? (
        <p id={errorId} role="alert" className="break-words text-sm font-medium leading-5 text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className={cn(buttonClassName, approveClassName)}
            onClick={approve}
            disabled={isPending || confirming}
            aria-label={`${pendingAction === "approve" ? "Approving" : "Approve"}: ${subject}`}
            aria-describedby={
              [heldBackMessage ? heldBackId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined
            }
          >
            {pendingAction === "approve" ? "Approving..." : "Approve"}
          </Button>
          {canRequestRevision && (
            <Button
              ref={revisionButtonRef}
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
            ref={rejectButtonRef}
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
              ref={noteButtonRef}
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
