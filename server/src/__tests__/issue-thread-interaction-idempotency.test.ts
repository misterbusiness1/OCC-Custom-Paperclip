import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isIssueThreadInteractionIdempotencyConflict } from "../services/issue-thread-interactions.js";

const constraint = "issue_thread_interactions_company_issue_idempotency_uq";

describe("issue-thread interaction idempotency conflicts", () => {
  it.each(["constraint", "constraint_name"])("recognizes the driver's %s field", (field) => {
    expect(isIssueThreadInteractionIdempotencyConflict({ code: "23505", [field]: constraint })).toBe(true);
  });

  it("recognizes the exact unique violation inside Drizzle's query error", () => {
    const driverError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint_name: constraint,
    });
    const wrapped = new DrizzleQueryError("insert into issue_thread_interactions", [], driverError);
    expect(isIssueThreadInteractionIdempotencyConflict(wrapped)).toBe(true);
    expect(isIssueThreadInteractionIdempotencyConflict(new Error("transaction failed", { cause: wrapped }))).toBe(true);
  });

  it.each([
    null,
    undefined,
    "23505",
    { code: "23505", constraint: "some_other_unique_index" },
    { code: "23503", constraint },
    { constraint },
    { code: "23505", cause: { constraint } },
    { constraint, cause: { code: "23505" } },
    { message: `23505 ${constraint}` },
    { cause: { code: "23505", constraint: "some_other_unique_index" } },
  ])("does not recover unrelated or incomplete errors: %j", (error) => {
    expect(isIssueThreadInteractionIdempotencyConflict(error)).toBe(false);
  });

  it("terminates on cyclic causes and still recognizes a matching node", () => {
    const outer: { cause?: unknown } = {};
    const inner: { cause?: unknown; code?: string; constraint_name?: string } = { cause: outer };
    outer.cause = inner;
    expect(isIssueThreadInteractionIdempotencyConflict(outer)).toBe(false);
    inner.code = "23505";
    inner.constraint_name = constraint;
    expect(isIssueThreadInteractionIdempotencyConflict(outer)).toBe(true);
  });
});
