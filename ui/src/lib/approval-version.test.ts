import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import {
  approvalVersionConflict,
  approvalVersionOf,
  expectedUpdatedAtField,
  expectedVersionFields,
  isApprovalVersionConflict,
} from "./approval-version";

const MESSAGE = "This request changed after you opened it. Reload it and decide again.";

describe("approvalVersionConflict", () => {
  it("reads the conflict the server answers a stale decision with", () => {
    const error = new ApiError(MESSAGE, 409, {
      error: MESSAGE,
      code: "approval_version_conflict",
      details: {
        code: "approval_version_conflict",
        currentStatus: "revision_requested",
        currentUpdatedAt: "2026-10-07T12:40:00.000Z",
        expectedUpdatedAt: "2026-10-07T12:34:56.789Z",
      },
    });
    expect(approvalVersionConflict(error)).toEqual({
      currentStatus: "revision_requested",
      currentUpdatedAt: "2026-10-07T12:40:00.000Z",
    });
    expect(isApprovalVersionConflict(error)).toBe(true);
  });

  it("is null for any other error, also another 409", () => {
    for (const error of [
      new Error(MESSAGE),
      new ApiError("Conflict", 409, { error: "Conflict" }),
      new ApiError("Conflict", 409, { error: "Conflict", code: "issue_checked_out" }),
      new ApiError(MESSAGE, 422, { code: "approval_version_conflict" }),
      new ApiError("Conflict", 409, null),
      null,
      undefined,
      "approval_version_conflict",
    ]) {
      expect(approvalVersionConflict(error)).toBeNull();
      expect(isApprovalVersionConflict(error)).toBe(false);
    }
  });

  it("gives null fields when the answer carries no details", () => {
    expect(approvalVersionConflict(new ApiError(MESSAGE, 409, { code: "approval_version_conflict" }))).toEqual({
      currentStatus: null,
      currentUpdatedAt: null,
    });
  });
});

describe("expectedUpdatedAtField", () => {
  it("sends back the ISO string the API gave, from a string or a Date", () => {
    expect(expectedUpdatedAtField("2026-10-07T12:34:56.789Z")).toBe("2026-10-07T12:34:56.789Z");
    expect(expectedUpdatedAtField(new Date("2026-10-07T12:34:56.789Z"))).toBe("2026-10-07T12:34:56.789Z");
  });

  it("leaves the field out for no version or one that is not a time", () => {
    expect(expectedUpdatedAtField(undefined)).toBeUndefined();
    expect(expectedUpdatedAtField(null)).toBeUndefined();
    expect(expectedUpdatedAtField("not a time")).toBeUndefined();
  });
});

describe("the version a decision sends", () => {
  const at = new Date("2026-10-20T10:00:00.000Z");

  it("is the time alone for an approval from a server without content versions", () => {
    expect(approvalVersionOf({ updatedAt: at, status: "pending" })).toBe(at);
    expect(expectedVersionFields(approvalVersionOf({ updatedAt: at, status: "pending" }))).toEqual({
      expectedUpdatedAt: "2026-10-20T10:00:00.000Z",
    });
  });

  it("carries the content version and status when the server gave one", () => {
    const version = approvalVersionOf({ updatedAt: at, status: "revision_requested", contentVersion: "d".repeat(32) });
    expect(expectedUpdatedAtField(version)).toBe("2026-10-20T10:00:00.000Z");
    expect(expectedVersionFields(version)).toEqual({
      expectedUpdatedAt: "2026-10-20T10:00:00.000Z",
      expectedContentVersion: "d".repeat(32),
      expectedStatus: "revision_requested",
    });
  });

  it("sends nothing for a version without a usable time", () => {
    expect(expectedVersionFields({ updatedAt: "not a time" as never, status: "pending", contentVersion: "d".repeat(32) })).toEqual({});
    expect(expectedVersionFields(undefined)).toEqual({});
  });
});
