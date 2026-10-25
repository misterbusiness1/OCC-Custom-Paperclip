import type { IssueListFilters } from "../api/issues";

export const OPERATOR_TASK_VIEWS = [
  { value: "all", label: "All tasks" },
  { value: "assigned", label: "Assigned to me" },
  { value: "blocked", label: "Blocked" },
  { value: "review", label: "In review" },
  { value: "overdue", label: "Overdue follow-ups" },
] as const;
export type OperatorTaskView = (typeof OPERATOR_TASK_VIEWS)[number]["value"];
export function operatorTaskView(value: string | null): OperatorTaskView {
  return OPERATOR_TASK_VIEWS.some((view) => view.value === value) ? value as OperatorTaskView : "all";
}
export function operatorTaskViewFilters(view: OperatorTaskView): IssueListFilters {
  switch (view) {
    case "assigned": return { assigneeUserId: "me", status: "backlog,todo,in_progress,in_review,blocked" };
    case "blocked": return { status: "blocked" };
    case "review": return { status: "in_review" };
    case "overdue": return { overdueFollowUp: true };
    default: return {};
  }
}
