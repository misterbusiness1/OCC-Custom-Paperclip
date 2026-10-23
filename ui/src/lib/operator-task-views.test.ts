import { describe, expect, it } from "vitest";
import { operatorTaskView, operatorTaskViewFilters } from "./operator-task-views";

describe("operator task navigation", () => {
  it("uses server filters so older matching tasks cannot disappear behind the first unfiltered page", () => {
    expect(operatorTaskViewFilters("assigned")).toEqual({ assigneeUserId: "me", status: "backlog,todo,in_progress,in_review,blocked" });
    expect(operatorTaskViewFilters("blocked")).toEqual({ status: "blocked" });
    expect(operatorTaskViewFilters("review")).toEqual({ status: "in_review" });
    expect(operatorTaskViewFilters("overdue")).toEqual({ overdueFollowUp: true });
  });
  it("treats unknown bookmarked views as all tasks", () => {
    for (const value of [null, "", "constructor", "other-company"]) {
      expect(operatorTaskView(value)).toBe("all");
      expect(operatorTaskViewFilters(operatorTaskView(value))).toEqual({});
    }
  });
});
