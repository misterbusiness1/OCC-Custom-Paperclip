import { AgentIdentity } from "@/components/AgentIdentity";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { approvalQueueReturnTarget } from "../lib/shell-navigation";
import { cn } from "../lib/utils";
import { APPROVAL_DETAILS_LINK_CLASS } from "../components/ApprovalCard";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import {
  approvalExcerpt,
  approvalSubject,
  ApprovalPayloadRenderer,
  BudgetOverridePayload,
  typeLabel,
} from "../components/ApprovalPayload";
import {
  ApprovalDecisionActions,
  approvalDecisionErrorText,
  useSettlingApprovals,
} from "../components/ApprovalDecisionActions";
import type { ApprovalVersion } from "../lib/approval-version";
import { ApprovalDecisionSummary, type ApprovalAgentNameResolver } from "../components/ApprovalDecisionSummary";
import { ApprovalSectionHeadingLevel } from "../components/ApprovalSectionLabel";
import { APPROVE_AFTER_ADVANCE_MS } from "../components/ApprovalHold";
import {
  APPROVAL_CHANGES_ASKED_LABEL,
  ApprovalRevisedNotice,
  useApprovalRevisionGuard,
} from "../components/ApprovalRevision";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";
import { approvalChangeRequestFromCommentBody, type ApprovalComment } from "@paperclipai/shared";
import { MarkdownBody } from "../components/MarkdownBody";
import { timeAgo } from "../lib/timeAgo";

/** Shown where an agent's name is not known. An id, or a piece of one, is never shown as a name. */
const UNKNOWN_AGENT_NAME = "An agent";
/** About how much of the request's subject the last breadcrumb holds. */
const BREADCRUMB_SUBJECT_LENGTH = 40;
/**
 * Asked before "Mark resubmitted" is sent. The server sets the request back to pending as it is,
 * keeps the change request on it, and from then on refuses the requester's own resubmission.
 */
export const MARK_RESUBMITTED_CONFIRM =
  "Mark this request as resubmitted? It returns to the queue unchanged. Your change request stays on it, " +
  "and the requester can no longer resubmit a revised version.";

/** A decision as it is sent: the note, and the `updatedAt` of the request as the page showed it when the button was pressed. */
type DecisionInput = { note?: string; expectedUpdatedAt: ApprovalVersion };

export function ApprovalDetail() {
  const { approvalId } = useParams<{ approvalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Back to the queue view the reader came from, with its filter and sort, at this request's card.
  const queueHref = approvalQueueReturnTarget(useLocation().state, approvalId ?? "");
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  // Each failure is reported beside the control that caused it.
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { markDecided, isSettling } = useSettlingApprovals();

  const { data: approval, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId!),
    queryFn: () => approvalsApi.get(approvalId!),
    enabled: !!approvalId,
  });
  const resolvedCompanyId = approval?.companyId ?? selectedCompanyId;
  // A request resubmitted while this page is open is not approved until the board confirms it read the revision.
  const revision = useApprovalRevisionGuard(approval);

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

  // The request's names, converted once per payload. The last crumb names the request by its
  // subject, or by its kind when it has none; never by its id. The heading carries the whole
  // title; the decision buttons name the request by a shorter form of it.
  const approvalPayload = approval?.payload as Record<string, unknown> | undefined;
  const approvalType = approval?.type;
  const names = useMemo(() => {
    if (!approvalType) return { breadcrumb: "Approval", title: "Approval", subject: "Approval" };
    const kind = typeLabel[approvalType] ?? approvalType;
    const subjectText = approvalSubject(approvalPayload, approvalType);
    return {
      breadcrumb: approvalExcerpt(subjectText, BREADCRUMB_SUBJECT_LENGTH) ?? kind,
      title: approvalExcerpt(subjectText, Number.POSITIVE_INFINITY) ?? kind,
      subject: approvalExcerpt(subjectText, 160) ?? kind,
    };
  }, [approvalPayload, approvalType]);
  const breadcrumbLabel = names.breadcrumb;

  useEffect(() => {
    setBreadcrumbs([{ label: "Approvals", href: queueHref }, { label: breadcrumbLabel }]);
  }, [setBreadcrumbs, breadcrumbLabel, queueHref]);

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

  const failDecision = (message: string) => {
    setDecisionError(message);
    // An error does not prove the decision was not stored: reload, so the page shows the status the server holds.
    refresh();
  };

  const approveMutation = useMutation({
    mutationFn: ({ note, expectedUpdatedAt }: DecisionInput) =>
      approvalsApi.approve(approvalId!, note || undefined, { expectedUpdatedAt }),
    onMutate: () => setDecisionError(null),
    onSuccess: (decided) => {
      markDecided(decided);
      refresh();
      navigate(`/approvals/${approvalId}?resolved=approved`, { replace: true });
    },
    onError: (err) => failDecision(approvalDecisionErrorText("approve", err)),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ note, expectedUpdatedAt }: DecisionInput) =>
      approvalsApi.reject(approvalId!, note || undefined, { expectedUpdatedAt }),
    onMutate: () => setDecisionError(null),
    onSuccess: (decided) => {
      markDecided(decided);
      refresh();
    },
    onError: (err) => failDecision(approvalDecisionErrorText("reject", err)),
  });

  const revisionMutation = useMutation({
    mutationFn: ({ note, expectedUpdatedAt }: DecisionInput) =>
      approvalsApi.requestRevision(approvalId!, note, { expectedUpdatedAt }),
    onMutate: () => setDecisionError(null),
    onSuccess: (decided) => {
      markDecided(decided);
      refresh();
    },
    onError: (err) => failDecision(approvalDecisionErrorText("revision", err)),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approvalId!),
    onMutate: () => setDecisionError(null),
    onSuccess: () => {
      refresh();
    },
    onError: (err) => failDecision(err instanceof Error ? err.message : "Resubmit failed"),
  });

  // One stray press would put the unchanged request back in the queue and lock the requester out of revising it.
  const markResubmitted = () => {
    if (!window.confirm(MARK_RESUBMITTED_CONFIRM)) return;
    resubmitMutation.mutate();
  };

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onMutate: () => setCommentError(null),
    onSuccess: () => {
      setCommentBody("");
      refresh();
    },
    onError: (err) => setCommentError(err instanceof Error ? err.message : "Comment failed"),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onMutate: () => setDeleteError(null),
    onSuccess: () => {
      refresh();
      navigate("/approvals");
    },
    onError: (err) => setDeleteError(err instanceof Error ? err.message : "Delete failed"),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval) return <p className="text-sm text-muted-foreground">Approval not found.</p>;

  const payload = approval.payload as Record<string, unknown>;
  // Null when the loaded agent list holds no such agent; undefined while the list is not known.
  const resolveAgentName: ApprovalAgentNameResolver = (agentId) =>
    agents ? (agentNameById.get(agentId) ?? null) : undefined;
  /** An agent as the page names it: by its name, or as "An agent" (with a neutral avatar) when the name is not known. */
  const agentIdentity = (agentId: string) => {
    const agent = agents?.find((candidate) => candidate.id === agentId);
    return agent ? <AgentIdentity agent={agent} size="sm" /> : <Identity name={UNKNOWN_AGENT_NAME} initials="?" size="sm" />;
  };
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetApproval = approval.type === "budget_override_required";
  const showDecisionActions = isActionable && !isBudgetApproval;
  const kindLabel = typeLabel[approval.type] ?? approval.type;
  const { title, subject } = names;
  const decisionPending =
    approveMutation.isPending ||
    rejectMutation.isPending ||
    revisionMutation.isPending ||
    resubmitMutation.isPending ||
    isSettling(approval);
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
      <div>
        <Link to={queueHref} className={cn(APPROVAL_DETAILS_LINK_CLASS, "-ml-2")} data-approval-back-to-queue="">
          Back to the queue
        </Link>
      </div>
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
            <h1 id="approval-title" className="break-words text-xl font-semibold leading-7 text-foreground">
              {title}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {approval.requestedByAgentId && (
                <span className="inline-flex items-center gap-1.5">
                  Requested by
                  {agentIdentity(approval.requestedByAgentId)}
                </span>
              )}
              <span>Created {timeAgo(approval.createdAt)}</span>
            </div>
          </div>
          <StatusBadge status={approval.status} />
        </header>

        <div className="space-y-5 border-t border-border/60 pt-4">
          <ApprovalRevisedNotice guard={revision} />
          {/* This page has the room: everything the board decides on is shown in full, above the buttons. */}
          {isBudgetApproval ? (
            <div className="-mt-3">
              <BudgetOverridePayload payload={payload} />
            </div>
          ) : (
            // The page's title is its h1, so the labels of the request's sections are h2.
            <ApprovalSectionHeadingLevel.Provider value={2}>
              <ApprovalDecisionSummary
                type={approval.type}
                payload={payload}
                status={approval.status}
                requestedByAgentId={approval.requestedByAgentId}
                resolveAgentName={resolveAgentName}
                full
              />
            </ApprovalSectionHeadingLevel.Provider>
          )}

          {approval.decisionNote && (
            <div className="border-t border-border/60 pt-4">
              <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                {/* Sent back, or resubmitted since: the note is the board's change request. */}
                {approval.status === "revision_requested" || approval.status === "pending"
                  ? APPROVAL_CHANGES_ASKED_LABEL
                  : "Decision note"}
              </p>
              {/* The board's own words, as typed: a numbered list of changes keeps its lines. */}
              <p
                className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-foreground"
                data-approval-decision-note
              >
                {approval.decisionNote}
              </p>
            </div>
          )}
        </div>

        {/* The decision buttons carry their own error; this line is for a request that no longer shows them. */}
        {decisionError && !showDecisionActions && (
          <p role="alert" className="break-words text-sm font-medium leading-5 text-destructive">
            {decisionError}
          </p>
        )}

        {isActionable && (
          <div className="space-y-3 border-t border-border/60 pt-4">
            {showDecisionActions && (
              <ApprovalDecisionActions
                key={approval.id}
                approveArmDelayMs={APPROVE_AFTER_ADVANCE_MS}
                subject={subject}
                status={approval.status}
                // Each decision names the version on the page now; the server refuses it for any later one.
                onApprove={(note) => approveMutation.mutate({ note, expectedUpdatedAt: approval.updatedAt })}
                onReject={(note) => rejectMutation.mutate({ note, expectedUpdatedAt: approval.updatedAt })}
                onRequestRevision={
                  approval.requestedByAgentId
                    ? (note) => revisionMutation.mutate({ note, expectedUpdatedAt: approval.updatedAt })
                    : undefined
                }
                isPending={decisionPending}
                pendingAction={
                  approveMutation.isPending
                    ? "approve"
                    : rejectMutation.isPending
                      ? "reject"
                      : revisionMutation.isPending
                        ? "revision"
                        : null
                }
                error={decisionError}
                onDismissError={() => setDecisionError(null)}
                approveGuard={revision.approveGuard}
                approveHoldKey={revision.reviewCount}
                trailing={
                  approval.status === "revision_requested" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={markResubmitted}
                      disabled={decisionPending}
                    >
                      {resubmitMutation.isPending ? "Resubmitting…" : "Mark resubmitted"}
                    </Button>
                  ) : null
                }
              />
            )}
            {isBudgetApproval && approval.status === "pending" && (
              <p className="text-sm text-muted-foreground">
                Resolve this budget stop in <Link to="/costs" className="underline underline-offset-2">Costs</Link>.
              </p>
            )}
            {isBudgetApproval && approval.status === "revision_requested" && (
              <Button
                size="sm"
                variant="outline"
                onClick={markResubmitted}
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
          <ApprovalPayloadRenderer
            type={approval.type}
            payload={payload}
            hidePrimaryTitle
            resolveAgentName={resolveAgentName}
          />
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
                    {/* A task is named by its identifier and title; one without an identifier shows its title only. */}
                    {issue.identifier && (
                      <span className="mr-2 font-mono text-muted-foreground">{issue.identifier}</span>
                    )}
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
                {deleteError && (
                  <p role="alert" className="mt-2 break-words text-sm text-destructive">{deleteError}</p>
                )}
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
            {(comments ?? []).map((comment: ApprovalComment) => {
              // The board's change request, kept by the server as a comment. It is
              // a note: plain text as typed, never Markdown. An agent's comment
              // that starts with the same words is an ordinary comment.
              const changeRequest = comment.authorAgentId
                ? null
                : approvalChangeRequestFromCommentBody(comment.body);
              return (
              <div key={comment.id} className="rounded-md border border-border/60 p-3">
                <div className="mb-1 flex items-center justify-between gap-3">
                  {comment.authorAgentId ? (
                    <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                      {agentIdentity(comment.authorAgentId)}
                    </Link>
                  ) : (
                    <Identity name="Board" size="sm" />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {new Date(comment.createdAt).toLocaleString()}
                  </span>
                </div>
                {changeRequest !== null ? (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Changes requested</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                      {changeRequest}
                    </p>
                  </div>
                ) : (
                  <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
                )}
              </div>
              );
            })}
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
          {commentError && (
            <p role="alert" className="break-words text-sm text-destructive">{commentError}</p>
          )}
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
