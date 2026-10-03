import { useEffect, useMemo, useState } from "react";
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
  approvalDecisionBrief,
  approvalExcerpt,
  approvalSubject,
  OriginalRequestBlock,
  ApprovalPayloadRenderer,
  typeLabel,
} from "../components/ApprovalPayload";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";
import type { ApprovalComment } from "@paperclipai/shared";
import { MarkdownBody } from "../components/MarkdownBody";
import { timeAgo } from "../lib/timeAgo";

export function ApprovalDetail() {
  const { approvalId } = useParams<{ approvalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval) return <p className="text-sm text-muted-foreground">Approval not found.</p>;

  const payload = approval.payload as Record<string, unknown>;
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetApproval = approval.type === "budget_override_required";
  const kindLabel = typeLabel[approval.type] ?? approval.type;
  const subject = approvalExcerpt(approvalSubject(payload), 160) ?? kindLabel;
  const brief = approvalDecisionBrief(payload);
  // ponytail: Keep the board scan bounded; the complete request remains available below.
  const recommendation = approvalExcerpt(brief.recommendation, 320);
  const reasoning = approvalExcerpt(brief.reasoning, 420);
  const pros = brief.pros.slice(0, 3).map((item) => approvalExcerpt(item, 220)).filter(Boolean);
  const cons = brief.cons.slice(0, 3).map((item) => approvalExcerpt(item, 220)).filter(Boolean);
  const nextAction = approvalExcerpt(brief.nextAction, 280);
  const decisionPending =
    approveMutation.isPending ||
    rejectMutation.isPending ||
    revisionMutation.isPending ||
    resubmitMutation.isPending;
  const showApprovedBanner = searchParams.get("resolved") === "approved" && approval.status === "approved";
  const hasSupportingDetails =
    Boolean(linkedIssues?.length) ||
    (approval.status === "rejected" && approval.type === "hire_agent" && Boolean(linkedAgentId));
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

  return (
    <div className="max-w-3xl space-y-4">
      {showApprovedBanner && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">Approval confirmed</p>
              <p className="text-xs text-muted-foreground">
                The requesting agent was notified to continue the linked work.
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => navigate(resolvedCta.to)}>
            {resolvedCta.label}
          </Button>
        </div>
      )}

      <section className="space-y-5 rounded-lg border border-border p-4" aria-labelledby="approval-title">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <Badge
              variant="outline"
              className="border-border/70 px-2 py-0.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground"
            >
              {kindLabel}
            </Badge>
            <h1 id="approval-title" className="text-xl font-semibold leading-7 text-foreground">
              {subject}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {approval.requestedByAgentId && (
                <span className="inline-flex items-center gap-1.5">
                  Requested by
                  <Identity
                    name={agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8)}
                    size="sm"
                  />
                </span>
              )}
              <span>Created {timeAgo(approval.createdAt)}</span>
            </div>
          </div>
          <StatusBadge status={approval.status} />
        </header>

        <div className="space-y-5 border-t border-border/60 pt-4">
          <div className="rounded-lg bg-muted/40 px-3.5 py-3">
            <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
              Recommendation
            </p>
            <p className="mt-1 text-sm leading-6 text-foreground">
              {recommendation ?? "No recommendation was supplied."}
            </p>
          </div>

          {approval.type === "request_board_approval" && <OriginalRequestBlock payload={payload} />}

          <div>
            <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
              Why
            </p>
            <p className="mt-1 text-sm leading-6 text-foreground">
              {reasoning ?? "No rationale was supplied."}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                Pros
              </p>
              {pros.length > 0 ? (
                <ul className="mt-1.5 space-y-1.5 text-sm text-foreground">
                  {pros.map((item) => (
                    <li key={item} className="flex items-start gap-2 leading-5">
                      <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm leading-5 text-muted-foreground">No explicit benefit was supplied.</p>
              )}
            </div>
            <div>
              <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                Cons
              </p>
              {cons.length > 0 ? (
                <ul className="mt-1.5 space-y-1.5 text-sm text-foreground">
                  {cons.map((item) => (
                    <li key={item} className="flex items-start gap-2 leading-5">
                      <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm leading-5 text-muted-foreground">No explicit tradeoff was supplied.</p>
              )}
            </div>
          </div>

          {nextAction && (
            <div>
              <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                If approved
              </p>
              <p className="mt-1 text-sm leading-6 text-foreground">{nextAction}</p>
            </div>
          )}

          {approval.decisionNote && (
            <div className="border-t border-border/60 pt-4">
              <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                Decision note
              </p>
              <p className="mt-1 text-sm leading-6 text-foreground">{approval.decisionNote}</p>
            </div>
          )}
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        {isActionable && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
            {!isBudgetApproval && (
              <Button size="sm" onClick={() => approveMutation.mutate()} disabled={decisionPending}>
                {approveMutation.isPending ? "Approving…" : "Approve"}
              </Button>
            )}
            {approval.status === "pending" && !isBudgetApproval && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => revisionMutation.mutate()}
                disabled={decisionPending}
              >
                {revisionMutation.isPending ? "Requesting…" : "Request changes"}
              </Button>
            )}
            {!isBudgetApproval && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => rejectMutation.mutate()}
                disabled={decisionPending}
              >
                {rejectMutation.isPending ? "Rejecting…" : "Reject"}
              </Button>
            )}
            {isBudgetApproval && approval.status === "pending" && (
              <p className="text-sm text-muted-foreground">
                Resolve this budget stop in <Link to="/costs" className="underline underline-offset-2">Costs</Link>.
              </p>
            )}
            {approval.status === "revision_requested" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => resubmitMutation.mutate()}
                disabled={decisionPending}
              >
                {resubmitMutation.isPending ? "Resubmitting…" : "Mark resubmitted"}
              </Button>
            )}
          </div>
        )}
      </section>

      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">Full request</summary>
        <div className="border-t border-border/60 px-4 pb-4">
          <ApprovalPayloadRenderer type={approval.type} payload={payload} hidePrimaryTitle />
          <div className="mt-4 space-y-1 text-xs text-muted-foreground">
            <p>Request ID: <span className="font-mono break-all">{approval.id}</span></p>
            <p>Created: {new Date(approval.createdAt).toLocaleString()}</p>
          </div>
          <details className="mt-4 border-t border-border/60 pt-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Raw payload</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </details>
        </div>
      </details>

      {hasSupportingDetails && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">
            Supporting details{linkedIssues?.length ? ` (${linkedIssues.length} linked)` : ""}
          </summary>
          <div className="space-y-3 border-t border-border/60 p-4">
            {linkedIssues && linkedIssues.length > 0 && (
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
                <p className="text-(length:--text-micro) text-muted-foreground">
                  Linked tasks remain open until the requesting agent follows up.
                </p>
              </div>
            )}
            {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId && (
              <div className="border-t border-border/60 pt-3">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    if (!window.confirm("Delete this disapproved agent? This cannot be undone.")) return;
                    deleteAgentMutation.mutate(linkedAgentId);
                  }}
                  disabled={deleteAgentMutation.isPending}
                >
                  {deleteAgentMutation.isPending ? "Deleting…" : "Delete disapproved agent"}
                </Button>
              </div>
            )}
          </div>
        </details>
      )}

      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">
          Discussion ({comments?.length ?? 0})
        </summary>
        <div className="space-y-3 border-t border-border/60 p-4">
          <div className="space-y-2">
            {(comments ?? []).map((comment: ApprovalComment) => (
              <div key={comment.id} className="rounded-md border border-border/60 p-3">
                <div className="mb-1 flex items-center justify-between gap-3">
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
          <div className="space-y-1.5">
            <label htmlFor={`approval-comment-${approval.id}`} className="text-xs font-medium text-foreground">
              Add context
            </label>
            <Textarea
              id={`approval-comment-${approval.id}`}
              value={commentBody}
              onChange={(event) => setCommentBody(event.target.value)}
              placeholder="Add a comment…"
              rows={3}
            />
          </div>
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
      </details>
    </div>
  );
}
