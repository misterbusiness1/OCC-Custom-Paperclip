import {
  startTransition,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from "react";
import { Link, useNavigate, useLocation, useSearchParams } from "@/lib/router";
import { keepPreviousData, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOptionalToastActions } from "../context/ToastContext";
import {
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
  shouldBlurPageSearchOnEnter,
  shouldBlurPageSearchOnEscape,
} from "../lib/keyboardShortcuts";
import { queryKeys } from "../lib/queryKeys";
import { isBareApprovalsPath } from "../lib/shell-navigation";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { ChevronDown, ChevronRight, Search, ShieldCheck } from "lucide-react";
import { APPROVAL_DETAILS_LINK_CLASS, ApprovalCard } from "../components/ApprovalCard";
import {
  approvalDecisionErrorText,
  useApprovalDecisionFeedback,
  type ApprovalDecisionKind,
  type ApprovalNoteMode,
} from "../components/ApprovalDecisionActions";
import {
  APPROVE_AFTER_ADVANCE_MS,
  APPROVE_HOLD_MS,
  APPROVE_PAUSE_LIMIT_MS,
  ApprovalHoldCountdown,
  approvalHoldSecondsLeft,
  useApprovalHolds,
  type ApprovalHoldPauseReason,
  type HeldApproval,
} from "../components/ApprovalHold";
import {
  APPROVAL_TITLE_LENGTH,
  approvalDecisionBrief,
  approvalExcerpt,
  approvalSubject,
  isEmailReplyPayload,
  typeLabel,
} from "../components/ApprovalPayload";
import {
  ApprovalChangesAskedFor,
  ApprovalSentBackTime,
  approvalRevisedSinceShown,
  approvalSentBackAt,
  createApprovalRevisionMemory,
} from "../components/ApprovalRevision";
import { PageSkeleton } from "../components/PageSkeleton";
import { approvalVersionConflict, type ApprovalVersion, type ApprovalVersionConflict } from "../lib/approval-version";
import { StatusBadge } from "../components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type StatusFilter = "pending" | "all";
type SortOrder = "oldest" | "newest";
/** A decision as it is sent. `companyId` is the request's own company: the reader may have changed company by the time it lands. */
type Decision = {
  id: string;
  note?: string;
  subject: string;
  companyId: string;
  /** The `updatedAt` of the request as drawn when the button was pressed: the version the decision is for. */
  expectedUpdatedAt: ApprovalVersion;
};
type ViewMode = "compact" | "full";
/**
 * A move of the reader's place in the queue, carried out once the list has drawn:
 * which row to bring into view, and whether keyboard focus goes with it.
 */
type QueueMove = {
  /** The row to bring into view; null when a decision left no request to move on to. */
  targetId: string | null;
  /** A row of "Waiting on the requester" to bring into view instead: those rows sit outside the queue. */
  sentBackId?: string;
  /** The request a decision just landed on. Focus falls back to its compact row. */
  decidedId?: string;
  focus: boolean;
  /** The decided card began above the viewport: its row goes to the top first, so the next request is not passed. */
  scrollDecidedToTop?: boolean;
  block?: ScrollLogicalPosition;
  /** The reader opened this card to read it: when its top ends up above the visible area, the top is shown, not the end. */
  readFromTop?: boolean;
};
/** A text typed for a request and not sent: what it says and the panel it was typed in. */
type ApprovalDraft = { text: string; mode: ApprovalNoteMode };
/** What "View details" carries to a request's own page: the queue address to come back to, with its filter and sort. */
type ApprovalQueueLinkState = { queue: string };
/** How a request is shown once it is one compact row: the record to show, and whether someone else decided it. */
type CompactRow = { record: Approval; elsewhere: boolean };
const PAGE_SIZE = 20;
/** Clears the bar that stays at the top of a phone's screen when a row is scrolled to the top. */
const ROW_SCROLL_MARGIN = "scroll-mt-16 md:scroll-mt-2";
const OPEN_DIALOG_SELECTOR = "[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']";
const EMAIL_REPLY_KIND = "email_reply";
const VIEW_STORAGE_KEY = "paperclip.approvals.view";
const HASH_PREFIX = "#approval-";

function readStoredView(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "full" ? "full" : "compact";
  } catch {
    return "compact";
  }
}

/**
 * The top edge of the area the list scrolls in: the nearest scrolling ancestor
 * (the app's main pane on a desktop), or the window.
 */
function scrollAreaTop(element: HTMLElement | null): number {
  for (let node = element?.parentElement ?? null; node && node !== document.body; node = node.parentElement) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node.getBoundingClientRect().top;
    }
  }
  return 0;
}

/** Whether the top of a row is hidden above the area the list scrolls in, or under the bar a phone keeps there. */
function isAboveScrollArea(row: HTMLElement): boolean {
  const margin = Number.parseFloat(window.getComputedStyle(row).scrollMarginTop) || 0;
  return row.getBoundingClientRect().top < scrollAreaTop(row) + margin;
}

/**
 * Whether a row is on the page and some part of it is where the reader can see it: not above the
 * area the list scrolls in (or under the bar a phone keeps there), and not below the window.
 */
function isRowInView(row: HTMLElement | null): boolean {
  if (!row) return false;
  const margin = Number.parseFloat(window.getComputedStyle(row).scrollMarginTop) || 0;
  const rect = row.getBoundingClientRect();
  return rect.bottom >= scrollAreaTop(row) + margin && rect.top <= window.innerHeight;
}

/** The approval a link such as /approvals/pending#approval-<id> points at. */
function approvalIdFromHash(hash: string): string | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const raw = hash.slice(HASH_PREFIX.length);
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return raw || null;
  }
}

/** Only a pending request is the board's to decide. */
function needsBoard(approval: Approval) {
  return approval.status === "pending";
}

/** Sent back for changes: the requester has it until it is resubmitted. */
function isSentBack(approval: Approval) {
  return approval.status === "revision_requested";
}

function timeOf(value: Date | string) {
  return new Date(value).getTime();
}

/** When the decision on record was made; 0 for a request that has none. */
function decidedTime(approval: Approval) {
  return approval.decidedAt ? timeOf(approval.decidedAt) : 0;
}

function approvalKind(approval: Approval): string {
  return approval.type === "request_board_approval" && isEmailReplyPayload(approval.payload)
    ? EMAIL_REPLY_KIND
    : approval.type;
}

function kindLabel(kind: string): string {
  return kind === EMAIL_REPLY_KIND ? "Email replies" : (typeLabel[kind] ?? kind);
}

/** The name a request goes by on its card, in its compact row and in announcements. */
function approvalDisplaySubject(approval: Approval): string {
  return (
    approvalExcerpt(approvalSubject(approval.payload, approval.type), APPROVAL_TITLE_LENGTH) ?? typeLabel[approval.type] ?? approval.type
  );
}

/**
 * The line beside the sort control, for readers with keyboard shortcuts on. It says what the keys
 * do: Shift+A, Shift+C and Shift+X are handled by the open card, so they act only while focus is
 * inside it; J, K, a click or Tab puts it there.
 */
export const APPROVAL_SHORTCUT_HINT =
  "J / K move to a request and open it · With focus in the open request: Shift+A approve, Shift+C request changes, Shift+X reject · Shift+Z undo approve";

/** "revision_requested" as it is spoken: "Revision requested". */
function statusWords(status: string): string {
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Shown on a request whose held approval was taken back because the requester revised it first. */
const HOLD_REVISED_TEXT = "Not approved. The requester revised this request before your approval was sent.";
/** Shown on a request whose held approval was taken back because it was sent back for changes first. */
const HOLD_SENT_BACK_TEXT = "Not approved. This request was sent back for changes before your approval was sent.";

const DECISION_LANDED_LEAD: Record<ApprovalDecisionKind, string> = {
  approve: "Approved",
  reject: "Rejected",
  revision: "Changes requested",
};

/**
 * What is left of a card once it is decided here, so the queue keeps its place.
 * It can always take focus, so a decision never drops focus on the page.
 *
 * An approval is first `held`: nothing has been sent, the row counts down and offers Undo.
 * The same row then shows the request being sent and, once it lands, the decision, so focus
 * resting on the row stays there throughout.
 *
 * Once the pointer has moved onto a held row, and while keyboard focus is on its Undo button, the
 * hold does not run out: the reader who has reached Undo is not raced by the clock. A row that is
 * only drawn or scrolled under a pointer at rest does not pause, and a hold stands still for
 * `APPROVE_PAUSE_LIMIT_MS` at most; after that the row says the pause is over and counts down.
 *
 * `elsewhere` marks a row whose decision was not made on this page: it shows the record as the
 * server holds it, and does not call its note the reader's own.
 */
function DecidedApprovalRow({
  approval,
  held = null,
  elsewhere = false,
  detailsState,
  onUndo,
  onPause,
  onResume,
}: {
  approval: Approval;
  held?: HeldApproval | null;
  elsewhere?: boolean;
  /** Carried by "View details": the queue address the request's own page links back to. */
  detailsState?: ApprovalQueueLinkState;
  onUndo?: () => void;
  onPause?: (reason: ApprovalHoldPauseReason) => void;
  onResume?: (reason: ApprovalHoldPauseReason) => void;
}) {
  const subject = held?.subject ?? approvalDisplaySubject(approval);
  const note = held ? held.note : approval.decisionNote;
  const holding = held?.phase === "holding";
  const pauseHintId = useId();
  const resumeRef = useRef(onResume);
  resumeRef.current = onResume;
  // A row that leaves the page takes the pointer and the focus that paused its hold with it.
  useEffect(() => {
    if (!holding) return;
    return () => {
      resumeRef.current?.("pointer");
      resumeRef.current?.("focus");
    };
  }, [holding]);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        ROW_SCROLL_MARGIN,
      )}
      // The page moves focus to this row after a decision. The name says what the row is and which
      // request it holds; the countdown is not part of it, so the name does not change every second.
      role="group"
      aria-label={`${held ? "Approval held" : statusWords(approval.status)}: ${subject}`}
      data-approval-card={approval.id}
      data-approval-decided-row={held ? undefined : ""}
      data-approval-held-row={held ? held.phase : undefined}
      tabIndex={-1}
      // Only a movement of the pointer over the row pauses the hold. The browser also reports a pointer
      // "entering" a row that was drawn or scrolled under it while it lay still, and that is not the
      // reader reaching for Undo. A finger has no resting place: only a mouse or a pen pauses.
      onPointerMove={
        holding
          ? (event: PointerEvent<HTMLDivElement>) => {
              if (event.pointerType !== "touch") onPause?.("pointer");
            }
          : undefined
      }
      onPointerLeave={holding ? () => onResume?.("pointer") : undefined}
    >
      {held ? (
        <span className="text-xs font-medium text-foreground" data-approval-hold-status="">
          {held.phase === "holding" ? (
            <ApprovalHoldCountdown
              sendAt={held.sendAt}
              pausedMs={held.pausedMs ?? null}
              pauseUsedUp={held.pauseUsedUp ?? false}
            />
          ) : (
            "Approving..."
          )}
        </span>
      ) : (
        <StatusBadge status={approval.status} />
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{subject}</span>
      {!held && elsewhere && (
        <span className="text-xs text-muted-foreground" data-approval-decided-elsewhere="">
          Decided elsewhere
        </span>
      )}
      {held ? (
        held.phase === "holding" && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={onUndo}
              onFocus={() => onPause?.("focus")}
              onBlur={() => onResume?.("focus")}
              aria-label={`Undo approval: ${subject}`}
              aria-describedby={pauseHintId}
              data-approval-undo=""
            >
              Undo
            </Button>
            <span id={pauseHintId} className="sr-only">
              {held.pauseUsedUp
                ? "The pause is over: the approval is sent when its countdown ends, also while focus is on this button."
                : `The approval is not sent while focus is on this button, for up to ${APPROVE_PAUSE_LIMIT_MS / 1000} seconds in all.`}
            </span>
          </>
        )
      ) : (
        <Link
          to={`/approvals/${approval.id}`}
          state={detailsState}
          className={APPROVAL_DETAILS_LINK_CLASS}
          aria-label={`View details: ${subject}`}
        >
          View details
        </Link>
      )}
      {note && (
        <p className="basis-full whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground" data-approval-row-note>
          <span className="font-medium text-foreground">{elsewhere ? "Decision note." : "Your note."}</span> {note}
        </p>
      )}
    </div>
  );
}

/**
 * A request the board sent back for changes. It carries no decision buttons:
 * the version on record is the one the board asked to change, and the detail
 * page still offers Approve and Reject for it.
 */
function SentBackApprovalRow({ approval, detailsState }: { approval: Approval; detailsState?: ApprovalQueueLinkState }) {
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        ROW_SCROLL_MARGIN,
      )}
      data-approval-sent-back-row={approval.id}
      // A link to this request brings the reader here, so the row is named for what it holds.
      aria-label={`${statusWords(approval.status)}: ${approvalDisplaySubject(approval)}`}
      tabIndex={-1}
    >
      <StatusBadge status={approval.status} />
      <span className="min-w-0 flex-1 break-words text-sm font-medium text-foreground">
        {approvalDisplaySubject(approval)}
      </span>
      <ApprovalSentBackTime approval={approval} className="text-xs text-muted-foreground" />
      <Link
        to={`/approvals/${approval.id}`}
        state={detailsState}
        className={APPROVAL_DETAILS_LINK_CLASS}
        aria-label={`View details: ${approvalDisplaySubject(approval)}`}
      >
        View details
      </Link>
      <ApprovalChangesAskedFor note={approval.decisionNote} className="basis-full" />
    </li>
  );
}

export function Approvals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  // Upstream v2026.1005.0 removed the shortcut setting; shortcuts are always on
  // (production had them enabled instance-wide before the upgrade).
  const keyboardShortcutsEnabled = true;
  const toasts = useOptionalToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";
  // The bare /approvals address shows To decide (see the route in App.tsx); the address is then
  // corrected in place, once, with whatever the navigation carried. This page stays mounted while
  // that happens, so held approvals, typed texts and the revisions on record are not lost.
  const onBareRoute = isBareApprovalsPath(location.pathname);
  const { search: locationSearch, hash: locationHash, state: locationState } = location;
  useEffect(() => {
    if (!onBareRoute) return;
    navigate(
      { pathname: "/approvals/pending", search: locationSearch, hash: locationHash },
      { replace: true, state: locationState },
    );
  }, [onBareRoute, navigate, locationSearch, locationHash, locationState]);
  // In-flight state and the last error are kept per request, so each card answers for its own decision.
  const decisions = useApprovalDecisionFeedback();
  const { settle: settleDecision, clearErrors: clearDecisionErrors } = decisions;
  // Read out by screen readers when a decision lands or fails; a new entry is announced even when its text repeats.
  const [announcement, setAnnouncement] = useState<{ seq: number; text: string } | null>(null);
  // How many cards the page shows. The compact rows left by decisions are not counted against it.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [view, setView] = useState<ViewMode>(readStoredView);
  // The open card of a collapsible list. Undefined until one is picked: under "To decide" the first
  // card is then pinned as the open one, once, and "All decisions" opens none. After that the open
  // card changes only by the reader's action or a decision, never because the list reloaded.
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  // The kind filter and the sort live in the address (?kind=<kind>&sort=<order>), so a reload and
  // the way back from "View details" show the same view. A tab link carries no query, so a change
  // of tab returns both to their defaults.
  const [searchParams, setSearchParams] = useSearchParams();
  const kindFilter = searchParams.get("kind") ?? "all";
  // The oldest request has waited longest, so it leads the queue; history reads newest first.
  const defaultSort: SortOrder = statusFilter === "pending" ? "oldest" : "newest";
  const sortParam = searchParams.get("sort");
  const sortOrder: SortOrder = sortParam === "oldest" || sortParam === "newest" ? sortParam : defaultSort;
  // The search term is not part of the address: it is typed to find one request, not to keep a view.
  const [searchText, setSearchText] = useState("");
  const searchTerm = searchText.trim().toLowerCase();
  // Approvals decided on this visit stay listed as a compact row, so deciding
  // one request does not move the rest of the queue or leave the page.
  const [decidedHere, setDecidedHere] = useState<Record<string, Approval>>({});
  // Requests the reader was at (open, or last in focus) when someone else decided them. They keep
  // their place as a compact row too, so the reader's place and focus do not vanish with them.
  const [leftHere, setLeftHere] = useState<Record<string, true>>({});
  // Requests sent back for changes sit below the queue, folded away until asked for.
  const [showSentBack, setShowSentBack] = useState(false);
  // What the board has typed and not sent, per request: the text and the panel it was typed in.
  // A card's controls are drawn again whenever it is closed and opened, paged, filtered, sorted or
  // switched between the views, and after an approval is undone or fails; they start from this
  // copy. The text is kept outside rendering, so typing does not redraw the queue.
  const drafts = useRef(new Map<string, ApprovalDraft>());
  // Which requests hold such a text, and in which panel: a closed row says so.
  const [draftModes, setDraftModes] = useState<Record<string, ApprovalNoteMode>>({});
  // The version first shown of each request on this visit, and the revisions the reader confirmed.
  // It outlasts a card leaving the page, so a request that returns changed is still held back.
  const [revisionMemory] = useState(createApprovalRevisionMemory);
  const listRef = useRef<HTMLDivElement>(null);
  const sentBackListRef = useRef<HTMLUListElement>(null);
  // The row that last held focus. J and K continue from it when focus has left the list.
  const lastFocusedId = useRef<string | null>(null);
  const pendingMove = useRef<QueueMove | null>(null);
  const [moveSeq, setMoveSeq] = useState(0);
  // What the last render listed, for the handlers that run when a decision lands.
  const queueRef = useRef<{
    rows: Array<{ id: string; undecided: boolean }>;
    openId: string | null;
    collapsible: boolean;
    advances: boolean;
  }>({ rows: [], openId: null, collapsible: true, advances: true });
  // The undecided cards the page showed after its last draw, and the one that was open, to tell
  // when one of them has been decided somewhere else.
  const shownCards = useRef<{ pending: Set<string>; openId: string | null }>({ pending: new Set(), openId: null });
  // A row that became compact because its request was decided elsewhere, and should take the focus its card held.
  const refocusLeftRow = useRef<string | null>(null);
  // When a card was last opened where an Approve press may not be meant for it: by the page itself
  // (after a decision, or because the list that loaded has another first card than the one shown
  // while it loaded), or by the reader pressing a row's header. Null once the reader has moved with
  // J/K or undone a hold. See APPROVE_AFTER_ADVANCE_MS.
  const autoAdvance = useRef<number | null>(null);
  // Requests whose own approval went out on this visit and came back as an error. The server may
  // hold that approval all the same: a reload that then shows the request approved shows the
  // reader's own decision, not someone else's.
  const ownApproveFailed = useRef(new Set<string>());
  // The card shown open, not yet pinned, while the list was still loading.
  const shownUnpinned = useRef<string | null>(null);
  const handledHash = useRef<string | null>(null);
  // What the page shows now, for an approval that settles after the reader has moved on or left.
  const shownRef = useRef<{ mounted: boolean; companyId: string | null }>({ mounted: false, companyId: null });
  const undoLatestRef = useRef<() => boolean>(() => false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Approvals" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    shownRef.current.mounted = true;
    return () => {
      shownRef.current.mounted = false;
    };
  }, []);

  const rowElements = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-approval-card]") ?? []);
  const rowElement = (id: string) => rowElements().find((row) => row.dataset.approvalCard === id) ?? null;
  const sentBackRowElement = (id: string) =>
    Array.from(sentBackListRef.current?.querySelectorAll<HTMLElement>("[data-approval-sent-back-row]") ?? []).find(
      (row) => row.dataset.approvalSentBackRow === id,
    ) ?? null;
  const requestMove = (move: QueueMove) => {
    pendingMove.current = move;
    setMoveSeq((seq) => seq + 1);
  };
  /**
   * The reader picks the open card themselves: by its header, by Undo or by Show more. Undefined
   * leaves the choice to the list again (its first card), after the reader refiltered or reordered it.
   */
  const openByReader = (id: string | null | undefined) => {
    autoAdvance.current = null;
    // The list starts again by the reader's own choice: its first card is theirs, not one the page swapped in.
    if (id === undefined) shownUnpinned.current = null;
    setOpenId(id);
    // The card that was open closes, and when it sat above the pressed row the list moves up by its
    // height: the card just opened is brought back into view. Undo and Show more ask for their own
    // move right after this one, and that one counts.
    if (typeof id === "string") requestMove({ targetId: id, focus: false, block: "nearest", readFromTop: true });
  };

  // Runs after the list has drawn the change that asked for the move: the opened card has its
  // full height and the decided card is already its compact row.
  useLayoutEffect(() => {
    const move = pendingMove.current;
    if (!move) return;
    pendingMove.current = null;
    const decidedRow = move.decidedId ? rowElement(move.decidedId) : null;
    const target = move.sentBackId
      ? sentBackRowElement(move.sentBackId)
      : move.targetId
        ? rowElement(move.targetId)
        : null;
    if (move.scrollDecidedToTop) decidedRow?.scrollIntoView?.({ block: "start" });
    if (move.focus) (target ?? decidedRow)?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: move.block ?? "nearest" });
    // "nearest" shows the end of a card taller than the screen when the card lies above it.
    if (move.readFromTop && target && isAboveScrollArea(target)) target.scrollIntoView?.({ block: "start" });
    // The row a decision left behind carries Undo for a few seconds, and so do the rows of earlier
    // approvals whose hold is still running. The next card must not push any of them out of sight:
    // the first of them goes to the top, with the others and the next card under it. A next card
    // too tall for that loses its end from view, not their Undo. Only holds near the decided row
    // count (within half a window above its end): one started far up the list stays where it is,
    // or the card just opened would be the one out of sight.
    if (target && decidedRow) {
      let first = decidedRow;
      const reach = decidedRow.getBoundingClientRect().bottom - window.innerHeight / 2;
      for (const held of Object.values(heldApprovals)) {
        if (held.phase !== "holding") continue;
        const row = rowElement(held.id);
        if (!row) continue;
        const top = row.getBoundingClientRect().top;
        if (top < first.getBoundingClientRect().top && top > reach) first = row;
      }
      if (isAboveScrollArea(first)) first.scrollIntoView?.({ block: "start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveSeq]);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // Compared without case, together with Shift: with Caps Lock on the browser reports "J", "K"
      // and, with Shift, "z". Shift+J and Shift+K stay unused, and a plain "z" undoes nothing.
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && event.shiftKey;
      const isMove = (key === "j" || key === "k") && !event.shiftKey;
      if (!isMove && !isUndo) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isKeyboardShortcutTextInputTarget(event.target) || hasBlockingShortcutDialog(document)) return;
      // The shortcuts cheatsheet and other dialogs of the app are not marked modal: the queue must
      // not move, and nothing must be undone, behind any of them.
      if (event.target instanceof Element && event.target.closest("[role='dialog'], [role='alertdialog']")) return;
      if (document.querySelector(OPEN_DIALOG_SELECTOR)) return;
      if (isUndo) {
        // Shift+Z takes back the approval held most recently. A held key undoes one, not all of them.
        if (!event.repeat && undoLatestRef.current()) event.preventDefault();
        return;
      }
      const cards = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-approval-card]") ?? []);
      if (cards.length === 0) return;
      const active = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>("[data-approval-card]")
        : null;
      let current = active ? cards.indexOf(active) : -1;
      // Focus on the page or outside the list: carry on from the row that last held it, not from the top.
      if (current < 0 && lastFocusedId.current) {
        current = cards.findIndex((card) => card.dataset.approvalCard === lastFocusedId.current);
      }
      const next = current < 0
        ? 0
        : Math.max(0, Math.min(cards.length - 1, current + (key === "j" ? 1 : -1)));
      event.preventDefault();
      const row = cards[next];
      const id = row.dataset.approvalCard ?? null;
      if (!id) return;
      lastFocusedId.current = id;
      // Moving to a request opens it; a compact decided or held row has nothing to open.
      const compactRow = row.hasAttribute("data-approval-decided-row") || row.hasAttribute("data-approval-held-row");
      autoAdvance.current = null;
      setOpenId(compactRow ? null : id);
      // A request taller than the window is shown from its top, as when it is opened by its header.
      pendingMove.current = { targetId: id, focus: true, readFromTop: true };
      setMoveSeq((seq) => seq + 1);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [keyboardShortcutsEnabled]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const announce = (text: string) =>
    setAnnouncement((current) => ({ seq: (current?.seq ?? 0) + 1, text }));

  /** Keeps what the board typed for a request, with its panel, or forgets it when the text is empty or discarded. */
  const storeDraft = useCallback((id: string, text: string, mode: ApprovalNoteMode | null) => {
    const kept = mode && text.trim() ? mode : null;
    if (kept) drafts.current.set(id, { text, mode: kept });
    else drafts.current.delete(id);
    setDraftModes((current) => {
      if ((current[id] ?? null) === kept) return current;
      const next = { ...current };
      if (kept) next[id] = kept;
      else delete next[id];
      return next;
    });
  }, []);

  // These run once for every decision sent, also when several are on their way at once.
  const recordDecided = (action: ApprovalDecisionKind, approval: Approval, subject: string, companyId: string) => {
    settleDecision(approval.id);
    setDecidedHere((current) => ({ ...current, [approval.id]: approval }));
    // The text went out with the decision.
    storeDraft(approval.id, "", null);
    // A request the board sends back returns as a new version by the board's own wish, as a closed
    // row to be opened and read: it starts again from the version that comes back.
    revisionMemory.delete(approval.id);
    announce(`${DECISION_LANDED_LEAD[action]}: ${subject}`);
    // The list is corrected with the decided record at once, before its reload answers. The rows
    // decided on this visit are forgotten on a change of tab, and a list that still called this
    // request pending would then show its card again, Approve ready, for a second approval.
    queryClient.setQueryData<Approval[]>(queryKeys.approvals.list(companyId), (list) =>
      list?.map((listed) =>
        listed.id === approval.id && timeOf(listed.updatedAt) <= timeOf(approval.updatedAt) ? approval : listed,
      ),
    );
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approval.id) });
  };
  const recordFailed = (action: ApprovalDecisionKind, err: unknown, id: string, subject: string, companyId: string) => {
    settleDecision(id, approvalDecisionErrorText(action, err));
    announce(approvalDecisionErrorText(action, err, subject));
    // An error does not prove the decision was not stored: reload, so the card shows the status the server holds.
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(id) });
  };
  const handleDecided = (action: ApprovalDecisionKind) => (approval: Approval, { id, subject }: Decision) => {
    recordDecided(action, approval, subject, approval.companyId);
    advanceFrom(id);
  };
  const handleFailed = (action: ApprovalDecisionKind) => (err: unknown, { id, subject, companyId }: Decision) => {
    recordFailed(action, err, id, subject, companyId);
  };

  /** A card returns after its approval was undone or failed: the note that was to go with it is its draft again. */
  const restoreCard = (held: HeldApproval) => {
    if (held.note) storeDraft(held.id, held.note, "note");
    // The returning card joins the page; nothing that was on the page leaves it to make room.
    setVisibleCount((count) => count + 1);
  };

  /**
   * The server refused a held approval because its request changed after Approve was pressed: the
   * reload that would have taken the hold back had not arrived, or the hold was sent at once
   * because the page was left. Nothing was stored. The hold ends as a take-back does: the same
   * line on the request, the same announcement, never an approval. It is not sent again.
   */
  const takeBackRefusedHold = (
    held: HeldApproval,
    conflict: ApprovalVersionConflict,
    at: { heldRow: HTMLElement | null; onPage: boolean; inView: boolean },
  ) => {
    const status = conflict.currentStatus;
    const sentBack = status === "revision_requested";
    // Approved, rejected or cancelled by someone else. Anything else is a request that is pending in another version.
    const decided = status !== null && status !== "pending" && !sentBack;
    const hadFocus = Boolean(at.heldRow?.contains(document.activeElement));
    releaseHeldApproval(held.id);
    if (status === "approved" && ownApproveFailed.current.has(held.id)) {
      // The reader's first approval was stored though it was answered with an error, and this
      // second one was refused for it: the row and the count show the approval as their own
      // decision, as when a reload shows it, and nothing is said about another session.
      const listed = queryClient
        .getQueryData<Approval[]>(queryKeys.approvals.list(held.companyId))
        ?.find((candidate) => candidate.id === held.id);
      settleDecision(held.id);
      if (listed) {
        // The note is the one typed with this press, until the reload brings the stored one.
        const own = {
          ...listed,
          status: "approved",
          decisionNote: held.note ?? null,
          updatedAt: conflict.currentUpdatedAt ? new Date(conflict.currentUpdatedAt) : listed.updatedAt,
        } as Approval;
        setDecidedHere((current) => ({ ...current, [held.id]: own }));
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(held.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(held.id) });
      announce(`${DECISION_LANDED_LEAD.approve}: ${held.subject}`);
      return;
    }
    // Otherwise not marked as an approval of the reader's own that may have been stored: the
    // refusal proves this one was not. An approval that shows up later is someone else's.
    if (decided || sentBack) {
      // The list says so at once, before its reload answers: the row then shows the status the
      // server named. The note of that decision is not known yet; the reload brings it.
      queryClient.setQueryData<Approval[]>(queryKeys.approvals.list(held.companyId), (list) =>
        list?.map((listed) =>
          listed.id === held.id && needsBoard(listed)
            ? ({
                ...listed,
                status: status as Approval["status"],
                decisionNote: null,
                updatedAt: conflict.currentUpdatedAt ? new Date(conflict.currentUpdatedAt) : listed.updatedAt,
              } as Approval)
            : listed,
        ),
      );
    }
    if (decided) {
      // As when a reload shows it decided elsewhere: a row with its status, and the note kept as a draft.
      settleDecision(held.id);
      if (held.note) storeDraft(held.id, held.note, "note");
      setLeftHere((current) => ({ ...current, [held.id]: true }));
    } else {
      settleDecision(held.id, sentBack ? HOLD_SENT_BACK_TEXT : HOLD_REVISED_TEXT);
      restoreCard(held);
    }
    // The reload brings the version the server holds; Approve on a revised request then waits for "I have reviewed it".
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(held.companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(held.id) });
    const statusText = decided ? statusWords(status).toLowerCase() : null;
    announce(
      statusText
        ? `Not approved: ${held.subject}. Nothing was sent. Its status is now ${statusText}: decided elsewhere.`
        : sentBack
        ? `Not approved: ${held.subject}. It was sent back for changes before your approval was sent. Nothing was sent.`
        : `Not approved: ${held.subject}. The requester revised it before it was sent. Nothing was sent.`,
    );
    // A row out of view, or a page that no longer shows the request, cannot say it: then it is said
    // where the reader is. So it is when the reader sent this request back earlier on this visit:
    // it is drawn as a "decided elsewhere" row, which has no place for the line.
    if (!at.inView || (sentBack && Boolean(decidedHere[held.id]))) {
      toasts?.pushToast({
        title: `Not approved: ${held.subject}`,
        body: statusText
          ? `Its status is now ${statusText}: decided elsewhere. Nothing was sent.`
          : sentBack
          ? "It was sent back for changes before your approval was sent. Nothing was sent."
          : "The requester revised it before your approval was sent. Nothing was sent.",
        tone: "warn",
        ttlMs: 15_000,
        dedupeKey: `approval-hold-revised:${held.id}`,
        action: {
          label: "View request",
          // Asked when it is pressed: the queue row while the queue shows the request, its own page otherwise.
          onClick: () => {
            const now = shownRef.current;
            if (now.mounted && now.companyId === held.companyId && rowElement(held.id)) {
              requestMove({ targetId: held.id, focus: true });
            } else {
              navigate(`/approvals/${held.id}`);
            }
          },
        },
      });
    }
    if (at.onPage && hadFocus) {
      lastFocusedId.current = held.id;
      requestMove({ targetId: held.id, focus: true });
    }
  };

  /**
   * The undo window of a held approval is over, or the page is about to stop showing it: the
   * request goes out, marked to outlive the page. Called once for a hold, by `useApprovalHolds`.
   */
  const sendHeldApproval = (held: HeldApproval) => {
    // The Undo button leaves the row now; focus resting on it stays with the row.
    const row = rowElement(held.id);
    const active = document.activeElement;
    if (row && active instanceof HTMLElement && active.hasAttribute("data-approval-undo") && row.contains(active)) {
      row.focus({ preventScroll: true });
    }
    new Promise<Approval>((resolve) =>
      resolve(
        // With the version the hold began with: the server refuses the approval of any later one.
        approvalsApi.approve(held.id, held.note, { keepalive: true, expectedUpdatedAt: held.expectedUpdatedAt }),
      ),
    ).then(
      (approval) => {
        releaseHeldApproval(held.id);
        // The reader was moved on when the hold began, so nothing moves now.
        recordDecided("approve", approval, held.subject, held.companyId);
      },
      (err: unknown) => {
        const shown = shownRef.current;
        // Asked of the page itself, before the hold is released: a row that a filter, the sort, the
        // page size or another tab has taken off the screen cannot show the error.
        const heldRow = rowElement(held.id);
        const onPage = shown.mounted && shown.companyId === held.companyId && Boolean(heldRow);
        // Measured now, while the request is still its compact row: the card that returns takes that place.
        const inView = onPage && isRowInView(heldRow);
        const versionConflict = approvalVersionConflict(err);
        if (versionConflict) {
          takeBackRefusedHold(held, versionConflict, { heldRow, onPage, inView });
          return;
        }
        releaseHeldApproval(held.id);
        ownApproveFailed.current.add(held.id);
        recordFailed("approve", err, held.id, held.subject, held.companyId);
        // The note is handed back with the card, also when the card is only seen again later.
        restoreCard(held);
        const toastFailure = () =>
          toasts?.pushToast({
            title: approvalDecisionErrorText("approve", err, held.subject),
            tone: "error",
            ttlMs: 15_000,
            dedupeKey: `approval-hold-failed:${held.id}`,
            // Asked when it is pressed, not now: the reader may leave the queue while the toast is up.
            // While the queue still shows the request the press stays on it and goes to the row. On a
            // phone the toast lies where the open request's Approve rests, and a tap meant for that
            // button must not leave the queue. Otherwise it opens the request's own page.
            action: {
              label: "View request",
              onClick: () => {
                const now = shownRef.current;
                if (now.mounted && now.companyId === held.companyId && rowElement(held.id)) {
                  requestMove({ targetId: held.id, focus: true });
                } else {
                  navigate(`/approvals/${held.id}`);
                }
              },
            },
          });
        if (!onPage) {
          // The page does not show the request (the reader left, or changed company, tab, filter or sort): say so where they are.
          toastFailure();
          return;
        }
        const queue = queueRef.current;
        const focused = document.activeElement;
        const focusedRow = focused instanceof HTMLElement ? focused.closest<HTMLElement>("[data-approval-card]") : null;
        const inAnotherRow = focusedRow !== null && focusedRow.dataset.approvalCard !== held.id;
        const readingAnother =
          queue.collapsible &&
          queue.openId !== null &&
          queue.openId !== held.id &&
          queue.rows.some((candidate) => candidate.id === queue.openId && candidate.undecided);
        // The reader is at another request, or typing. Nothing is opened or closed and focus stays
        // where it is, as after a failed rejection: the failed request's row shows the error. Only
        // when that row is out of view is the failure also raised as a toast: the toast comes up in
        // the corner where the open request's Approve button rests, and would cover it.
        if (inAnotherRow || readingAnother || isKeyboardShortcutTextInputTarget(focused)) {
          if (!inView) toastFailure();
          return;
        }
        // Focus on a control outside the list stays there; anywhere else it goes to the card that came back.
        const elsewhere =
          focused instanceof HTMLElement &&
          focused !== document.body &&
          !listRef.current?.contains(focused) &&
          !(listRef.current && focused.contains(listRef.current));
        setOpenId(held.id);
        if (!elsewhere) lastFocusedId.current = held.id;
        requestMove({ targetId: held.id, focus: !elsewhere });
      },
    );
  };
  const {
    held: heldApprovals,
    hold: holdApproval,
    undo: cancelHeldApproval,
    release: releaseHeldApproval,
    flush: flushHeldApprovals,
    pause: pauseHeldApproval,
    resume: resumeHeldApproval,
    latestRunningId: latestHeldApprovalId,
  } = useApprovalHolds({
    send: sendHeldApproval,
    // Said once, when the countdown starts again by itself; the seconds are not read out one by one.
    // The pointer or focus that paused the hold may still be on its row, so the row says it too.
    onPauseLimit: (held) => {
      const seconds = approvalHoldSecondsLeft(held);
      announce(
        `The pause is over: approving in ${seconds} second${seconds === 1 ? "" : "s"}. Undo is in its row. ${held.subject}`,
      );
    },
  });

  /**
   * Takes back a held approval: nothing is sent, and its card returns open, in focus, with its note.
   * When the request stopped being pending during the hold, its row stays instead, with its status.
   */
  const undoHeldApproval = (id: string) => {
    const held = cancelHeldApproval(id);
    // Too late: the request has been sent.
    if (!held) return false;
    settleDecision(id);
    // Asked of the loaded list itself: a reload may have reached it and not the page yet.
    const record = queryClient
      .getQueryData<Approval[]>(queryKeys.approvals.list(held.companyId))
      ?.find((listed) => listed.id === id);
    if (record && !needsBoard(record)) {
      // Sent back or decided somewhere else during the hold: there is no card to return to, and the
      // card the reader is at stays open. The request keeps its place as a row with its real status.
      if (held.note) storeDraft(id, held.note, "note");
      setLeftHere((current) => ({ ...current, [id]: true }));
      announce(
        `Not approved: ${held.subject}. Nothing was sent. Its status is now ${statusWords(record.status).toLowerCase()}: decided elsewhere.`,
      );
      autoAdvance.current = null;
      lastFocusedId.current = id;
      requestMove({ targetId: id, focus: true });
      return true;
    }
    restoreCard(held);
    announce(`Not approved: ${held.subject}. Nothing was sent.`);
    openByReader(id);
    lastFocusedId.current = id;
    requestMove({ targetId: id, focus: true });
    return true;
  };
  undoLatestRef.current = () => {
    const id = latestHeldApprovalId();
    return id ? undoHeldApproval(id) : false;
  };

  const rejectMutation = useMutation({
    mutationFn: ({ id, note, expectedUpdatedAt }: Decision) =>
      approvalsApi.reject(id, note || undefined, { expectedUpdatedAt }),
    onSuccess: handleDecided("reject"),
    onError: handleFailed("reject"),
  });

  const revisionMutation = useMutation({
    mutationFn: ({ id, note, expectedUpdatedAt }: Decision) =>
      approvalsApi.requestRevision(id, note, { expectedUpdatedAt }),
    onSuccess: handleDecided("revision"),
    onError: handleFailed("revision"),
  });

  /**
   * A decision landed on `id`: its card is about to become a compact row. The next undecided
   * request after it opens (failing that, the nearest one before it), and the reader is taken
   * there unless they have already moved on to something else.
   */
  const advanceFrom = (id: string) => {
    const queue = queueRef.current;
    const card = rowElement(id);
    const active = document.activeElement;
    // Still at this request: focus is inside its card, or on the page (or a pane around the list)
    // because the pressed button is gone or never took focus. Focus in another row or on another
    // control means the reader has moved on.
    const readerIsHere =
      !active ||
      active === document.body ||
      Boolean(card?.contains(active)) ||
      Boolean(listRef.current && active.contains(listRef.current));
    // In the compact view the reader may have opened another request while this decision was on its way.
    const stillCurrent = !queue.collapsible || queue.openId === id || queue.openId === null;
    if (!stillCurrent) return;
    const index = queue.rows.findIndex((row) => row.id === id);
    const isNext = (row: { id: string; undecided: boolean }) => row.undecided && row.id !== id;
    const next =
      queue.advances && index >= 0
        ? (queue.rows.slice(index + 1).find(isNext) ?? queue.rows.slice(0, index).reverse().find(isNext) ?? null)
        : null;
    // The page opens this card, not the reader, and every card below the decided one moves up: an
    // Approve button may now sit under a pointer that is halfway through a double click.
    autoAdvance.current = next ? Date.now() : null;
    setOpenId(next?.id ?? null);
    if (!readerIsHere) return;
    lastFocusedId.current = next?.id ?? id;
    requestMove({
      targetId: next?.id ?? null,
      decidedId: id,
      focus: true,
      scrollDecidedToTop: card ? card.getBoundingClientRect().top < scrollAreaTop(card) : false,
    });
  };

  const decide = (approval: Approval, action: ApprovalDecisionKind, note?: string) => {
    if (action === "approve") {
      // The second press of a double click (or a second Shift+A) just after the page has moved on by
      // itself approves nothing, whichever card it lands on: in the Full cards view the cards below
      // the decided one all move up, and any of their Approve buttons can come to rest under the
      // pointer. The same holds just after the reader opened a row by its header: the row opens
      // where the header was. Nothing is marked busy, so the same press works once the moment has passed.
      const advancedAt = autoAdvance.current;
      if (advancedAt !== null && Math.abs(Date.now() - advancedAt) < APPROVE_AFTER_ADVANCE_MS) return;
    }
    // A request whose decision is held or still on its way is not sent a second one.
    if (!decisions.start(approval.id, action)) return;
    const decision: Decision = {
      id: approval.id,
      note,
      subject: approvalDisplaySubject(approval),
      companyId: approval.companyId,
      // The request as this card draws it now. A hold keeps this value until it is sent.
      expectedUpdatedAt: approval.updatedAt,
    };
    if (action === "reject") rejectMutation.mutate(decision);
    else if (action === "revision") revisionMutation.mutate(decision);
    else {
      // An approval cannot be reversed once the server has it, so it is held here first. The card
      // becomes its compact row and the reader moves on at once, as if the decision had landed.
      if (!holdApproval(decision)) {
        settleDecision(approval.id);
        return;
      }
      // The time and the way back come first: a long title must not use up the seconds it takes to say them.
      announce(
        `Approving in ${APPROVE_HOLD_MS / 1000} seconds. ${
          keyboardShortcutsEnabled ? "Shift+Z undoes it." : "Undo is in its row."
        } ${decision.subject}`,
      );
      advanceFrom(approval.id);
    }
  };

  // A request whose decision came back as an error stays listed with that error, whatever status the reload shows.
  // So does one whose decision is held or on its way, even when a reload already shows it decided, and
  // one the reader was at when someone else decided it.
  const inTab = (data ?? []).filter(
    (a) =>
      statusFilter === "all" ||
      needsBoard(a) ||
      Boolean(decidedHere[a.id]) ||
      Boolean(leftHere[a.id]) ||
      Boolean(decisions.errors[a.id]) ||
      Boolean(decisions.inFlight[a.id]) ||
      Boolean(heldApprovals[a.id]),
  );
  // Everything else that was sent back waits on its requester. The kind filter and the sort do not apply to it.
  const listedIds = new Set(inTab.map((a) => a.id));
  const sentBack = (data ?? [])
    .filter((a) => statusFilter === "pending" && isSentBack(a) && !listedIds.has(a.id))
    .sort((a, b) => timeOf(approvalSentBackAt(a)) - timeOf(approvalSentBackAt(b)));
  const kinds = Array.from(new Set(inTab.map(approvalKind)));
  const activeKind = kinds.includes(kindFilter) ? kindFilter : "all";
  // The requests the search term is found in, whatever the case: in the subject, the requester's
  // name, the summary or the recommendation. Null while no term is set.
  const searchMatches = useMemo(() => {
    if (!searchTerm) return null;
    const agentNames = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
    const found = new Set<string>();
    for (const approval of data ?? []) {
      const texts = [
        approvalDisplaySubject(approval),
        approval.requestedByAgentId ? agentNames.get(approval.requestedByAgentId) : null,
        approval.payload?.summary,
        approvalDecisionBrief(approval.payload).recommendation,
      ];
      if (texts.some((text) => typeof text === "string" && text.toLowerCase().includes(searchTerm))) {
        found.add(approval.id);
      }
    }
    return found;
  }, [data, agents, searchTerm]);
  const matchesSearch = (a: Approval) => !searchMatches || searchMatches.has(a.id);
  /**
   * Stays on the page whatever the kind filter and the page size say: an approval that is held
   * (its Undo must stay within reach), a request whose decision failed (its error must be seen),
   * the open card (an undone approval returns as the open card), and a "Decided elsewhere" row
   * (a held approval taken back must not vanish as if it had been sent).
   */
  const staysListed = (a: Approval) =>
    Boolean(heldApprovals[a.id]) || Boolean(decisions.errors[a.id]) || Boolean(leftHere[a.id]) || a.id === openId;
  const inActiveKind = (a: Approval) => activeKind === "all" || approvalKind(a) === activeKind;
  // "To decide" is ordered by the time a request was created. "All decisions" is ordered by the
  // time of the last decision; a request that has none (it is pending) keeps its creation time.
  // A request the reader decided in this tab keeps the place its creation time gave it until the
  // tab is changed, and so does one whose decision is on its way (an approval is, from the press
  // of Approve and through its hold) or failed, and one whose held approval was not sent because
  // it was decided elsewhere: the reader stays on the decided row, and no row moves under their hands.
  const keepsPlace = (a: Approval) =>
    Boolean(decidedHere[a.id] || leftHere[a.id] || decisions.inFlight[a.id] || decisions.errors[a.id]);
  const sortTime = (a: Approval) =>
    statusFilter === "all" && !needsBoard(a) && a.decidedAt && !keepsPlace(a)
      ? timeOf(a.decidedAt)
      : timeOf(a.createdAt);
  const filtered = inTab
    .filter((a) => (inActiveKind(a) && matchesSearch(a)) || staysListed(a))
    .sort((a, b) => {
      const delta = sortTime(a) - sortTime(b);
      return sortOrder === "oldest" ? delta : -delta;
    });

  /** The compact row a request is shown as (decided on this visit, or decided elsewhere under the reader), or null while it is a card. */
  const compactRowFor = (approval: Approval): CompactRow | null => {
    const decided = decidedHere[approval.id];
    if (decided) {
      const changedSince = timeOf(approval.updatedAt) > timeOf(decided.updatedAt);
      // A request sent back here and resubmitted since needs a decision again: its card returns.
      if (needsBoard(approval) && changedSince) return null;
      // Sent back here and then approved or rejected somewhere else: the row shows what the server holds now.
      // So does one sent back here, resubmitted, and sent back again by someone else: the status is
      // the same as the reader's own decision, but the decision is a later one, with another note.
      if (
        !needsBoard(approval) &&
        changedSince &&
        (approval.status !== decided.status || decidedTime(approval) > decidedTime(decided))
      ) {
        // Unless that later decision is the reader's own, still on its way: it is not called someone else's.
        return { record: approval, elsewhere: !decisions.inFlight[approval.id] };
      }
      return { record: decided, elsewhere: false };
    }
    if (leftHere[approval.id] && !needsBoard(approval)) return { record: approval, elsewhere: true };
    return null;
  };

  /** Shown as one compact row: decided on this visit or elsewhere, or an approval that is held or on its way. */
  const isCompactRow = (approval: Approval) =>
    Boolean(heldApprovals[approval.id]) || compactRowFor(approval) !== null;

  const pendingCount = (data ?? []).filter(needsBoard).length;
  // A held approval counts as decided: the reader has dealt with it unless they undo it.
  // A request someone else decided is not counted as the reader's.
  const decidedCount = (data ?? []).filter(
    (a) => Boolean(heldApprovals[a.id]) || (Boolean(decidedHere[a.id]) && isCompactRow(a)),
  ).length;
  // A decision counts as soon as it is made, before the reloaded list confirms it.
  const leftCount = (data ?? []).filter((a) => needsBoard(a) && !isCompactRow(a)).length;
  // Only cards count against the page size. Each decision therefore brings the next request onto
  // the page, and the page holds a full page of undecided requests for as long as more exist.
  // Past the end of the page only the rows that must stay within reach are added.
  const visible: Approval[] = [];
  let cardsShown = 0;
  let cardsOnPage = 0;
  let pageFull = false;
  for (const approval of filtered) {
    const card = !isCompactRow(approval);
    if (!pageFull && card && cardsShown >= visibleCount) pageFull = true;
    if (pageFull && !staysListed(approval)) continue;
    if (card) {
      cardsOnPage += 1;
      if (!pageFull) cardsShown += 1;
    }
    visible.push(approval);
  }
  const remaining = filtered.filter((a) => !isCompactRow(a)).length - cardsOnPage;

  // The number on a kind chip: the requests a press on it would list as cards. Under "To decide"
  // these are the undecided requests of that kind (still pending, and not decided or held on this
  // visit); under "All decisions" every request of that kind. A search term narrows the number as
  // it narrows the list. Rows that only stay listed (held, failed, the open card) are not added.
  const countsOnChip = (a: Approval) =>
    matchesSearch(a) && (statusFilter === "all" || (needsBoard(a) && !isCompactRow(a)));
  const kindCount = (kind: string) =>
    inTab.filter((a) => (kind === "all" || approvalKind(a) === kind) && countsOnChip(a)).length;
  // Said beside the search field: the requests of this tab and kind the term is found in.
  const foundCount = searchTerm ? inTab.filter((a) => inActiveKind(a) && matchesSearch(a)).length : 0;

  // "To decide" in the compact view opens one card at a time; "All decisions" always starts closed.
  // So does a list narrowed by a search term, in both views: its results are closed rows, and
  // nothing is decided from a closed row.
  const collapsibleList = statusFilter === "all" || view === "compact" || Boolean(searchTerm);
  const firstCardId = visible.find((a) => !isCompactRow(a))?.id ?? null;
  // Until the first card is pinned (a moment after the list has loaded) it is shown open already.
  const effectiveOpenId = openId === undefined ? (statusFilter === "pending" ? firstCardId : null) : openId;
  queueRef.current = {
    rows: filtered.map((a) => ({ id: a.id, undecided: needsBoard(a) && !isCompactRow(a) })),
    openId: effectiveOpenId,
    collapsible: collapsibleList,
    // Under "All decisions" the next undecided request can be far down the history; the reader stays where they are.
    advances: statusFilter === "pending",
  };
  shownRef.current.companyId = selectedCompanyId ?? null;

  // A request the reader was at stops being pending because someone else decided it (another
  // board member, the same person in another tab, the requester cancelling). Its card would vanish
  // under them. It keeps its place as a compact row with its new status instead, the change is
  // announced once, and focus that was in the card moves to the row.
  useLayoutEffect(() => {
    const refocus = refocusLeftRow.current;
    if (refocus) {
      refocusLeftRow.current = null;
      const active = document.activeElement;
      if (!active || active === document.body) rowElement(refocus)?.focus({ preventScroll: true });
    }
    const previous = shownCards.current;
    const pendingCards = visible.filter((a) => needsBoard(a) && !isCompactRow(a));
    shownCards.current = {
      pending: new Set(pendingCards.map((a) => a.id)),
      openId: pendingCards.some((a) => a.id === effectiveOpenId) ? effectiveOpenId : null,
    };
    if (statusFilter !== "pending" || !data) return;
    const byId = new Map(data.map((a) => [a.id, a]));
    const left: Approval[] = [];
    for (const id of new Set([previous.openId, lastFocusedId.current])) {
      if (!id || leftHere[id] || !previous.pending.has(id)) continue;
      const approval = byId.get(id);
      if (!approval || needsBoard(approval)) continue;
      // The reader's own decision (landed, held, on its way or failed) is reported by its own path.
      if (decidedHere[id] || heldApprovals[id] || decisions.inFlight[id] || decisions.errors[id]) continue;
      left.push(approval);
    }
    // A request that is pending again (resubmitted) is a card again, and can leave again later.
    const back = Object.keys(leftHere).filter((id) => {
      const approval = byId.get(id);
      return !approval || needsBoard(approval);
    });
    if (left.length === 0 && back.length === 0) return;
    setLeftHere((current) => {
      const next = { ...current };
      for (const id of back) delete next[id];
      for (const approval of left) next[approval.id] = true;
      return next;
    });
    if (left.length === 0) return;
    announce(
      left
        .map((approval) => `${statusWords(approval.status)}: ${approvalDisplaySubject(approval)}. Decided elsewhere.`)
        .join(" "),
    );
    const active = document.activeElement;
    const focusLost = !active || active === document.body;
    const focusedBefore = left.find((approval) => approval.id === lastFocusedId.current);
    if (focusLost && focusedBefore) refocusLeftRow.current = focusedBefore.id;
  });

  // An approval is held for the version the reader pressed Approve on. A hold can outlast a revision:
  // its five seconds stand still while the pointer rests on its row, and in that time the request
  // can be sent back somewhere else and resubmitted with another payload. Such a hold is taken
  // back before anything is sent. Its card returns as a closed row that says it was revised, and
  // Approve there waits for the confirmation like any revision that arrived under the reader.
  // The row also carries a line saying why the approval did not go out.
  // A hold is taken back the same way as soon as the list shows its request sent back for changes,
  // and as soon as the list shows it approved, rejected or cancelled somewhere else. The server
  // refuses such an approval too (it carries the version the hold began with, see
  // takeBackRefusedHold); taking it back here says so sooner, and sends nothing.
  // Such a request has no card to return to; it keeps its place as a "decided elsewhere" row.
  // A layout effect, so that it runs in the same step that draws the reloaded list, before any
  // timer can send the hold; and declared before the reset below, which sends what is still held.
  useLayoutEffect(() => {
    if (!data) return;
    const takenBack: Array<{ held: HeldApproval; sentBack: boolean; status: string | null }> = [];
    for (const held of Object.values(heldApprovals)) {
      if (held.phase !== "holding") continue;
      const record = data.find((a) => a.id === held.id);
      const sentBackMeanwhile = Boolean(record && isSentBack(record));
      // The status another session's decision gave it, in the words its row shows; null while it is undecided.
      const decidedStatus =
        record && !needsBoard(record) && !sentBackMeanwhile ? statusWords(record.status).toLowerCase() : null;
      if (!record || !(sentBackMeanwhile || decidedStatus || approvalRevisedSinceShown(revisionMemory, record))) {
        continue;
      }
      // Focus resting on the held row or on its Undo goes to the card that takes the row's place.
      const heldRow = rowElement(held.id);
      const hadFocus = Boolean(heldRow?.contains(document.activeElement));
      const inView = isRowInView(heldRow);
      const cancelled = cancelHeldApproval(held.id);
      // Null when it was sent in this very moment: then there is nothing left to take back.
      if (!cancelled) continue;
      // Said on the request itself, where a failed decision is said: the line stays until the reader
      // approves again or edits the note, and it keeps the row on the page under any filter.
      if (record.status === "approved" && ownApproveFailed.current.has(cancelled.id)) {
        // The reader's first approval was stored though it was answered with an error: the row and
        // the count show it as their own decision, and nothing is said about another session.
        settleDecision(cancelled.id);
        setDecidedHere((current) => ({ ...current, [cancelled.id]: record }));
        announce(`${DECISION_LANDED_LEAD.approve}: ${cancelled.subject}`);
        continue;
      }
      if (decidedStatus) {
        // As after an Undo that came too late: the row shows the status and the note the server
        // holds, and the note typed with the approval is kept as a draft.
        settleDecision(cancelled.id);
        if (cancelled.note) storeDraft(cancelled.id, cancelled.note, "note");
        setLeftHere((current) => ({ ...current, [cancelled.id]: true }));
      } else {
        settleDecision(cancelled.id, sentBackMeanwhile ? HOLD_SENT_BACK_TEXT : HOLD_REVISED_TEXT);
        restoreCard(cancelled);
      }
      takenBack.push({ held: cancelled, sentBack: sentBackMeanwhile, status: decidedStatus });
      // A row out of view cannot say it, and the live region is not seen: then it is said where the
      // reader is too. Not otherwise: the toast would lie over the open request's Approve button.
      // It is also said there when the reader sent this request back earlier on this visit: it is
      // then drawn as a "decided elsewhere" row, which has no place for the line.
      if (!inView || (sentBackMeanwhile && Boolean(decidedHere[cancelled.id]))) {
        toasts?.pushToast({
          title: `Not approved: ${cancelled.subject}`,
          body: decidedStatus
            ? `Its status is now ${decidedStatus}: decided elsewhere. Nothing was sent.`
            : sentBackMeanwhile
            ? "It was sent back for changes before your approval was sent. Nothing was sent."
            : "The requester revised it before your approval was sent. Nothing was sent.",
          tone: "warn",
          ttlMs: 15_000,
          dedupeKey: `approval-hold-revised:${cancelled.id}`,
        });
      }
      if (hadFocus) {
        lastFocusedId.current = cancelled.id;
        requestMove({ targetId: cancelled.id, focus: true });
      }
    }
    if (takenBack.length === 0) return;
    announce(
      takenBack
        .map(({ held, sentBack: wasSentBack, status }) =>
          status
            ? `Not approved: ${held.subject}. Nothing was sent. Its status is now ${status}: decided elsewhere.`
            : wasSentBack
            ? `Not approved: ${held.subject}. It was sent back for changes before your approval was sent. Nothing was sent.`
            : `Not approved: ${held.subject}. The requester revised it before it was sent. Nothing was sent.`,
        )
        .join(" "),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, heldApprovals]);

  // Pins the first card as the open one, once the list on screen is the loaded one. From then on it
  // is an open card like any other: a reload that puts another request first does not swap it.
  // Declared before the reset below, so that after a change of tab the card pinned is the first of
  // the new tab's list, not of the one just left.
  // While the list is still loading, the card shown open is remembered instead. The reader pins it
  // by putting focus in the list (see rememberFocusedRow). If they have not, and the loaded list
  // has another first card, that card is one the page opened by itself: Approve waits a moment.
  useEffect(() => {
    if (openId !== undefined || statusFilter !== "pending" || !firstCardId) {
      shownUnpinned.current = null;
      return;
    }
    if (isFetching) {
      if (!shownUnpinned.current) shownUnpinned.current = firstCardId;
      return;
    }
    if (shownUnpinned.current && shownUnpinned.current !== firstCardId) autoAdvance.current = Date.now();
    shownUnpinned.current = null;
    setOpenId((current) => (current === undefined ? firstCardId : current));
  });

  // A change of tab or company starts the page afresh.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    // The kind filter and the sort are in the address, and a tab link carries neither. The search
    // term is emptied here.
    setSearchText("");
    setDecidedHere({});
    setLeftHere({});
    setShowSentBack(false);
    setOpenId(undefined);
    lastFocusedId.current = null;
    pendingMove.current = null;
    autoAdvance.current = null;
    ownApproveFailed.current.clear();
    refocusLeftRow.current = null;
    clearDecisionErrors();
    setAnnouncement(null);
    // The list the held approvals were shown in is gone, and their Undo with it: they are sent now.
    flushHeldApprovals();
  }, [statusFilter, selectedCompanyId, clearDecisionErrors, flushHeldApprovals]);

  // What was typed (`drafts`) and what was read (`revisionMemory`) are not part of that fresh
  // start. Both are kept per request for as long as the page is open: the two tabs list the same
  // requests, and another company's requests have other ids.

  // A link to one request (#approval-<id>): open it, put it on the page, and take the reader to it.
  const hashTarget = approvalIdFromHash(location.hash ?? "");
  useEffect(() => {
    if (!hashTarget) {
      // The link has been left: following the same one again works again.
      handledHash.current = null;
      return;
    }
    if (!data || handledHash.current === hashTarget) return;
    const index = filtered.findIndex((a) => a.id === hashTarget);
    const isSentBackTarget = sentBack.some((a) => a.id === hashTarget);
    // A list still loading may not hold the request yet.
    if (index < 0 && !isSentBackTarget && isFetching) return;
    handledHash.current = hashTarget;
    autoAdvance.current = null;
    if (index < 0) {
      // No other request is left open as if it were the one the link meant.
      setOpenId(null);
      if (isSentBackTarget) {
        setShowSentBack(true);
        requestMove({ targetId: null, sentBackId: hashTarget, focus: true, block: "start" });
        return;
      }
      const known = data.find((a) => a.id === hashTarget);
      announce(
        known
          ? `The linked request is not in this list. Its status is ${statusWords(known.status).toLowerCase()}.`
          : "The linked request was not found.",
      );
      return;
    }
    const cardsUpToTarget = filtered.slice(0, index + 1).filter((a) => !isCompactRow(a)).length;
    setVisibleCount((count) => Math.max(count, Math.ceil(cardsUpToTarget / PAGE_SIZE) * PAGE_SIZE));
    setOpenId(hashTarget);
    lastFocusedId.current = hashTarget;
    requestMove({ targetId: hashTarget, focus: true, block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashTarget, data, isFetching]);

  // A kind in the address that this tab does not list is dropped from the address once the list
  // has loaded, in place and with the #target and the state kept. Left there it would be applied by
  // a later reload that brings a request of that kind, and the queue would narrow by itself.
  const unknownKind =
    Boolean(data) && !isFetching && !onBareRoute && kindFilter !== "all" && !kinds.includes(kindFilter);
  useEffect(() => {
    if (!unknownKind) return;
    const query = new URLSearchParams(locationSearch);
    query.delete("kind");
    const search = query.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: locationHash },
      { replace: true, state: locationState },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unknownKind]);

  // The open card's request is no longer shown as a card (it left the list, or it is a compact row
  // now): no card is open. A request that left and comes back, for example sent back elsewhere and
  // resubmitted, returns as a closed row that has to be opened and read, not open under the pointer.
  const openIsShown = typeof openId !== "string" || visible.some((a) => a.id === openId && !isCompactRow(a));
  useEffect(() => {
    if (!data || openIsShown) return;
    setOpenId((current) => (current === openId ? null : current));
  }, [data, openIsShown, openId]);

  const chooseView = (next: ViewMode) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // The choice still holds for this visit.
    }
  };

  /**
   * The list starts like a fresh one after the reader refiltered, reordered or searched it: its
   * first card open. While a search term is set no card is opened: the results are closed rows.
   */
  const restartList = (term = searchTerm) => openByReader(term ? null : undefined);

  /**
   * The reader chose another kind or another order. It is written into the address in place: the
   * page stays the same page and no history entry is added, so nothing held is sent and nothing
   * typed is lost. A default value is left out of the address.
   *
   * The router applies an address change as a transition. The fresh start of the list is made one
   * too, so it is never drawn before the change: the card pinned open would otherwise be the first
   * card of the list the reader just left.
   */
  const changeView = (name: "kind" | "sort", value: string | null) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true },
    );
    startTransition(() => {
      if (name === "kind") setVisibleCount(PAGE_SIZE);
      restartList();
    });
  };

  const changeSearch = (text: string) => {
    setSearchText(text);
    const term = text.trim().toLowerCase();
    // Only spaces around the term changed: the list is the same.
    if (term === searchTerm) return;
    setVisibleCount(PAGE_SIZE);
    restartList(term);
    // An emptied field draws the first card open again, by the page and maybe under a resting
    // pointer: Approve waits as after any card the page opens. Set after the restart, which clears it.
    if (!term) autoAdvance.current = Date.now();
  };

  // Carried by every "View details" link, so the request's own page can link back to this view.
  const detailsState: ApprovalQueueLinkState = { queue: `${location.pathname}${location.search}` };

  const showMore = () => {
    // The first card the page does not show yet is the first one the press brings in.
    const shownIds = new Set(visible.map((a) => a.id));
    const firstNew = filtered.find((a) => !isCompactRow(a) && !shownIds.has(a.id));
    setVisibleCount((count) => count + PAGE_SIZE);
    if (!firstNew) return;
    lastFocusedId.current = firstNew.id;
    if (statusFilter === "pending") openByReader(firstNew.id);
    requestMove({ targetId: firstNew.id, focus: true });
  };

  const rememberFocusedRow = (event: FocusEvent<HTMLDivElement>) => {
    const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-approval-card]") : null;
    if (row?.dataset.approvalCard) lastFocusedId.current = row.dataset.approvalCard;
    // The reader is in the list: the card shown open is theirs from now on, also while a reload that
    // may put another request first is still on its way.
    if (row && statusFilter === "pending" && firstCardId) {
      setOpenId((current) => (current === undefined ? firstCardId : current));
    }
  };

  // The linked-task chips of every row on the page come from one read, not one per card. The key is
  // the set of rows shown, so a row the page brings in is read with the others; the rows already
  // shown keep their chips while that read is on its way. Returning to the browser tab reads nothing.
  const linkedIssueIdsKey = visible.map((approval) => approval.id).sort().join(",");
  const { data: linkedIssuesByApproval } = useQuery({
    queryKey: queryKeys.approvals.linkedIssues(selectedCompanyId ?? "", linkedIssueIdsKey),
    queryFn: () => approvalsApi.listLinkedIssues(selectedCompanyId!, linkedIssueIdsKey.split(",")),
    enabled: !!selectedCompanyId && linkedIssueIdsKey.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Tabs value={statusFilter} onValueChange={(v) => navigate(`/approvals/${v}`)}>
          <PageTabBar items={[
            { value: "pending", label: <>To decide{pendingCount > 0 && (
              // The pill the sidebar uses for the same number: it reads in both themes.
              <Badge variant="ghost" className="ml-1.5 bg-primary px-1.5 text-(length:--text-micro) text-primary-foreground">
                {pendingCount}
              </Badge>
            )}</> },
            { value: "all", label: "All decisions" },
          ]} />
        </Tabs>
      </div>

      {(inTab.length > 0 || searchText !== "") && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchText}
                onChange={(event) => changeSearch(event.target.value)}
                onKeyDown={(event) => {
                  // As in the app's other search fields: Enter, or Escape in an empty field, leaves it.
                  const isComposing = event.nativeEvent.isComposing;
                  if (
                    shouldBlurPageSearchOnEnter({ key: event.key, isComposing }) ||
                    shouldBlurPageSearchOnEscape({ key: event.key, isComposing, currentValue: event.currentTarget.value })
                  ) {
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Search requests..."
                className="h-7 pl-7 text-xs"
                aria-label="Search requests by subject, requester, summary or recommendation"
                // The app's "/" key puts focus here.
                data-page-search-target="true"
              />
            </div>
            {/* On the page before it has any text, so the number is spoken when a term is typed. */}
            <span
              role="status"
              className={cn("text-xs text-muted-foreground", !searchTerm && "sr-only")}
              data-approval-search-count=""
            >
              {searchTerm ? (foundCount === 0 ? "None found" : `${foundCount} found`) : ""}
            </span>
            {kinds.length > 1 &&
              ["all", ...kinds].map((kind) => (
                <Button
                  key={kind}
                  variant={activeKind === kind ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 rounded-full px-3 text-xs"
                  aria-pressed={activeKind === kind}
                  data-approval-kind={kind}
                  onClick={() => changeView("kind", kind === "all" ? null : kind)}
                >
                  {kind === "all" ? "All" : kindLabel(kind)}
                  <span className="ml-1.5 tabular-nums" data-approval-kind-count="">
                    {kindCount(kind)}
                    <span className="sr-only">{statusFilter === "pending" ? " to decide" : " listed"}</span>
                  </span>
                </Button>
              ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {keyboardShortcutsEnabled && statusFilter === "pending" && (
              <span className="hidden text-xs text-muted-foreground md:inline">
                {APPROVAL_SHORTCUT_HINT}
              </span>
            )}
            {decidedCount > 0 && (
              <span className="text-xs text-muted-foreground" data-approval-progress="">
                {decidedCount} decided this visit · {leftCount} left to decide
              </span>
            )}
            {statusFilter === "pending" && (
              <div role="group" aria-label="Queue view" className="flex items-center gap-1">
                {(["compact", "full"] as const).map((mode) => (
                  <Button
                    key={mode}
                    variant={view === mode ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    aria-pressed={view === mode}
                    onClick={() => chooseView(mode)}
                  >
                    {mode === "compact" ? "Compact" : "Full cards"}
                  </Button>
                ))}
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => {
                const next: SortOrder = sortOrder === "oldest" ? "newest" : "oldest";
                changeView("sort", next === defaultSort ? null : next);
              }}
            >
              Sort: {sortOrder === "oldest" ? "Oldest first" : "Newest first"}
            </Button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      <div aria-live="polite" className="sr-only" data-approval-announcements="">
        {announcement && <p key={announcement.seq}>{announcement.text}</p>}
      </div>

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {searchTerm
              ? "No request matches the search."
              : statusFilter === "pending"
                ? "Nothing needs a decision."
                : "No decisions yet."}
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3" ref={listRef} onFocus={rememberFocusedRow}>
            {visible.map((approval) => {
              const held = heldApprovals[approval.id] ?? null;
              const compact = compactRowFor(approval);
              if (held || compact) {
                return (
                  <DecidedApprovalRow
                    key={approval.id}
                    approval={compact?.record ?? approval}
                    held={held}
                    elsewhere={compact?.elsewhere ?? false}
                    detailsState={detailsState}
                    onUndo={() => undoHeldApproval(approval.id)}
                    onPause={(reason) => pauseHeldApproval(approval.id, reason)}
                    onResume={(reason) => resumeHeldApproval(approval.id, reason)}
                  />
                );
              }
              const pendingAction = decisions.inFlight[approval.id] ?? null;
              // Read when the card is drawn: its controls start from this copy each time they are drawn again.
              const draft = drafts.current.get(approval.id);
              // Sent back on this visit and resubmitted since: the card is back. The server keeps the
              // change request on it and the card shows that. The copy kept here covers an older
              // server that deleted the note; it lasts until a new decision or a tab change.
              const sentBackHere = decidedHere[approval.id];
              return (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  changesAskedFor={sentBackHere?.status === "revision_requested" ? sentBackHere.decisionNote : null}
                  requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                  onApprove={(note) => decide(approval, "approve", note)}
                  onReject={(note) => decide(approval, "reject", note)}
                  onRequestRevision={(note) => decide(approval, "revision", note)}
                  detailLink={`/approvals/${approval.id}`}
                  detailLinkState={detailsState}
                  isPending={pendingAction !== null}
                  pendingAction={pendingAction}
                  error={decisions.errors[approval.id] ?? null}
                  // The live region above announces every outcome once; the card's error line stays silent.
                  announceError={false}
                  onDismissError={() => decisions.clearError(approval.id)}
                  defaultNote={draft?.text}
                  defaultNoteMode={draft?.mode}
                  onNoteChange={(text, mode) => storeDraft(approval.id, text, mode)}
                  // A decision on its way carries the text with it; the row says that instead.
                  unsentNote={pendingAction ? null : (draftModes[approval.id] ?? null)}
                  revisionMemory={revisionMemory}
                  linkedIssues={linkedIssuesByApproval?.[approval.id]}
                  enableShortcuts={keyboardShortcutsEnabled}
                  focusable
                  collapsible={collapsibleList}
                  open={approval.id === effectiveOpenId}
                  onOpenChange={(next) => {
                    openByReader(next ? approval.id : null);
                    // The card above closes and this one opens where its header was: its Approve can
                    // now lie under a pointer halfway through a double click, or a second tap.
                    if (next) autoAdvance.current = Date.now();
                  }}
                  resolveAgentName={(agentId) =>
                    agents ? (agents.find((a) => a.id === agentId)?.name ?? null) : undefined
                  }
                />
              );
            })}
          </div>
          {remaining > 0 && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" size="sm" onClick={showMore}>
                Show {Math.min(PAGE_SIZE, remaining)} more
              </Button>
            </div>
          )}
        </>
      )}

      {sentBack.length > 0 && (
        <section className="space-y-3 border-t border-border/60 pt-4" data-approval-sent-back-section="">
          <h2>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-sm font-medium text-foreground"
              aria-expanded={showSentBack}
              onClick={() => setShowSentBack((current) => !current)}
            >
              {showSentBack ? (
                <ChevronDown aria-hidden className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight aria-hidden className="h-4 w-4 text-muted-foreground" />
              )}
              Waiting on the requester ({sentBack.length})
            </Button>
          </h2>
          {showSentBack && (
            <div className="space-y-3">
              <p className="px-2 text-xs leading-5 text-muted-foreground">
                Sent back for changes. A request returns to the queue when its requester resubmits it. Open one to
                approve or reject it as it stands.
              </p>
              <ul className="grid grid-cols-1 gap-3" ref={sentBackListRef}>
                {sentBack.map((approval) => (
                  <SentBackApprovalRow key={approval.id} approval={approval} detailsState={detailsState} />
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
