import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQueries, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useGeneralSettings } from "../context/GeneralSettingsContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "../lib/keyboardShortcuts";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import { ApprovalCard } from "../components/ApprovalCard";
import {
  approvalDecisionErrorText,
  useApprovalDecisionFeedback,
  type ApprovalDecisionKind,
} from "../components/ApprovalDecisionActions";
import {
  APPROVE_HOLD_MS,
  ApprovalHoldCountdown,
  useApprovalHolds,
  type HeldApproval,
} from "../components/ApprovalHold";
import {
  APPROVAL_TITLE_LENGTH,
  approvalExcerpt,
  approvalSubject,
  isEmailReplyPayload,
  typeLabel,
} from "../components/ApprovalPayload";
import { ApprovalChangesAskedFor, ApprovalSentBackTime, approvalSentBackAt } from "../components/ApprovalRevision";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

type StatusFilter = "pending" | "all";
type SortOrder = "oldest" | "newest";
type Decision = { id: string; note?: string; subject: string };
type ViewMode = "compact" | "full";
/**
 * A move of the reader's place in the queue, carried out once the list has drawn:
 * which row to bring into view, and whether keyboard focus goes with it.
 */
type QueueMove = {
  /** The row to bring into view; null when a decision left no request to move on to. */
  targetId: string | null;
  /** The request a decision just landed on. Focus falls back to its compact row. */
  decidedId?: string;
  focus: boolean;
  /** The decided card began above the viewport: its row goes to the top first, so the next request is not passed. */
  scrollDecidedToTop?: boolean;
  block?: ScrollLogicalPosition;
};
const PAGE_SIZE = 20;
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
 */
function DecidedApprovalRow({
  approval,
  held = null,
  onUndo,
}: {
  approval: Approval;
  held?: HeldApproval | null;
  onUndo?: () => void;
}) {
  const subject = held?.subject ?? approvalDisplaySubject(approval);
  const note = held ? held.note : approval.decisionNote;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-approval-card={approval.id}
      data-approval-decided-row={held ? undefined : ""}
      data-approval-held-row={held ? held.phase : undefined}
      tabIndex={-1}
    >
      {held ? (
        <span className="text-xs font-medium text-foreground" data-approval-hold-status="">
          {held.phase === "holding" ? <ApprovalHoldCountdown sendAt={held.sendAt} /> : "Approving..."}
        </span>
      ) : (
        <StatusBadge status={approval.status} />
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{subject}</span>
      {held ? (
        held.phase === "holding" && (
          <Button
            variant="outline"
            size="sm"
            onClick={onUndo}
            aria-label={`Undo approval: ${subject}`}
            data-approval-undo=""
          >
            Undo
          </Button>
        )
      ) : (
        <Link
          to={`/approvals/${approval.id}`}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-auto px-2 text-xs text-muted-foreground")}
        >
          View details
        </Link>
      )}
      {note && (
        <p className="basis-full break-words text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">Your note.</span> {note}
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
function SentBackApprovalRow({ approval }: { approval: Approval }) {
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 px-4 py-3"
      data-approval-sent-back-row={approval.id}
    >
      <StatusBadge status={approval.status} />
      <span className="min-w-0 flex-1 break-words text-sm font-medium text-foreground">
        {approvalDisplaySubject(approval)}
      </span>
      <ApprovalSentBackTime approval={approval} className="text-xs text-muted-foreground" />
      <Link
        to={`/approvals/${approval.id}`}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-auto px-2 text-xs text-muted-foreground")}
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
  const { keyboardShortcutsEnabled } = useGeneralSettings();
  const toasts = useOptionalToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";
  // In-flight state and the last error are kept per request, so each card answers for its own decision.
  const decisions = useApprovalDecisionFeedback();
  const { settle: settleDecision, clearErrors: clearDecisionErrors } = decisions;
  // Read out by screen readers when a decision lands or fails; a new entry is announced even when its text repeats.
  const [announcement, setAnnouncement] = useState<{ seq: number; text: string } | null>(null);
  // How many cards the page shows. The compact rows left by decisions are not counted against it.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [view, setView] = useState<ViewMode>(readStoredView);
  // The open card of a collapsible list. Undefined until the reader or a decision picks one:
  // "To decide" then opens its first card, and "All decisions" opens none.
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  const [sortOverride, setSortOverride] = useState<SortOrder | null>(null);
  const [kindFilter, setKindFilter] = useState<string>("all");
  // Approvals decided on this visit stay listed as a compact row, so deciding
  // one request does not move the rest of the queue or leave the page.
  const [decidedHere, setDecidedHere] = useState<Record<string, Approval>>({});
  // Requests sent back for changes sit below the queue, folded away until asked for.
  const [showSentBack, setShowSentBack] = useState(false);
  // The note typed with an approval that was undone or failed, handed back to the card when it returns.
  const [restoredNotes, setRestoredNotes] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
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
  const handledHash = useRef<string | null>(null);
  // What the page shows now, for an approval that settles after the reader has moved on or left.
  const shownRef = useRef<{ mounted: boolean; companyId: string | null }>({ mounted: false, companyId: null });
  const undoLatestRef = useRef<() => boolean>(() => false);
  // The oldest request has waited longest, so it leads the queue; history reads newest first.
  const sortOrder: SortOrder = sortOverride ?? (statusFilter === "pending" ? "oldest" : "newest");

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
  const requestMove = (move: QueueMove) => {
    pendingMove.current = move;
    setMoveSeq((seq) => seq + 1);
  };

  // Runs after the list has drawn the change that asked for the move: the opened card has its
  // full height and the decided card is already its compact row.
  useLayoutEffect(() => {
    const move = pendingMove.current;
    if (!move) return;
    pendingMove.current = null;
    const decidedRow = move.decidedId ? rowElement(move.decidedId) : null;
    const target = move.targetId ? rowElement(move.targetId) : null;
    if (move.scrollDecidedToTop) decidedRow?.scrollIntoView?.({ block: "start" });
    if (move.focus) (target ?? decidedRow)?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: move.block ?? "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveSeq]);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const isUndo = event.key === "Z" && event.shiftKey;
      if (event.key !== "j" && event.key !== "k" && !isUndo) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isKeyboardShortcutTextInputTarget(event.target) || hasBlockingShortcutDialog(document)) return;
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
        : Math.max(0, Math.min(cards.length - 1, current + (event.key === "j" ? 1 : -1)));
      event.preventDefault();
      const row = cards[next];
      const id = row.dataset.approvalCard ?? null;
      if (!id) return;
      lastFocusedId.current = id;
      // Moving to a request opens it; a compact decided or held row has nothing to open.
      const compactRow = row.hasAttribute("data-approval-decided-row") || row.hasAttribute("data-approval-held-row");
      setOpenId(compactRow ? null : id);
      pendingMove.current = { targetId: id, focus: true };
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

  // These run once for every decision sent, also when several are on their way at once.
  const recordDecided = (action: ApprovalDecisionKind, approval: Approval, subject: string, companyId: string) => {
    settleDecision(approval.id);
    setDecidedHere((current) => ({ ...current, [approval.id]: approval }));
    announce(`${DECISION_LANDED_LEAD[action]}: ${subject}`);
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
    recordDecided(action, approval, subject, selectedCompanyId!);
    advanceFrom(id);
  };
  const handleFailed = (action: ApprovalDecisionKind) => (err: unknown, { id, subject }: Decision) => {
    recordFailed(action, err, id, subject, selectedCompanyId!);
  };

  const forgetRestoredNote = (id: string) =>
    setRestoredNotes((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  /** Hands a note back to the card that returns after an approval was undone or failed. */
  const restoreCard = (held: HeldApproval) => {
    if (held.note) setRestoredNotes((current) => ({ ...current, [held.id]: held.note! }));
    // The returning card joins the page; nothing that was on the page leaves it to make room.
    setVisibleCount((count) => count + 1);
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
    new Promise<Approval>((resolve) => resolve(approvalsApi.approve(held.id, held.note, { keepalive: true }))).then(
      (approval) => {
        releaseHeldApproval(held.id);
        // The reader was moved on when the hold began, so nothing moves now.
        recordDecided("approve", approval, held.subject, held.companyId);
      },
      (err: unknown) => {
        releaseHeldApproval(held.id);
        recordFailed("approve", err, held.id, held.subject, held.companyId);
        const shown = shownRef.current;
        const listed =
          shown.mounted && shown.companyId === held.companyId && queueRef.current.rows.some((row) => row.id === held.id);
        // The note is handed back with the card, also when the card is only seen again later.
        restoreCard(held);
        if (!listed) {
          // The page no longer lists the request (the reader left, or changed company or filter): say so where they are.
          toasts?.pushToast({
            title: approvalDecisionErrorText("approve", err, held.subject),
            tone: "error",
            ttlMs: 15_000,
            dedupeKey: `approval-hold-failed:${held.id}`,
            action: { label: "View request", href: `/approvals/${held.id}` },
          });
          return;
        }
        const focused = document.activeElement;
        // Someone typing is not interrupted: the closed row shows the error, and the card opens when they turn to it.
        if (isKeyboardShortcutTextInputTarget(focused)) return;
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
    latestRunningId: latestHeldApprovalId,
  } = useApprovalHolds({ send: sendHeldApproval });

  /** Takes back a held approval: nothing is sent, and its card returns open, in focus, with its note. */
  const undoHeldApproval = (id: string) => {
    const held = cancelHeldApproval(id);
    // Too late: the request has been sent.
    if (!held) return false;
    settleDecision(id);
    restoreCard(held);
    announce(`Not approved: ${held.subject}. Nothing was sent.`);
    setOpenId(id);
    lastFocusedId.current = id;
    requestMove({ targetId: id, focus: true });
    return true;
  };
  undoLatestRef.current = () => {
    const id = latestHeldApprovalId();
    return id ? undoHeldApproval(id) : false;
  };

  // A change of tab or company starts the page afresh.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setKindFilter("all");
    setDecidedHere({});
    setShowSentBack(false);
    setOpenId(undefined);
    setRestoredNotes({});
    lastFocusedId.current = null;
    pendingMove.current = null;
    clearDecisionErrors();
    setAnnouncement(null);
    // The list the held approvals were shown in is gone, and their Undo with it: they are sent now.
    flushHeldApprovals();
  }, [statusFilter, selectedCompanyId, clearDecisionErrors, flushHeldApprovals]);

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: Decision) => (note ? approvalsApi.reject(id, note) : approvalsApi.reject(id)),
    onSuccess: handleDecided("reject"),
    onError: handleFailed("reject"),
  });

  const revisionMutation = useMutation({
    mutationFn: ({ id, note }: Decision) => approvalsApi.requestRevision(id, note),
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
    // A request whose decision is held or still on its way is not sent a second one.
    if (!decisions.start(approval.id, action)) return;
    const decision: Decision = { id: approval.id, note, subject: approvalDisplaySubject(approval) };
    if (action === "reject") rejectMutation.mutate(decision);
    else if (action === "revision") revisionMutation.mutate(decision);
    else {
      // An approval cannot be reversed once the server has it, so it is held here first. The card
      // becomes its compact row and the reader moves on at once, as if the decision had landed.
      if (!holdApproval({ ...decision, companyId: selectedCompanyId! })) {
        settleDecision(approval.id);
        return;
      }
      forgetRestoredNote(approval.id);
      announce(`Approving ${decision.subject} in ${APPROVE_HOLD_MS / 1000} seconds. Undo is available.`);
      advanceFrom(approval.id);
    }
  };

  // A request whose decision came back as an error stays listed with that error, whatever status the reload shows.
  // So does one whose approval is held or on its way, even when a reload already shows it decided.
  const inTab = (data ?? []).filter(
    (a) =>
      statusFilter === "all" ||
      needsBoard(a) ||
      Boolean(decidedHere[a.id]) ||
      Boolean(decisions.errors[a.id]) ||
      Boolean(heldApprovals[a.id]),
  );
  // Everything else that was sent back waits on its requester. The kind filter and the sort do not apply to it.
  const listedIds = new Set(inTab.map((a) => a.id));
  const sentBack = (data ?? [])
    .filter((a) => statusFilter === "pending" && isSentBack(a) && !listedIds.has(a.id))
    .sort((a, b) => timeOf(approvalSentBackAt(a)) - timeOf(approvalSentBackAt(b)));
  const kinds = Array.from(new Set(inTab.map(approvalKind)));
  const activeKind = kinds.includes(kindFilter) ? kindFilter : "all";
  const filtered = inTab
    .filter((a) => activeKind === "all" || approvalKind(a) === activeKind)
    .sort((a, b) => {
      const delta = timeOf(a.createdAt) - timeOf(b.createdAt);
      return sortOrder === "oldest" ? delta : -delta;
    });

  /** The compact row a request decided on this visit is shown as, or null while it is a card. */
  const decidedRowFor = (approval: Approval): Approval | null => {
    const decided = decidedHere[approval.id];
    if (!decided) return null;
    // A request sent back here and resubmitted since needs a decision again: its card returns.
    const reopened = needsBoard(approval) && timeOf(approval.updatedAt) > timeOf(decided.updatedAt);
    return reopened ? null : decided;
  };

  /** Shown as one compact row: decided on this visit, or an approval that is held or on its way. */
  const isCompactRow = (approval: Approval) => Boolean(heldApprovals[approval.id]) || decidedRowFor(approval) !== null;

  const pendingCount = (data ?? []).filter(needsBoard).length;
  // A held approval counts as decided: the reader has dealt with it unless they undo it.
  const decidedCount = (data ?? []).filter(isCompactRow).length;
  // A decision counts as soon as it is made, before the reloaded list confirms it.
  const leftCount = (data ?? []).filter((a) => needsBoard(a) && !isCompactRow(a)).length;
  // Only cards count against the page size. Each decision therefore brings the next request onto
  // the page, and the page holds a full page of undecided requests for as long as more exist.
  const visible: Approval[] = [];
  let cardsShown = 0;
  for (const approval of filtered) {
    if (!isCompactRow(approval)) {
      if (cardsShown >= visibleCount) break;
      cardsShown += 1;
    }
    visible.push(approval);
  }
  const remaining = filtered.filter((a) => !isCompactRow(a)).length - cardsShown;

  // "To decide" in the compact view opens one card at a time; "All decisions" always starts closed.
  const collapsibleList = statusFilter === "all" || view === "compact";
  const firstCardId = visible.find((a) => !isCompactRow(a))?.id ?? null;
  const effectiveOpenId = openId === undefined ? (statusFilter === "pending" ? firstCardId : null) : openId;
  queueRef.current = {
    rows: filtered.map((a) => ({ id: a.id, undecided: needsBoard(a) && !isCompactRow(a) })),
    openId: effectiveOpenId,
    collapsible: collapsibleList,
    // Under "All decisions" the next undecided request can be far down the history; the reader stays where they are.
    advances: statusFilter === "pending",
  };
  shownRef.current.companyId = selectedCompanyId ?? null;

  // A link to one request (#approval-<id>): open it, put it on the page, and take the reader to it.
  const hashTarget = approvalIdFromHash(location.hash ?? "");
  useEffect(() => {
    if (!hashTarget || !data || handledHash.current === hashTarget) return;
    const index = filtered.findIndex((a) => a.id === hashTarget);
    const isSentBackTarget = sentBack.some((a) => a.id === hashTarget);
    // A list still loading may not hold the request yet; once it has loaded, a link to nothing listed is dropped.
    if (index < 0 && !isSentBackTarget && isFetching) return;
    handledHash.current = hashTarget;
    if (isSentBackTarget) setShowSentBack(true);
    if (index < 0) return;
    const cardsUpToTarget = filtered.slice(0, index + 1).filter((a) => !isCompactRow(a)).length;
    setVisibleCount((count) => Math.max(count, Math.ceil(cardsUpToTarget / PAGE_SIZE) * PAGE_SIZE));
    setOpenId(hashTarget);
    lastFocusedId.current = hashTarget;
    requestMove({ targetId: hashTarget, focus: true, block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashTarget, data, isFetching]);

  const chooseView = (next: ViewMode) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // The choice still holds for this visit.
    }
  };

  const showMore = () => {
    // The page ends just before a card, so this is the first one the press brings in.
    const firstNew = filtered[visible.length];
    setVisibleCount((count) => count + PAGE_SIZE);
    if (!firstNew) return;
    lastFocusedId.current = firstNew.id;
    if (statusFilter === "pending") setOpenId(firstNew.id);
    requestMove({ targetId: firstNew.id, focus: true });
  };

  const rememberFocusedRow = (event: FocusEvent<HTMLDivElement>) => {
    const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-approval-card]") : null;
    if (row?.dataset.approvalCard) lastFocusedId.current = row.dataset.approvalCard;
  };

  const linkedIssueQueries = useQueries({
    queries: visible.map((approval) => ({
      queryKey: queryKeys.approvals.issues(approval.id),
      queryFn: () => approvalsApi.listIssues(approval.id),
      staleTime: 60_000,
    })),
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
              <Badge variant="ghost" className={cn(
                "ml-1.5 px-1.5 text-(length:--text-nano)",
                "bg-yellow-500/20 text-yellow-500"
              )}>
                {pendingCount}
              </Badge>
            )}</> },
            { value: "all", label: "All decisions" },
          ]} />
        </Tabs>
      </div>

      {inTab.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {kinds.length > 1 &&
              ["all", ...kinds].map((kind) => (
                <Button
                  key={kind}
                  variant={activeKind === kind ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 rounded-full px-3 text-xs"
                  aria-pressed={activeKind === kind}
                  onClick={() => {
                    setKindFilter(kind);
                    setVisibleCount(PAGE_SIZE);
                    // The filtered list starts like a fresh one: its first card open.
                    setOpenId(undefined);
                  }}
                >
                  {kind === "all" ? "All" : kindLabel(kind)}
                </Button>
              ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {keyboardShortcutsEnabled && statusFilter === "pending" && (
              <span className="hidden text-xs text-muted-foreground md:inline">
                J / K to move · Shift+A approve · Shift+C request changes · Shift+X reject · Shift+Z undo approve
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
              onClick={() => setSortOverride(sortOrder === "oldest" ? "newest" : "oldest")}
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
            {statusFilter === "pending" ? "Nothing needs a decision." : "No decisions yet."}
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <>
          <div className="grid gap-3" ref={listRef} onFocus={rememberFocusedRow}>
            {visible.map((approval, index) => {
              const held = heldApprovals[approval.id] ?? null;
              const decided = decidedRowFor(approval);
              if (held || decided) {
                return (
                  <DecidedApprovalRow
                    key={approval.id}
                    approval={decided ?? approval}
                    held={held}
                    onUndo={() => undoHeldApproval(approval.id)}
                  />
                );
              }
              const pendingAction = decisions.inFlight[approval.id] ?? null;
              return (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                  onApprove={(note) => decide(approval, "approve", note)}
                  onReject={(note) => decide(approval, "reject", note)}
                  onRequestRevision={(note) => decide(approval, "revision", note)}
                  detailLink={`/approvals/${approval.id}`}
                  isPending={pendingAction !== null}
                  pendingAction={pendingAction}
                  error={decisions.errors[approval.id] ?? null}
                  onDismissError={() => decisions.clearError(approval.id)}
                  defaultNote={restoredNotes[approval.id]}
                  onNoteChange={() => forgetRestoredNote(approval.id)}
                  linkedIssues={linkedIssueQueries[index]?.data}
                  enableShortcuts={keyboardShortcutsEnabled}
                  focusable
                  collapsible={collapsibleList}
                  open={approval.id === effectiveOpenId}
                  onOpenChange={(next) => setOpenId(next ? approval.id : null)}
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
              <ul className="grid gap-3">
                {sentBack.map((approval) => (
                  <SentBackApprovalRow key={approval.id} approval={approval} />
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
