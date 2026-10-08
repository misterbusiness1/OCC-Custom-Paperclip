import {
  APPROVAL_LINKED_ISSUES_MAX_IDS,
  type Approval,
  type ApprovalComment,
  type ApprovalLinkedIssuesByApproval,
  type Issue,
} from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";
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
   * An approval without linked tasks has no key.
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
        )),
    );
    return Object.assign({}, ...results);
  },
};
