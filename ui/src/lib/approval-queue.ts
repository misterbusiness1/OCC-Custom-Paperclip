import { useSyncExternalStore } from "react";
import { APPROVAL_QUEUE_DECIDED_LIMIT_MAX, APPROVAL_QUEUE_DECIDED_PAGE_SIZE, type Approval } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "./queryKeys";

/**
 * The company's approvals as the board reads them: every open request (pending or sent back) and
 * a window of the most recently decided ones. The window starts at one page and grows by a page
 * each time the reader asks for older decisions, for as long as the tab is open.
 *
 * Every reader of `queryKeys.approvals.list(companyId)` (the Approvals page, the inbox, the inbox
 * badge, the pending count) must use `approvalListQuery`, so the cached list is always this one.
 */
type QueueWindow = { decidedLimit: number; decidedHasMore: boolean };

const windows = new Map<string, QueueWindow>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

// The same object until it changes: `useSyncExternalStore` compares snapshots by identity.
function windowFor(companyId: string): QueueWindow {
  let current = windows.get(companyId);
  if (!current) {
    current = { decidedLimit: APPROVAL_QUEUE_DECIDED_PAGE_SIZE, decidedHasMore: false };
    windows.set(companyId, current);
  }
  return current;
}

function setWindow(companyId: string, next: QueueWindow) {
  const current = windowFor(companyId);
  if (current.decidedLimit === next.decidedLimit && current.decidedHasMore === next.decidedHasMore) return;
  windows.set(companyId, next);
  emit();
}

/** Reads the list with the company's current window, and records whether older decisions exist. */
export async function fetchApprovalList(companyId: string): Promise<Approval[]> {
  const { decidedLimit } = windowFor(companyId);
  const queue = await approvalsApi.listQueue(companyId, decidedLimit);
  // A read never sets the window's size, only whether older decisions exist, and only while the
  // window is still the one it read: a read that started before "Load older" must not shrink it back.
  if (windowFor(companyId).decidedLimit === decidedLimit) {
    setWindow(companyId, { decidedLimit, decidedHasMore: queue.decidedHasMore });
  }
  return queue.approvals;
}

/** The query every reader of the company's approvals list uses. */
export function approvalListQuery(companyId: string) {
  return {
    queryKey: queryKeys.approvals.list(companyId),
    queryFn: () => fetchApprovalList(companyId),
  };
}

/**
 * Widens the window by one page. The caller then refetches the list. Returns false when there is
 * nothing older to read or the window is already as large as the server accepts.
 */
export function widenDecidedWindow(companyId: string): boolean {
  const current = windowFor(companyId);
  if (!current.decidedHasMore || current.decidedLimit >= APPROVAL_QUEUE_DECIDED_LIMIT_MAX) return false;
  setWindow(companyId, {
    decidedLimit: Math.min(current.decidedLimit + APPROVAL_QUEUE_DECIDED_PAGE_SIZE, APPROVAL_QUEUE_DECIDED_LIMIT_MAX),
    decidedHasMore: current.decidedHasMore,
  });
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The company's current window: how many decided approvals the list holds, and whether older ones exist. */
export function useApprovalQueueWindow(companyId: string | null | undefined): QueueWindow {
  return useSyncExternalStore(
    subscribe,
    () => (companyId ? windowFor(companyId) : EMPTY_WINDOW),
    () => EMPTY_WINDOW,
  );
}

const EMPTY_WINDOW: QueueWindow = { decidedLimit: APPROVAL_QUEUE_DECIDED_PAGE_SIZE, decidedHasMore: false };

/** For tests: forgets every company's window. */
export function resetApprovalQueueWindows() {
  windows.clear();
  emit();
}
