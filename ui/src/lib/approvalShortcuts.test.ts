import { describe, expect, it } from "vitest";
import { resolveApprovalShortcut, type ApprovalShortcutContext } from "./approvalShortcuts";

const actionablePending: ApprovalShortcutContext = {
  isActionable: true,
  isBudgetApproval: false,
  status: "pending",
  typingInField: false,
};

describe("resolveApprovalShortcut", () => {
  it("maps a/r/e to approve/reject/request_revision on an actionable pending approval", () => {
    expect(resolveApprovalShortcut("a", actionablePending)).toBe("approve");
    expect(resolveApprovalShortcut("r", actionablePending)).toBe("reject");
    expect(resolveApprovalShortcut("e", actionablePending)).toBe("request_revision");
  });

  it("is case-insensitive", () => {
    expect(resolveApprovalShortcut("A", actionablePending)).toBe("approve");
  });

  it("always allows toggling the raw payload, even when not actionable", () => {
    expect(
      resolveApprovalShortcut("v", { ...actionablePending, isActionable: false, status: "approved" }),
    ).toBe("toggle_raw");
  });

  it("suppresses every shortcut while typing in a field", () => {
    expect(resolveApprovalShortcut("a", { ...actionablePending, typingInField: true })).toBeNull();
    expect(resolveApprovalShortcut("v", { ...actionablePending, typingInField: true })).toBeNull();
  });

  it("does not offer approve/reject for budget overrides", () => {
    const budget = { ...actionablePending, isBudgetApproval: true };
    expect(resolveApprovalShortcut("a", budget)).toBeNull();
    expect(resolveApprovalShortcut("r", budget)).toBeNull();
  });

  it("only offers request_revision from pending, not revision_requested", () => {
    const revisionRequested = { ...actionablePending, status: "revision_requested" };
    expect(resolveApprovalShortcut("e", revisionRequested)).toBeNull();
    // approve/reject remain available while revision_requested is still actionable
    expect(resolveApprovalShortcut("a", revisionRequested)).toBe("approve");
  });

  it("returns null for unmapped keys", () => {
    expect(resolveApprovalShortcut("z", actionablePending)).toBeNull();
    expect(resolveApprovalShortcut("Enter", actionablePending)).toBeNull();
  });
});
