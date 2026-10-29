import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { invalidateInboxIssueQueries } from "../lib/inboxArchiveCache";
import { queryKeys } from "../lib/queryKeys";

const preferenceEvent = "paperclip:completed-inbox-cleanup";
export const COMPLETED_INBOX_CLEANUP_BATCH_SIZE = 10;
/** Completed tasks fetched per refresh. The cleanup has its own query, newest first, so a
 * large inbox (where the Mine list is filled by higher-priority open work) cannot hide them. */
export const COMPLETED_INBOX_CLEANUP_SCAN_LIMIT = 200;
export const COMPLETED_INBOX_CLEANUP_REFRESH_MS = 60_000;
export const completedInboxCleanupKey = (companyId: string, userId: string) =>
  `paperclip.completedInboxCleanup:${companyId}:${userId}`;
// Under the Mine prefix so invalidateInboxIssueQueries refreshes it with the other inbox lists.
export const completedInboxCleanupQueryKey = (companyId: string) =>
  [...queryKeys.issues.listMineByMe(companyId), "completed-cleanup", COMPLETED_INBOX_CLEANUP_SCAN_LIMIT] as const;

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(preferenceEvent, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(preferenceEvent, callback);
  };
}

function completionKey(issue: Issue): string | null {
  const timestamp = issue.completedAt ? new Date(issue.completedAt).getTime() : NaN;
  return issue.status === "done" && Number.isFinite(timestamp) ? `${issue.id}:${timestamp}` : null;
}

/** Runs only while Inbox is open, on its own query of this user's visible completed tasks. */
export function useCompletedInboxCleanup({ companyId, userId }: {
  companyId: string | null;
  userId: string | null;
}) {
  const queryClient = useQueryClient();
  const scope = companyId && userId ? completedInboxCleanupKey(companyId, userId) : null;
  const getSnapshot = useCallback(() => {
    if (!scope) return false;
    try { return window.localStorage.getItem(scope) === "true"; } catch { return false; }
  }, [scope]);
  const enabled = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const { data: issues = [], dataUpdatedAt: updatedAt } = useQuery({
    queryKey: completedInboxCleanupQueryKey(companyId ?? "__none__"),
    queryFn: () =>
      issuesApi.listCompact(companyId!, {
        touchedByUserId: "me",
        inboxArchivedByUserId: "me",
        status: "done",
        sortField: "updated",
        sortDir: "desc",
        limit: COMPLETED_INBOX_CLEANUP_SCAN_LIMIT,
      }).then((rows) => rows as Issue[]),
    enabled: enabled && !!scope,
    refetchInterval: COMPLETED_INBOX_CLEANUP_REFRESH_MS,
    refetchOnWindowFocus: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [pass, setPass] = useState(0);
  const latest = useRef({ scope, enabled, issues });
  latest.current = { scope, enabled, issues };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const running = useRef(false);
  const attempted = useRef(new Map<string, Set<string>>());
  // A failed or changed item is skipped for the rest of this refresh (so it cannot block the items
  // behind it) and retried on the next refresh.
  const deferred = useRef(new Map<string, number>());
  const setEnabled = useCallback((value: boolean) => {
    if (!scope) return;
    try {
      window.localStorage.setItem(scope, String(value));
      setError(null);
      window.dispatchEvent(new Event(preferenceEvent));
    } catch {
      setError("Could not save automatic inbox cleanup. Check browser storage and try again.");
    }
  }, [scope]);

  useEffect(() => {
    if (!enabled || !scope || !companyId || !updatedAt || running.current) return;
    const handled = attempted.current.get(scope) ?? new Set<string>();
    attempted.current.set(scope, handled);
    const batch = issues.filter((issue) => {
      const key = completionKey(issue);
      return issue.companyId === companyId && key && !handled.has(key) && deferred.current.get(key) !== updatedAt;
    }).slice(0, COMPLETED_INBOX_CLEANUP_BATCH_SIZE);
    if (!batch.length) return;
    running.current = true;
    let changed = false;
    let lastError: string | null = null;
    void (async () => {
      try {
        for (const issue of batch) {
          if (!mounted.current || latest.current.scope !== scope || !latest.current.enabled) break;
          const current = latest.current.issues.find((row) => row.id === issue.id);
          const key = completionKey(issue)!;
          if (!current || completionKey(current) !== key) {
            deferred.current.set(key, updatedAt);
            continue;
          }
          try {
            const result = await issuesApi.archiveCompletedFromInbox(
              issue.id, new Date(issue.completedAt!).toISOString(),
            );
            handled.add(key);
            changed ||= result.archived;
          } catch (cause) {
            deferred.current.set(key, updatedAt);
            lastError = cause instanceof Error ? cause.message : "Automatic inbox cleanup failed. Try refreshing the inbox.";
          }
        }
        if (mounted.current && latest.current.scope === scope) setError(lastError);
      } finally {
        running.current = false;
        if (changed) void invalidateInboxIssueQueries(queryClient, companyId);
        // Continue with the next batch of this refresh without waiting for new data.
        if (mounted.current) setPass((value) => value + 1);
      }
    })();
  }, [companyId, enabled, scope, issues, updatedAt, pass, queryClient]);

  return { enabled, setEnabled, error, available: scope !== null };
}
