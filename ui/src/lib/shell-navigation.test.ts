// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  approvalQueueReturnTarget,
  approvalsNavTarget,
  classifyShellRoute,
  getCompanyPathSegments,
  isApprovalsRoute,
  isBareApprovalsPath,
  readContextualSidebarOrigin,
  rememberContextualSidebarOrigin,
} from "./shell-navigation";

describe("shell navigation", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("recognises the Approvals pages, with a company prefix and without", () => {
    for (const pathname of ["/PAP/approvals", "/PAP/approvals/pending", "/PAP/approvals/all", "/PAP/approvals/9b2d7c1e", "/pap/Approvals/all"]) {
      expect(isApprovalsRoute(pathname, "PAP")).toBe(true);
    }
    for (const pathname of ["/approvals/pending", "/approvals/9b2d7c1e"]) {
      expect(isApprovalsRoute(pathname, undefined)).toBe(true);
    }
    for (const pathname of ["/PAP/inbox", "/PAP/decisions", "/PAP/issues/approvals", "/PAP/approvals-archive", "/PAP", "/"]) {
      expect(isApprovalsRoute(pathname, "PAP")).toBe(false);
    }
    // A company whose prefix happens to be the word is not the Approvals page.
    expect(isApprovalsRoute("/APPROVALS/dashboard", "APPROVALS")).toBe(false);
    expect(isApprovalsRoute("/APPROVALS/approvals/all", "APPROVALS")).toBe(true);
  });

  it("points the sidebar's Approvals item at To decide itself on To decide, and at the short address elsewhere", () => {
    expect(approvalsNavTarget({ pathname: "/PAP/approvals/pending" })).toBe("/approvals/pending");
    expect(approvalsNavTarget({ pathname: "/approvals/pending", search: "", hash: "" })).toBe("/approvals/pending");
    for (const pathname of [
      "/PAP/approvals/all",
      "/PAP/approvals",
      "/PAP/approvals/9b2d7c1e",
      "/PAP/approvals/pending-review",
      "/PAP/inbox",
      "/PAP/issues/pending",
      "/",
    ]) {
      expect(approvalsNavTarget({ pathname })).toBe("/approvals");
      // The filter of another page is not carried to the queue.
      expect(approvalsNavTarget({ pathname, search: "?kind=hire_agent", hash: "#approval-a1" })).toBe("/approvals");
    }
  });

  it("points the sidebar's Approvals item at the very address the reader is on while on To decide", () => {
    // With the kind filter, the sort and the linked card: a press there then changes nothing.
    expect(
      approvalsNavTarget({ pathname: "/PAP/approvals/pending", search: "?kind=email_reply&sort=newest", hash: "" }),
    ).toBe("/approvals/pending?kind=email_reply&sort=newest");
    expect(
      approvalsNavTarget({ pathname: "/PAP/approvals/pending", search: "?kind=hire_agent", hash: "#approval-a1" }),
    ).toBe("/approvals/pending?kind=hire_agent#approval-a1");
    expect(approvalsNavTarget({ pathname: "/approvals/pending", search: "", hash: "#approval-a1" })).toBe(
      "/approvals/pending#approval-a1",
    );
  });

  it("leads back from an approval's page to the queue view it was opened from, at that approval", () => {
    expect(approvalQueueReturnTarget({ queue: "/PAP/approvals/pending?kind=email_reply&sort=newest" }, "a1")).toBe(
      "/PAP/approvals/pending?kind=email_reply&sort=newest#approval-a1",
    );
    expect(approvalQueueReturnTarget({ queue: "/PAP/approvals/all?sort=oldest" }, "a1")).toBe(
      "/PAP/approvals/all?sort=oldest#approval-a1",
    );
    expect(approvalQueueReturnTarget({ queue: "/approvals/all" }, "a1")).toBe("/approvals/all#approval-a1");
    expect(approvalQueueReturnTarget({ queue: "/PAP/approvals" }, "a 1")).toBe("/PAP/approvals#approval-a%201");
  });

  it("leads back to To decide when the page was not opened from the queue", () => {
    for (const state of [
      null,
      undefined,
      "/PAP/approvals/all",
      { paperclipSidebarScrollReset: true },
      { queue: 7 },
      // Not a queue address: another page, another site, an approval's own page, a target of its own.
      { queue: "/PAP/inbox" },
      { queue: "https://example.test/approvals/pending" },
      { queue: "//example.test/approvals/pending" },
      { queue: "/PAP/approvals/9b2d7c1e" },
      { queue: "/PAP/approvals/pending#approval-other" },
      { queue: "/PAP/extra/approvals/pending" },
    ]) {
      expect(approvalQueueReturnTarget(state, "a1")).toBe("/approvals/pending#approval-a1");
    }
  });

  it("recognises the short Approvals address, which shows the queue and is then corrected", () => {
    for (const pathname of ["/approvals", "/PAP/approvals", "/PAP/approvals/", "/pap/Approvals"]) {
      expect(isBareApprovalsPath(pathname)).toBe(true);
    }
    for (const pathname of ["/PAP/approvals/pending", "/PAP/approvals/all", "/PAP/approvals/9b2d7c1e", "/PAP/approvals-archive", "/PAP/inbox", "/"]) {
      expect(isBareApprovalsPath(pathname)).toBe(false);
    }
  });

  it("classifies task detail independently from list routes", () => {
    expect(classifyShellRoute("/PAP/issues", "PAP").isTaskDetail).toBe(false);
    expect(classifyShellRoute("/PAP/issues/task-1", "PAP").isTaskDetail).toBe(true);
  });

  it("classifies the built-in contextual surfaces", () => {
    expect(classifyShellRoute("/PAP/company/settings/secrets", "PAP").builtInContextualSurface).toBe("settings");
    expect(classifyShellRoute("/PAP/company/export", "PAP").builtInContextualSurface).toBe("settings");
    expect(classifyShellRoute("/PAP/apps/connections", "PAP").builtInContextualSurface).toBe("apps");
    expect(classifyShellRoute("/PAP/tools/runtime", "PAP").builtInContextualSurface).toBe("apps");
    expect(classifyShellRoute("/PAP/agents/agent-1/instructions", "PAP").builtInContextualSurface).toBe("agent");
    expect(classifyShellRoute("/PAP/agents/agent-1/runs/run-1", "PAP").builtInContextualSurface).toBe("agent");
    expect(classifyShellRoute("/PAP/routines/routine-1/overview", "PAP").builtInContextualSurface).toBe("routine");
    expect(classifyShellRoute("/PAP/skills", "PAP").builtInContextualSurface).toBe("skills");
    expect(classifyShellRoute("/PAP/skills/studio/skill-1", "PAP").builtInContextualSurface).toBe("skills");
  });

  it("keeps Agent and Routine collection routes in the global shell", () => {
    for (const pathname of [
      "/PAP/agents",
      "/PAP/agents/all",
      "/PAP/agents/active",
      "/PAP/agents/paused",
      "/PAP/agents/error",
      "/PAP/agents/builtin",
      "/PAP/agents/new",
      "/PAP/routines",
    ]) {
      expect(classifyShellRoute(pathname, "PAP").builtInContextualSurface).toBeNull();
    }
  });

  it("rejects a different company prefix", () => {
    expect(getCompanyPathSegments("/OTHER/issues/task-1", "PAP")).toEqual([]);
  });

  it("remembers only safe same-company origins", () => {
    rememberContextualSidebarOrigin({
      surface: "settings",
      companyPrefix: "PAP",
      previousPathname: "/PAP/issues/task-1",
    });
    expect(readContextualSidebarOrigin({
      surface: "settings",
      companyPrefix: "PAP",
      fallbackTo: "/dashboard",
    })).toBe("/PAP/issues/task-1");

    rememberContextualSidebarOrigin({
      surface: "settings",
      companyPrefix: "PAP",
      previousPathname: "/OTHER/dashboard",
    });
    expect(readContextualSidebarOrigin({
      surface: "settings",
      companyPrefix: "PAP",
      fallbackTo: "/dashboard",
    })).toBe("/PAP/issues/task-1");
  });

  it("falls back when storage contains an unsafe path", () => {
    window.sessionStorage.setItem(
      "paperclip.contextualSidebar.origin:PAP:settings",
      "/OTHER/company/settings",
    );
    expect(readContextualSidebarOrigin({
      surface: "settings",
      companyPrefix: "PAP",
      fallbackTo: "/dashboard",
    })).toBe("/dashboard");
  });
});
