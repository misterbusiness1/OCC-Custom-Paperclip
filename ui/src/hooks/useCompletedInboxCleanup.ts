import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { invalidateInboxIssueQueries } from "../lib/inboxArchiveCache";

const preferenceEvent = "paperclip:completed-inbox-cleanup";
export const COMPLETED_INBOX_CLEANUP_BATCH_SIZE = 10;
export const completedInboxCleanupKey = (companyId: string, userId: string) =>
  `paperclip.completedInboxCleanup:${companyId}:${userId}`;

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

/** Runs only while Inbox is open, using its existing user-scoped query refreshes. */
export function useCompletedInboxCleanup({ companyId, userId, issues, updatedAt }: {
  companyId: string | null;
  userId: string | null;
  issues: Issue[];
  updatedAt: number;
}) {
  const queryClient = useQueryClient();
  const scope = companyId && userId ? completedInboxCleanupKey(companyId, userId) : null;
  const getSnapshot = useCallback(() => {
    if (!scope) return false;
    try { return window.localStorage.getItem(scope) === "true"; } catch { return false; }
  }, [scope]);
  const enabled = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ scope, enabled, issues });
  latest.current = { scope, enabled, issues };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const running = useRef(false);
  const attempted = useRef(new Map<string, Set<string>>());
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
      return issue.companyId === companyId && key && !handled.has(key);
    }).slice(0, COMPLETED_INBOX_CLEANUP_BATCH_SIZE);
    if (!batch.length) return;
    running.current = true;
    let changed = false;
    void (async () => {
      try {
        for (const issue of batch) {
          if (!mounted.current || latest.current.scope !== scope || !latest.current.enabled) break;
          const current = latest.current.issues.find((row) => row.id === issue.id);
          if (!current || completionKey(current) !== completionKey(issue)) continue;
          const result = await issuesApi.archiveCompletedFromInbox(
            issue.id, new Date(issue.completedAt!).toISOString(),
          );
          handled.add(completionKey(issue)!);
          changed ||= result.archived;
        }
        if (mounted.current && latest.current.scope === scope) setError(null);
      } catch (cause) {
        if (mounted.current && latest.current.scope === scope) {
          setError(cause instanceof Error ? cause.message : "Automatic inbox cleanup failed. Try refreshing the inbox.");
        }
      } finally {
        running.current = false;
        if (changed) invalidateInboxIssueQueries(queryClient, companyId);
      }
    })();
  }, [companyId, enabled, scope, issues, updatedAt, queryClient]);

  return { enabled, setEnabled, error, available: scope !== null };
}
