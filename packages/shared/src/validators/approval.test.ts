import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote)
      .toBe("Decision\nRevise.");
  });

  it("requires decision-ready fields for board approval requests", () => {
    expect(createApprovalSchema.safeParse({
      type: "request_board_approval",
      payload: { recommendedAction: "Approve", reasoning: "Bounded change", pros: [], risks: [] },
    }).success).toBe(false);

    expect(createApprovalSchema.safeParse({
      type: "request_board_approval",
      payload: {
        recommendedAction: "Approve the bounded change.",
        reasoning: "The reviewed evidence supports it.",
        pros: ["Completes the requested outcome."],
        risks: ["Requires rollback if the acceptance check fails."],
      },
    }).success).toBe(true);
  });

  it("keeps non-board approval payloads extensible", () => {
    expect(createApprovalSchema.safeParse({
      type: "hire_agent",
      payload: { name: "Support Agent" },
    }).success).toBe(true);
  });

  it("preserves verbatim original request text and validates provenance", () => {
    const text = "Line one\n\n<script>text only</script>\n**unchanged**";
    const parsed = createApprovalSchema.parse({
      type: "request_board_approval",
      payload: {
        recommendedAction: "Approve.",
        reasoning: "Evidence supports it.",
        pros: ["Completes the task."],
        risks: ["May need rollback."],
        originalRequest: {
          text,
          source: {
            kind: "external",
            sender: "Synthetic Sender",
            reference: "fixture-1",
          },
        },
      },
    });
    expect(parsed.payload.originalRequest).toMatchObject({ text, source: { kind: "external" } });
  });
});
