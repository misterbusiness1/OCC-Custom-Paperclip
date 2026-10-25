import { ISSUE_STATUSES, type Issue, type IssueStatus } from "@paperclipai/shared";
import type { IssueListFilters } from "../api/issues";

/** Saved controls may narrow the collection's scope, never replace it. */
export function issueBoardStatuses(status: string | undefined, savedStatuses: readonly string[]): IssueStatus[] {
  const allowed = status === undefined ? null : status.split(",").map((value) => value.trim());
  return ISSUE_STATUSES.filter((value) =>
    (!allowed || allowed.includes(value)) && (!savedStatuses.length || savedStatuses.includes(value)),
  );
}

/** Also protect list/loading rows supplied by a parent while query keys change. */
export function issueMatchesCollectionScope(
  issue: Issue,
  companyId: string | null,
  filters: IssueListFilters | undefined,
  currentUserId: string | null,
): boolean {
  if (issue.companyId !== companyId) return false;
  if (filters?.status !== undefined && !filters.status.split(",").map((value) => value.trim()).includes(issue.status)) return false;
  const assignee = filters?.assigneeUserId === "me" ? currentUserId : filters?.assigneeUserId;
  if (filters?.assigneeUserId && (!assignee || issue.assigneeUserId !== assignee)) return false;
  if (filters?.assigneeAgentId && issue.assigneeAgentId !== filters.assigneeAgentId) return false;
  return true;
}
