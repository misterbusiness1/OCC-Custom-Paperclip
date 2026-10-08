import { describe, expect, it } from "vitest";
import {
  APPROVAL_CHANGE_REQUEST_COMMENT_PREFIX,
  approvalChangeRequestCommentBody,
  approvalChangeRequestFromCommentBody,
} from "./constants.js";

describe("approval change request comment", () => {
  it("reads back the note the server stored, unchanged", () => {
    for (const note of ["Quote the date.", "1. Quote the **date**.\n2. Name the price.", "  indented\n\nlast  "]) {
      const body = approvalChangeRequestCommentBody(note);
      expect(body).toBe(`Changes requested:\n\n${note}`);
      expect(approvalChangeRequestFromCommentBody(body)).toBe(note);
    }
  });

  it("does not take a comment that only begins with the same words for a change request", () => {
    for (const body of [
      "Changes requested: none",
      "Changes requested: none, **ship it** - see [the doc](https://example.com)",
      "Changes requested:x",
      "Changes requested:\nx",
      "Changes requested: \n\nx",
      " Changes requested:\n\nx",
      "No changes requested.",
    ]) {
      expect(approvalChangeRequestFromCommentBody(body)).toBeNull();
    }
  });

  it("does not take the prefix without a note for a change request", () => {
    expect(approvalChangeRequestFromCommentBody(APPROVAL_CHANGE_REQUEST_COMMENT_PREFIX)).toBeNull();
    expect(approvalChangeRequestFromCommentBody(`${APPROVAL_CHANGE_REQUEST_COMMENT_PREFIX}\n\n`)).toBeNull();
    expect(approvalChangeRequestFromCommentBody(`${APPROVAL_CHANGE_REQUEST_COMMENT_PREFIX}\n\n  \n`)).toBeNull();
  });
});
