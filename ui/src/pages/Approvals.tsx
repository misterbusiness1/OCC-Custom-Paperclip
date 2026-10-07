import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useQueries, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useGeneralSettings } from "../context/GeneralSettingsContext";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "../lib/keyboardShortcuts";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { ShieldCheck } from "lucide-react";
import { ApprovalCard } from "../components/ApprovalCard";
import { approvalExcerpt, approvalSubject, isEmailReplyPayload, typeLabel } from "../components/ApprovalPayload";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";

type StatusFilter = "pending" | "all";
type SortOrder = "oldest" | "newest";
type Decision = { id: string; note?: string };
const PAGE_SIZE = 20;
const EMAIL_REPLY_KIND = "email_reply";

function isActionable(approval: Approval) {
  return approval.status === "pending" || approval.status === "revision_requested";
}

function approvalKind(approval: Approval): string {
  return approval.type === "request_board_approval" && isEmailReplyPayload(approval.payload)
    ? EMAIL_REPLY_KIND
    : approval.type;
}

function kindLabel(kind: string): string {
  return kind === EMAIL_REPLY_KIND ? "Email replies" : (typeLabel[kind] ?? kind);
}

/** What is left of a card once it is decided here, so the queue keeps its place. */
function DecidedApprovalRow({ approval, focusable }: { approval: Approval; focusable: boolean }) {
  const subject =
    approvalExcerpt(approvalSubject(approval.payload, approval.type), 120) ?? typeLabel[approval.type] ?? approval.type;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-approval-card={approval.id}
      tabIndex={focusable ? -1 : undefined}
    >
      <StatusBadge status={approval.status} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{subject}</span>
      <Link
        to={`/approvals/${approval.id}`}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-auto px-2 text-xs text-muted-foreground")}
      >
        View details
      </Link>
      {approval.decisionNote && (
        <p className="basis-full break-words text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">Your note.</span> {approval.decisionNote}
        </p>
      )}
    </div>
  );
}

export function Approvals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { keyboardShortcutsEnabled } = useGeneralSettings();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";
  const [actionError, setActionError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [sortOverride, setSortOverride] = useState<SortOrder | null>(null);
  const [kindFilter, setKindFilter] = useState<string>("all");
  // Approvals decided on this visit stay listed as a compact row, so deciding
  // one request does not move the rest of the queue or leave the page.
  const [decidedHere, setDecidedHere] = useState<Record<string, Approval>>({});
  const listRef = useRef<HTMLDivElement>(null);
  // The oldest request has waited longest, so it leads the queue; history reads newest first.
  const sortOrder: SortOrder = sortOverride ?? (statusFilter === "pending" ? "oldest" : "newest");

  useEffect(() => {
    setBreadcrumbs([{ label: "Approvals" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setKindFilter("all");
    setDecidedHere({});
  }, [statusFilter, selectedCompanyId]);

  useEffect(() => {
    if (!keyboardShortcutsEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "j" && event.key !== "k") return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isKeyboardShortcutTextInputTarget(event.target) || hasBlockingShortcutDialog(document)) return;
      const cards = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-approval-card]") ?? []);
      if (cards.length === 0) return;
      const active = document.activeElement instanceof HTMLElement
        ? document.activeElement.closest<HTMLElement>("[data-approval-card]")
        : null;
      const current = active ? cards.indexOf(active) : -1;
      const next = current < 0
        ? 0
        : Math.max(0, Math.min(cards.length - 1, current + (event.key === "j" ? 1 : -1)));
      event.preventDefault();
      cards[next].focus();
      cards[next].scrollIntoView?.({ block: "nearest" });
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [keyboardShortcutsEnabled]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const handleDecided = (approval: Approval) => {
    setActionError(null);
    setDecidedHere((current) => ({ ...current, [approval.id]: approval }));
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approval.id) });
  };

  const approveMutation = useMutation({
    mutationFn: ({ id, note }: Decision) => (note ? approvalsApi.approve(id, note) : approvalsApi.approve(id)),
    onSuccess: handleDecided,
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: Decision) => (note ? approvalsApi.reject(id, note) : approvalsApi.reject(id)),
    onSuccess: handleDecided,
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const revisionMutation = useMutation({
    mutationFn: ({ id, note }: Decision) => approvalsApi.requestRevision(id, note),
    onSuccess: handleDecided,
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to request changes");
    },
  });

  const inTab = (data ?? []).filter(
    (a) => statusFilter === "all" || isActionable(a) || Boolean(decidedHere[a.id]),
  );
  const kinds = Array.from(new Set(inTab.map(approvalKind)));
  const activeKind = kinds.includes(kindFilter) ? kindFilter : "all";
  const filtered = inTab
    .filter((a) => activeKind === "all" || approvalKind(a) === activeKind)
    .sort((a, b) => {
      const delta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortOrder === "oldest" ? delta : -delta;
    });

  const pendingCount = (data ?? []).filter(isActionable).length;
  const visible = filtered.slice(0, visibleCount);
  const remaining = filtered.length - visible.length;

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
                  }}
                >
                  {kind === "all" ? "All" : kindLabel(kind)}
                </Button>
              ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {keyboardShortcutsEnabled && statusFilter === "pending" && (
              <span className="hidden text-xs text-muted-foreground md:inline">
                J / K to move · Shift+A approve · Shift+C request changes · Shift+X reject
              </span>
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

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}

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
          <div className="grid gap-3" ref={listRef}>
            {visible.map((approval, index) => {
              const decided = decidedHere[approval.id];
              if (decided) {
                return (
                  <DecidedApprovalRow key={approval.id} approval={decided} focusable={keyboardShortcutsEnabled} />
                );
              }
              const approving = approveMutation.isPending && approveMutation.variables?.id === approval.id;
              const rejecting = rejectMutation.isPending && rejectMutation.variables?.id === approval.id;
              const revising = revisionMutation.isPending && revisionMutation.variables?.id === approval.id;
              return (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                  onApprove={(note) => approveMutation.mutate({ id: approval.id, note })}
                  onReject={(note) => rejectMutation.mutate({ id: approval.id, note })}
                  onRequestRevision={(note) => revisionMutation.mutate({ id: approval.id, note })}
                  detailLink={`/approvals/${approval.id}`}
                  isPending={approving || rejecting || revising}
                  pendingAction={approving ? "approve" : rejecting ? "reject" : revising ? "revision" : null}
                  linkedIssues={linkedIssueQueries[index]?.data}
                  enableShortcuts={keyboardShortcutsEnabled}
                  resolveAgentName={(agentId) => (agents ?? []).find((a) => a.id === agentId)?.name ?? null}
                />
              );
            })}
          </div>
          {remaining > 0 && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" size="sm" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, remaining)} more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
