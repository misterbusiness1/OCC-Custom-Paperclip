// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyShellRoute,
  getCompanyPathSegments,
  isApprovalsRoute,
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
