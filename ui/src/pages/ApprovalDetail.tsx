import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import {
  approvalLabel,
  typeIcon,
  defaultTypeIcon,
  ApprovalPayloadRenderer,
  extractApprovalMeta,
  GateBadge,
  RiskBadge,
} from "../components/ApprovalPayload";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { CheckCircle2, ChevronRight, FileJson2, Sparkles } from "lucide-react";
import type { ApprovalComment } from "@paperclipai/shared";
import { MarkdownBody } from "../components/MarkdownBody";
import { FeatureFlags, useFeatureFlag } from "../lib/featureFlags";
import {
  APPROVAL_SHORTCUT_HINTS,
  resolveApprovalShortcut,
} from "../lib/approvalShortcuts";

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function ApprovalDetail() {
  const { approvalId } = useParams<{ approvalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRawPayload, setShowRawPayload] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const decisionCard = useFeatureFlag(FeatureFlags.approvalsDecisionCard);

  const { data: approval, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId!),
    queryFn: () => approvalsApi.get(approvalId!),
    enabled: !!approvalId,
  });
  const resolvedCompanyId = approval?.companyId ?? selectedCompanyId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.approvals.comments(approvalId!),
    queryFn: () => approvalsApi.listComments(approvalId!),
    enabled: !!approvalId,
  });

  const { data: linkedIssues } = useQuery({
    queryKey: queryKeys.approvals.issues(approvalId!),
    queryFn: () => approvalsApi.listIssues(approvalId!),
    enabled: !!approvalId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? ""),
    queryFn: () => agentsApi.list(resolvedCompanyId ?? ""),
    enabled: !!resolvedCompanyId,
  });

  useEffect(() => {
    if (!approval?.companyId || approval.companyId === selectedCompanyId) return;
    setSelectedCompanyId(approval.companyId, { source: "route_sync" });
  }, [approval?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Approvals", href: "/approvals" },
      { label: approval?.id?.slice(0, 8) ?? approvalId ?? "Approval" },
    ]);
  }, [setBreadcrumbs, approval, approvalId]);

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.comments(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.issues(approvalId) });
    if (approval?.companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(approval.companyId, "pending"),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(approval.companyId) });
    }
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate(`/approvals/${approvalId}?resolved=approved`, { replace: true });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Reject failed"),
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Revision request failed"),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Resubmit failed"),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Comment failed"),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate("/approvals");
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Delete failed"),
  });

  useEffect(() => {
    if (!decisionCard || !approval) return;
    const actionable = approval.status === "pending" || approval.status === "revision_requested";
    const budget = approval.type === "budget_override_required";
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      const action = resolveApprovalShortcut(e.key, {
        isActionable: actionable,
        isBudgetApproval: budget,
        status: approval!.status,
        typingInField: typing,
      });
      if (!action) return;
      e.preventDefault();
      if (action === "approve") approveMutation.mutate();
      else if (action === "reject") rejectMutation.mutate();
      else if (action === "request_revision") revisionMutation.mutate();
      else if (action === "toggle_raw") setRawOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decisionCard, approval, approveMutation, rejectMutation, revisionMutation]);

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval) return <p className="text-sm text-muted-foreground">Approval not found.</p>;

  const payload = approval.payload as Record<string, unknown>;
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetApproval = approval.type === "budget_override_required";
  const TypeIcon = typeIcon[approval.type] ?? defaultTypeIcon;
  const showApprovedBanner = searchParams.get("resolved") === "approved" && approval.status === "approved";
  const primaryLinkedIssue = linkedIssues?.[0] ?? null;
  const resolvedCta =
    primaryLinkedIssue
      ? {
          label:
            (linkedIssues?.length ?? 0) > 1
              ? "Review linked tasks"
              : "Review linked task",
          to: `/issues/${primaryLinkedIssue.identifier ?? primaryLinkedIssue.id}`,
        }
      : linkedAgentId
        ? {
            label: "Open hired agent",
            to: `/agents/${linkedAgentId}`,
          }
        : {
            label: "Back to approvals",
            to: "/approvals",
          };

  const meta = extractApprovalMeta({
    payload,
    requestedByAgentId: approval.requestedByAgentId,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt,
  });
  const requesterName = approval.requestedByAgentId
    ? agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8)
    : null;
  const fmtTs = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);
  const hasActionBar =
    (isActionable && !isBudgetApproval) ||
    (isBudgetApproval && approval.status === "pending") ||
    approval.status === "pending" ||
    approval.status === "revision_requested" ||
    (approval.status === "rejected" && approval.type === "hire_agent" && !!linkedAgentId);

  if (decisionCard) {
    return (
      <div className="max-w-3xl space-y-6 pb-24">
        {showApprovedBanner && (
          <div className="border border-green-300 dark:border-green-700/40 bg-green-50 dark:bg-green-900/20 rounded-lg px-4 py-3 animate-in fade-in zoom-in-95 duration-300">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <div className="relative mt-0.5">
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                  <Sparkles className="h-3 w-3 text-green-500 dark:text-green-200 absolute -right-2 -top-1 animate-pulse" />
                </div>
                <div>
                  <p className="text-sm text-green-800 dark:text-green-100 font-medium">Approval confirmed</p>
                  <p className="text-xs text-green-700 dark:text-green-200/90">
                    Requesting agent was notified to review this approval and linked tasks.
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="border-green-400 dark:border-green-600/50 text-green-800 dark:text-green-100 hover:bg-green-100 dark:hover:bg-green-900/30"
                onClick={() => navigate(resolvedCta.to)}
              >
                {resolvedCta.label}
              </Button>
            </div>
          </div>
        )}

        {/* Header strip + at-a-glance panel */}
        <div className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/80">
                <TypeIcon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold leading-6">
                  {approvalLabel(approval.type, payload)}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <GateBadge gate={meta.gate} />
                  <RiskBadge risk={meta.risk} />
                  {meta.slaLabel && (
                    <span className="inline-flex items-center rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                      {meta.slaLabel}
                    </span>
                  )}
                  <span className="font-mono text-xs text-muted-foreground">
                    {approval.id.slice(0, 8)}
                  </span>
                </div>
              </div>
            </div>
            <StatusBadge status={approval.status} />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-4">
            <MetaItem label="Requested by">
              {requesterName ? (
                <Identity name={requesterName} size="sm" />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </MetaItem>
            <MetaItem label="Requested">{fmtTs(meta.requestedAt) ?? "—"}</MetaItem>
            <MetaItem label="SLA / deadline">
              {meta.slaLabel ?? fmtTs(meta.deadline) ?? "—"}
            </MetaItem>
            <MetaItem label="Decided">{fmtTs(meta.decidedAt) ?? "Pending"}</MetaItem>
          </dl>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Evidence zone */}
        <div className="space-y-4 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Request detail</h3>
            <Sheet open={rawOpen} onOpenChange={setRawOpen}>
              <SheetTrigger asChild>
                <Button size="sm" variant="outline" className="gap-1.5">
                  <FileJson2 className="h-3.5 w-3.5" /> View raw payload
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
                <SheetHeader>
                  <SheetTitle>Raw approval payload</SheetTitle>
                  <SheetDescription className="font-mono text-xs">{approval.id}</SheetDescription>
                </SheetHeader>
                <pre className="mt-4 overflow-x-auto rounded-md bg-muted/40 p-3 text-xs">
                  {JSON.stringify(payload, null, 2)}
                </pre>
              </SheetContent>
            </Sheet>
          </div>

          <ApprovalPayloadRenderer type={approval.type} payload={payload} />

          {approval.decisionNote && (
            <div className="rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
              <span className="font-medium text-foreground">Decision note.</span>{" "}
              {approval.decisionNote}
            </div>
          )}

          {linkedIssues && linkedIssues.length > 0 && (
            <div className="border-t border-border/60 pt-3">
              <p className="mb-1.5 text-xs text-muted-foreground">Linked tasks</p>
              <div className="space-y-1.5">
                {linkedIssues.map((issue) => (
                  <Link
                    key={issue.id}
                    to={`/issues/${issue.identifier ?? issue.id}`}
                    className="block rounded border border-border/70 px-2 py-1.5 text-xs hover:bg-accent/20"
                  >
                    <span className="mr-2 font-mono text-muted-foreground">
                      {issue.identifier ?? issue.id.slice(0, 8)}
                    </span>
                    <span>{issue.title}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Comments */}
        <div className="space-y-3 rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium">Comments ({comments?.length ?? 0})</h3>
          <div className="space-y-2">
            {(comments ?? []).map((comment: ApprovalComment) => (
              <div key={comment.id} className="rounded-md border border-border/60 p-3">
                <div className="mb-1 flex items-center justify-between">
                  {comment.authorAgentId ? (
                    <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                      <Identity
                        name={agentNameById.get(comment.authorAgentId) ?? comment.authorAgentId.slice(0, 8)}
                        size="sm"
                      />
                    </Link>
                  ) : (
                    <Identity name="Board" size="sm" />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {new Date(comment.createdAt).toLocaleString()}
                  </span>
                </div>
                <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
              </div>
            ))}
          </div>
          <Textarea
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            placeholder="Add a comment..."
            rows={3}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => addCommentMutation.mutate()}
              disabled={!commentBody.trim() || addCommentMutation.isPending}
            >
              {addCommentMutation.isPending ? "Posting…" : "Post comment"}
            </Button>
          </div>
        </div>

        {/* Sticky action bar */}
        {hasActionBar && (
          <div className="sticky bottom-0 -mx-4 mt-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {isActionable && !isBudgetApproval && (
                  <>
                    <Button
                      size="sm"
                      className="bg-green-700 hover:bg-green-600 text-white"
                      onClick={() => approveMutation.mutate()}
                      disabled={approveMutation.isPending}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => rejectMutation.mutate()}
                      disabled={rejectMutation.isPending}
                    >
                      Reject
                    </Button>
                  </>
                )}
                {isBudgetApproval && approval.status === "pending" && (
                  <p className="text-sm text-muted-foreground">
                    Resolve this budget stop from the budget controls on{" "}
                    <Link to="/costs" className="underline underline-offset-2">
                      /costs
                    </Link>
                    .
                  </p>
                )}
                {approval.status === "pending" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => revisionMutation.mutate()}
                    disabled={revisionMutation.isPending}
                  >
                    Request revision
                  </Button>
                )}
                {approval.status === "revision_requested" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resubmitMutation.mutate()}
                    disabled={resubmitMutation.isPending}
                  >
                    Mark resubmitted
                  </Button>
                )}
                {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive border-destructive/40"
                    onClick={() => {
                      if (!window.confirm("Delete this disapproved agent? This cannot be undone.")) return;
                      deleteAgentMutation.mutate(linkedAgentId);
                    }}
                    disabled={deleteAgentMutation.isPending}
                  >
                    Delete disapproved agent
                  </Button>
                )}
              </div>
              <p className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
                {APPROVAL_SHORTCUT_HINTS.map((hint) => (
                  <span key={hint.keys} className="inline-flex items-center gap-1">
                    <kbd className="rounded border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                      {hint.keys}
                    </kbd>
                    {hint.label}
                  </span>
                ))}
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {showApprovedBanner && (
        <div className="border border-green-300 dark:border-green-700/40 bg-green-50 dark:bg-green-900/20 rounded-lg px-4 py-3 animate-in fade-in zoom-in-95 duration-300">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <div className="relative mt-0.5">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                <Sparkles className="h-3 w-3 text-green-500 dark:text-green-200 absolute -right-2 -top-1 animate-pulse" />
              </div>
              <div>
                <p className="text-sm text-green-800 dark:text-green-100 font-medium">Approval confirmed</p>
                <p className="text-xs text-green-700 dark:text-green-200/90">
                  Requesting agent was notified to review this approval and linked tasks.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-green-400 dark:border-green-600/50 text-green-800 dark:text-green-100 hover:bg-green-100 dark:hover:bg-green-900/30"
              onClick={() => navigate(resolvedCta.to)}
            >
              {resolvedCta.label}
            </Button>
          </div>
        </div>
      )}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TypeIcon className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <h2 className="text-lg font-semibold">{approvalLabel(approval.type, approval.payload as Record<string, unknown> | null)}</h2>
              <p className="text-xs text-muted-foreground font-mono">{approval.id}</p>
            </div>
          </div>
          <StatusBadge status={approval.status} />
        </div>
        <div className="text-sm space-y-1">
          {approval.requestedByAgentId && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Requested by</span>
              <Identity
                name={agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8)}
                size="sm"
              />
            </div>
          )}
          <ApprovalPayloadRenderer type={approval.type} payload={payload} />
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-2"
            onClick={() => setShowRawPayload((v) => !v)}
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${showRawPayload ? "rotate-90" : ""}`} />
            See full request
          </button>
          {showRawPayload && (
            <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-x-auto">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
          {approval.decisionNote && (
            <p className="text-xs text-muted-foreground">Decision note: {approval.decisionNote}</p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {linkedIssues && linkedIssues.length > 0 && (
          <div className="pt-2 border-t border-border/60">
            <p className="text-xs text-muted-foreground mb-1.5">Linked Tasks</p>
            <div className="space-y-1.5">
              {linkedIssues.map((issue) => (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="block text-xs rounded border border-border/70 px-2 py-1.5 hover:bg-accent/20"
                >
                  <span className="font-mono text-muted-foreground mr-2">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span>{issue.title}</span>
                </Link>
              ))}
            </div>
            <p className="text-(length:--text-micro) text-muted-foreground mt-2">
              Linked tasks remain open until the requesting agent follows up and closes them.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {isActionable && !isBudgetApproval && (
            <>
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => rejectMutation.mutate()}
                disabled={rejectMutation.isPending}
              >
                Reject
              </Button>
            </>
          )}
          {isBudgetApproval && approval.status === "pending" && (
            <p className="text-sm text-muted-foreground">
              Resolve this budget stop from the budget controls on <Link to="/costs" className="underline underline-offset-2">/costs</Link>.
            </p>
          )}
          {approval.status === "pending" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => revisionMutation.mutate()}
              disabled={revisionMutation.isPending}
            >
              Request revision
            </Button>
          )}
          {approval.status === "revision_requested" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => resubmitMutation.mutate()}
              disabled={resubmitMutation.isPending}
            >
              Mark resubmitted
            </Button>
          )}
          {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/40"
              onClick={() => {
                if (!window.confirm("Delete this disapproved agent? This cannot be undone.")) return;
                deleteAgentMutation.mutate(linkedAgentId);
              }}
              disabled={deleteAgentMutation.isPending}
            >
              Delete disapproved agent
            </Button>
          )}
        </div>
      </div>

      <div className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium">Comments ({comments?.length ?? 0})</h3>
        <div className="space-y-2">
          {(comments ?? []).map((comment: ApprovalComment) => (
            <div key={comment.id} className="border border-border/60 rounded-md p-3">
              <div className="flex items-center justify-between mb-1">
                {comment.authorAgentId ? (
                  <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                    <Identity
                      name={agentNameById.get(comment.authorAgentId) ?? comment.authorAgentId.slice(0, 8)}
                      size="sm"
                    />
                  </Link>
                ) : (
                  <Identity name="Board" size="sm" />
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(comment.createdAt).toLocaleString()}
                </span>
              </div>
              <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
            </div>
          ))}
        </div>
        <Textarea
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => addCommentMutation.mutate()}
            disabled={!commentBody.trim() || addCommentMutation.isPending}
          >
            {addCommentMutation.isPending ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}
