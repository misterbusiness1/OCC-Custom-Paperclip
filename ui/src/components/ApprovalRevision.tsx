import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Approval } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { timeAgo } from "../lib/timeAgo";

const labelClass =
  "text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground";

/** Heads the note the board sent with Request changes, wherever a sent-back request is shown. */
export const APPROVAL_CHANGES_ASKED_LABEL = "Changes you asked for";

/** When the board sent the request back: the time of that decision, or of the last change when none is recorded. */
export function approvalSentBackAt(approval: Pick<Approval, "decidedAt" | "updatedAt">): Date | string {
  return approval.decidedAt ?? approval.updatedAt;
}

/** "Sent back 2h ago", with the exact time on hover. */
export function ApprovalSentBackTime({
  approval,
  className,
}: {
  approval: Pick<Approval, "decidedAt" | "updatedAt">;
  className?: string;
}) {
  const sentBackAt = approvalSentBackAt(approval);
  return (
    <span className={className} title={new Date(sentBackAt).toLocaleString()}>
      Sent back {timeAgo(sentBackAt)}
    </span>
  );
}

/** The board's own change request, as plain text with its line breaks. Renders nothing without a note. */
export function ApprovalChangesAskedFor({ note, className }: { note: string | null | undefined; className?: string }) {
  if (!note?.trim()) return null;
  return (
    <div className={cn("min-w-0", className)} data-approval-changes-asked>
      <p className={labelClass}>{APPROVAL_CHANGES_ASKED_LABEL}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-foreground">{note}</p>
    </div>
  );
}

/**
 * Stands where the decision buttons would be for a request the board sent back
 * for changes: the requester has it now, so compact surfaces offer no one-click
 * decision on the version the board asked to change.
 */
export function ApprovalWaitingOnRequester({
  approval,
  requesterName,
  className,
}: {
  approval: Pick<Approval, "decisionNote" | "decidedAt" | "updatedAt">;
  /** Shown by name only; without one the line says "the requester". */
  requesterName?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-2", className)} data-approval-sent-back>
      <p className="text-sm leading-5 text-foreground">
        <span className="font-medium">Waiting on {requesterName?.trim() || "the requester"} to revise</span>
        <span className="text-muted-foreground">
          {" · "}
          <ApprovalSentBackTime approval={approval} />
        </span>
      </p>
      <ApprovalChangesAskedFor note={approval.decisionNote} />
    </div>
  );
}

/** Deep equality for JSON values; object key order does not count. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const left = a as unknown[];
    const right = b as unknown[];
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
  );
}

type GuardedApproval = Pick<Approval, "id" | "status" | "updatedAt" | "payload">;
type ReadVersion = { id: string; updatedAt: number; payload: unknown };

/**
 * What a page remembers about the requests it has shown, per approval id: the version the reader
 * last had in front of them as the one to decide, and how many revisions they have confirmed. A
 * page that draws a request's card more than once (a queue whose cards close, page and are
 * filtered) hands one such memory to every {@link useApprovalRevisionGuard}, so that neither a
 * confirmation nor an unconfirmed revision is forgotten when a card is drawn again, and a request
 * that left the list and returns changed is still recognised as revised.
 */
export type ApprovalRevisionMemory = Map<string, { read: ReadVersion; reviewCount: number }>;

export function createApprovalRevisionMemory(): ApprovalRevisionMemory {
  return new Map();
}

function readVersion(approval: GuardedApproval | null | undefined): ReadVersion | null {
  if (!approval) return null;
  return { id: approval.id, updatedAt: new Date(approval.updatedAt).getTime(), payload: approval.payload };
}

export const APPROVAL_REVISED_NOTICE =
  "The requester revised this request while it was open. Review it before you decide.";
export const APPROVAL_REVISED_REVIEWED_NOTE =
  "The requester revised this request while it was open. You marked the revision as reviewed.";
/** Shown beside the decision buttons when Approve was held back by a revision the board has not confirmed. */
export const APPROVAL_REVISED_HELD_BACK_MESSAGE = "Confirm that you have reviewed the revised request, then approve.";

/**
 * Keeps a request from being approved in a version the board did not read. The
 * hook remembers the version first shown for an approval id. When the same
 * approval arrives while it is pending with a newer `updatedAt` and a different
 * payload, the requester has resubmitted it under the reader: `revised` turns
 * true and `approveGuard` holds Approve back until `acknowledge` is called.
 *
 * A newer `updatedAt` with the same payload raises nothing, and neither does
 * the reader's own decision: that leaves the status "pending".
 *
 * Render {@link ApprovalRevisedNotice} above the summary and pass
 * `approveGuard` (through {@link composeApproveGuards}) to the decision buttons.
 *
 * Without `memory` the hook remembers for as long as its component is mounted. With one, the
 * remembered version and the confirmations live in it and outlast the component: see
 * {@link ApprovalRevisionMemory}.
 */
export function useApprovalRevisionGuard(
  approval: GuardedApproval | null | undefined,
  memory?: ApprovalRevisionMemory,
) {
  const current = readVersion(approval);
  const remembered = current && memory ? (memory.get(current.id) ?? null) : null;
  const [read, setRead] = useState<ReadVersion | null>(remembered?.read ?? current);
  // How many revisions the reader has confirmed on this approval.
  const [reviewCount, setReviewCount] = useState(remembered?.reviewCount ?? 0);
  const noticeRef = useRef<HTMLDivElement>(null);

  // Another approval in the same place (or the first one to load) starts from what the page
  // remembers of it, or from what is shown now.
  const sameApproval = current !== null && read !== null && current.id === read.id;
  if (!sameApproval && (current !== null || read !== null)) {
    setRead(remembered?.read ?? current);
    setReviewCount(remembered?.reviewCount ?? 0);
  }

  // The first version shown of a request is the one the page remembers it by.
  const currentId = current?.id;
  useEffect(() => {
    if (!memory || !current || memory.has(current.id)) return;
    memory.set(current.id, { read: current, reviewCount: 0 });
    // Only a request the memory does not hold yet is written, so the version shown at that moment is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory, currentId]);

  const status = approval?.status;
  const payload = approval?.payload;
  const updatedAt = current?.updatedAt;
  const revised = useMemo(() => {
    if (!sameApproval || read === null || status !== "pending" || updatedAt === undefined) return false;
    return updatedAt > read.updatedAt && !jsonEqual(payload, read.payload);
  }, [sameApproval, status, updatedAt, payload, read]);

  /** The reader confirms the version now on the page; it becomes the remembered one. */
  const acknowledge = () => {
    if (!revised) return;
    // The button is about to leave the page: focus stays on the notice it sat in.
    noticeRef.current?.focus({ preventScroll: true });
    setRead(current);
    setReviewCount(reviewCount + 1);
    if (memory && current) memory.set(current.id, { read: current, reviewCount: reviewCount + 1 });
  };

  /** The message to show when Approve is held back, or null when it may send. */
  const approveGuard = (): string | null => {
    if (!revised) return null;
    // Put the reader on the notice; the button inside it is the next stop, never an Enter away.
    const notice = noticeRef.current;
    notice?.focus({ preventScroll: true });
    notice?.scrollIntoView?.({ block: "nearest" });
    return APPROVAL_REVISED_HELD_BACK_MESSAGE;
  };

  return { revised, reviewCount, acknowledge, approveGuard, noticeRef };
}

export type ApprovalRevisionGuard = ReturnType<typeof useApprovalRevisionGuard>;

/**
 * Says that the request was revised under the reader and takes the
 * confirmation that unblocks Approve. Once confirmed it stays as one quiet
 * line, so the reader still knows this is not the version first opened.
 */
export function ApprovalRevisedNotice({ guard, className }: { guard: ApprovalRevisionGuard; className?: string }) {
  const textId = useId();
  if (!guard.revised && guard.reviewCount === 0) return null;

  return (
    <div
      ref={guard.noticeRef}
      // Focusable so a held-back Approve, and the confirmation itself, leave the reader here.
      tabIndex={-1}
      role="group"
      aria-labelledby={textId}
      data-approval-revised={guard.revised ? "unreviewed" : "reviewed"}
      className={cn(
        "min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        guard.revised &&
          "flex flex-wrap items-center justify-between gap-3 border border-amber-500/30 bg-amber-500/10 px-3.5 py-3",
        className,
      )}
    >
      {guard.revised ? (
        <>
          <p id={textId} role="alert" className="min-w-0 text-sm font-medium leading-5 text-foreground">
            {APPROVAL_REVISED_NOTICE}
          </p>
          <Button variant="outline" size="sm" onClick={guard.acknowledge}>
            I have reviewed it
          </Button>
        </>
      ) : (
        <p id={textId} className="text-xs leading-5 text-muted-foreground">
          {APPROVAL_REVISED_REVIEWED_NOTE}
        </p>
      )}
    </div>
  );
}

type ApproveGuard = () => string | null;

/**
 * Asks each guard in turn and stops at the first that holds Approve back, so
 * one press deals with one reason: the revised notice before the unread draft.
 */
export function composeApproveGuards(...guards: Array<ApproveGuard | undefined>): ApproveGuard {
  return () => {
    for (const guard of guards) {
      const heldBack = guard?.() ?? null;
      if (heldBack) return heldBack;
    }
    return null;
  };
}
