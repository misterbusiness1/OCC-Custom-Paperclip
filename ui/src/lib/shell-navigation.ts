export type ContextualSidebarSurface =
  | "settings"
  | "apps"
  | "agent"
  | "routine"
  | "skills"
  | `plugin:${string}`;

export interface ShellRouteClassification {
  companySegments: string[];
  isTaskDetail: boolean;
  builtInContextualSurface: Exclude<ContextualSidebarSurface, `plugin:${string}`> | null;
}

const CONTEXTUAL_ORIGIN_KEY_PREFIX = "paperclip.contextualSidebar.origin";

export function getCompanyPathSegments(pathname: string, companyPrefix: string | undefined): string[] {
  if (!companyPrefix) return [];
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return [];
  if (segments[0]?.toUpperCase() !== companyPrefix.toUpperCase()) return [];
  return segments.slice(1);
}

/**
 * True on the Approvals pages: the queue (To decide), All decisions, and one
 * approval's own page. Read from the first path segment after the company
 * prefix, or the first segment of a path that carries no prefix.
 */
export function isApprovalsRoute(pathname: string, companyPrefix: string | undefined): boolean {
  const companySegments = getCompanyPathSegments(pathname, companyPrefix);
  const root = companySegments.length > 0 ? companySegments[0] : pathname.split("/").filter(Boolean)[0];
  return root?.toLowerCase() === "approvals";
}

/** True on the bare Approvals address, `/approvals` with or without a company prefix, which shows the queue. */
export function isBareApprovalsPath(pathname: string): boolean {
  return /\/approvals\/?$/i.test(pathname);
}

/**
 * Where the sidebar's Approvals item points. The short address makes it the
 * current item (highlight and `aria-current`) on To decide, on All decisions
 * and on an approval's own page, because the router marks a link current on
 * every page under its target. On To decide itself the item points at the
 * address the reader is on, with its query (the kind filter and the sort) and
 * its `#approval-<id>` target. It is still current there, and pressing it
 * changes nothing: no history entry, no cleared filter, and no scroll of the
 * queue under a reader who has an approval held or a note half typed.
 */
export function approvalsNavTarget(location: { pathname: string; search?: string; hash?: string }): string {
  if (!location.pathname.endsWith("/approvals/pending")) return "/approvals";
  return `/approvals/pending${location.search ?? ""}${location.hash ?? ""}`;
}

/**
 * The way back from an approval's own page to the queue, at that approval's card.
 * "View details" in the queue carries the queue's address (To decide or All
 * decisions, with its kind filter and sort) as `state.queue`. Anything else,
 * such as a page opened from the inbox, goes back to To decide. The
 * `#approval-<id>` target makes the queue open that card and move focus to it.
 */
export function approvalQueueReturnTarget(state: unknown, approvalId: string): string {
  const carried = state && typeof state === "object" ? (state as { queue?: unknown }).queue : null;
  const queue =
    typeof carried === "string" && /^(\/[^/?#]+)?\/approvals(\/(pending|all))?(\?[^#]*)?$/.test(carried)
      ? carried
      : "/approvals/pending";
  return `${queue}#approval-${encodeURIComponent(approvalId)}`;
}

export function classifyShellRoute(
  pathname: string,
  companyPrefix: string | undefined,
): ShellRouteClassification {
  const companySegments = getCompanyPathSegments(pathname, companyPrefix);
  const root = companySegments[0]?.toLowerCase();
  const isCompanySettings = root === "company" && ["settings", "export", "import"].includes(
    companySegments[1]?.toLowerCase() ?? "",
  );
  const agentSegment = companySegments[1]?.toLowerCase();
  const isAgentDetail = root === "agents"
    && Boolean(agentSegment)
    && agentSegment !== "new"
    && !["all", "active", "paused", "error", "builtin"].includes(agentSegment ?? "");
  const isRoutineDetail = root === "routines" && companySegments.length >= 2;
  const isSkillsSurface = root === "skills";

  return {
    companySegments,
    isTaskDetail: (root === "issues" || root === "chats") && companySegments.length >= 2,
    builtInContextualSurface: isCompanySettings
      ? "settings"
      : root === "apps" || root === "tools"
        ? "apps"
        : isAgentDetail
          ? "agent"
          : isRoutineDetail
            ? "routine"
            : isSkillsSurface
              ? "skills"
        : null,
  };
}

function contextualOriginStorageKey(surface: ContextualSidebarSurface, companyPrefix: string) {
  return `${CONTEXTUAL_ORIGIN_KEY_PREFIX}:${companyPrefix.toUpperCase()}:${surface}`;
}

function isCompanyPath(pathname: string, companyPrefix: string) {
  const first = pathname.split("/").filter(Boolean)[0];
  return first?.toUpperCase() === companyPrefix.toUpperCase();
}

export function rememberContextualSidebarOrigin({
  surface,
  companyPrefix,
  previousPathname,
}: {
  surface: ContextualSidebarSurface;
  companyPrefix: string;
  previousPathname: string;
}) {
  if (typeof window === "undefined" || !isCompanyPath(previousPathname, companyPrefix)) return;

  try {
    window.sessionStorage.setItem(
      contextualOriginStorageKey(surface, companyPrefix),
      previousPathname,
    );
  } catch {
    // Navigation still has a deterministic fallback when storage is unavailable.
  }
}

export function readContextualSidebarOrigin({
  surface,
  companyPrefix,
  fallbackTo,
}: {
  surface: ContextualSidebarSurface;
  companyPrefix: string | null | undefined;
  fallbackTo: string;
}) {
  if (typeof window === "undefined" || !companyPrefix) return fallbackTo;

  try {
    const stored = window.sessionStorage.getItem(contextualOriginStorageKey(surface, companyPrefix));
    return stored && isCompanyPath(stored, companyPrefix) ? stored : fallbackTo;
  } catch {
    return fallbackTo;
  }
}
