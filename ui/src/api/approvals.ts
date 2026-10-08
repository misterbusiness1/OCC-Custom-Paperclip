import {
  APPROVAL_LINKED_ISSUES_MAX_IDS,
  type Approval,
  type ApprovalComment,
  type ApprovalLinkedIssue,
  type ApprovalLinkedIssuesByApproval,
  type Issue,
} from "@paperclipai/shared";
import { ApiError, api, type RequestOptions } from "./client";
import { expectedUpdatedAtField, type ApprovalVersion } from "../lib/approval-version";

/**
 * `expectedUpdatedAt` is the `updatedAt` of the approval the reader decided on. The server then
 * answers 409 when the approval has changed since. Left out, the server does not check.
 */
export type ApprovalDecisionOptions = { expectedUpdatedAt?: ApprovalVersion | null };

/** The body of a decision. The version is in it only when one was given. */
function decisionBody(decisionNote: string | undefined, options?: ApprovalDecisionOptions) {
  const expectedUpdatedAt = expectedUpdatedAtField(options?.expectedUpdatedAt);
  return expectedUpdatedAt === undefined ? { decisionNote } : { decisionNote, expectedUpdatedAt };
}

/**
 * The linked tasks of a batch of approvals, read one approval at a time. Only for a server that
 * does not have the batch route yet. One approval that cannot be read does not blank the others;
 * when none can be read, `batchError` (the batch route's own 404) is thrown.
 */
async function listLinkedIssuesPerApproval(
  approvalIds: string[],
  batchError: unknown,
): Promise<ApprovalLinkedIssuesByApproval> {
  const reads = await Promise.allSettled(
    approvalIds.map((id) => api.get<Issue[]>(`/approvals/${encodeURIComponent(id)}/issues`)),
  );
  if (reads.every((read) => read.status === "rejected")) throw batchError;
  const byApproval: ApprovalLinkedIssuesByApproval = {};
  reads.forEach((read, index) => {
    if (read.status !== "fulfilled" || read.value.length === 0) return;
    byApproval[approvalIds[index]!] = read.value.map((issue): ApprovalLinkedIssue => ({
      id: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
      status: issue.status,
    }));
  });
  return byApproval;
}

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  /** `options.keepalive` lets the approval reach the server even when the page is closed right after. */
  approve: (
    id: string,
    decisionNote?: string,
    options?: Pick<RequestOptions, "keepalive"> & ApprovalDecisionOptions,
  ) =>
    options?.keepalive !== undefined
      ? api.post<Approval>(`/approvals/${id}/approve`, decisionBody(decisionNote, options), {
          keepalive: options.keepalive,
        })
      : api.post<Approval>(`/approvals/${id}/approve`, decisionBody(decisionNote, options)),
  reject: (id: string, decisionNote?: string, options?: ApprovalDecisionOptions) =>
    api.post<Approval>(`/approvals/${id}/reject`, decisionBody(decisionNote, options)),
  requestRevision: (id: string, decisionNote?: string, options?: ApprovalDecisionOptions) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, decisionBody(decisionNote, options)),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
  /**
   * The linked tasks of several approvals of one company, as slim rows keyed by approval id. One
   * request for up to the server's cap of ids; a longer list is read in as few requests as it takes.
   * An approval without linked tasks has no key. A server without this route (an older one, which
   * answers 404) is read per approval with `/approvals/:id/issues` instead; any other error is thrown.
   */
  listLinkedIssues: async (companyId: string, approvalIds: string[]): Promise<ApprovalLinkedIssuesByApproval> => {
    const ids = Array.from(new Set(approvalIds.filter((id) => id.length > 0)));
    const batches: string[][] = [];
    for (let start = 0; start < ids.length; start += APPROVAL_LINKED_ISSUES_MAX_IDS) {
      batches.push(ids.slice(start, start + APPROVAL_LINKED_ISSUES_MAX_IDS));
    }
    const results = await Promise.all(
      batches.map((batch) =>
        api.get<ApprovalLinkedIssuesByApproval>(
          `/companies/${companyId}/approvals/linked-issues?ids=${batch.map(encodeURIComponent).join(",")}`,
        ).catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) return listLinkedIssuesPerApproval(batch, error);
          throw error;
        })),
    );
    return Object.assign({}, ...results);
  },
};
