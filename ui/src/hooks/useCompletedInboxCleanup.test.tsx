// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completedInboxCleanupKey, useCompletedInboxCleanup } from "./useCompletedInboxCleanup";

const api = vi.hoisted(() => ({ archiveCompletedFromInbox: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: api }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const completedAt = "2026-10-22T12:00:00.000Z";
function issue(id: string, status = "done", companyId = "company-a"): Issue {
  return { id, status, companyId, completedAt } as unknown as Issue;
}

describe("completed inbox cleanup at its query/API seam", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  let companyId: string | null;
  let userId: string | null;
  let issues: Issue[];
  let updatedAt: number;
  let observed: ReturnType<typeof useCompletedInboxCleanup>;
  function Harness() {
    observed = useCompletedInboxCleanup({ companyId, userId, issues, updatedAt });
    return null;
  }
  async function render() {
    await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
  }
  beforeEach(() => {
    localStorage.clear();
    api.archiveCompletedFromInbox.mockReset().mockResolvedValue({ archived: true });
    companyId = "company-a";
    userId = "user-a";
    issues = [issue("done")];
    updatedAt = 1;
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });

  it("does nothing by default and scopes persisted opt-in by user and company", async () => {
    await render();
    expect(observed.enabled).toBe(false);
    expect(api.archiveCompletedFromInbox).not.toHaveBeenCalled();
    await act(async () => observed.setEnabled(true));
    expect(localStorage.getItem(completedInboxCleanupKey("company-a", "user-a"))).toBe("true");
    expect(api.archiveCompletedFromInbox).toHaveBeenCalledWith("done", completedAt);
    userId = "other-user";
    await render();
    expect(observed.enabled).toBe(false);
    companyId = "other-company";
    userId = "user-a";
    await render();
    expect(observed.enabled).toBe(false);
  });

  it("archives only done notifications from this user's current company, at most ten per refresh", async () => {
    issues = [issue("active", "in_progress"), issue("blocked", "blocked"), issue("cancelled", "cancelled"),
      issue("foreign", "done", "other-company"), ...Array.from({ length: 12 }, (_, i) => issue(`done-${i}`))];
    localStorage.setItem(completedInboxCleanupKey(companyId!, userId!), "true");
    await render();
    expect(api.archiveCompletedFromInbox).toHaveBeenCalledTimes(10);
    updatedAt++;
    await render();
    expect(api.archiveCompletedFromInbox).toHaveBeenCalledTimes(12);
  });

  it("keeps a resurfaced completed task visible instead of repeatedly archiving new activity", async () => {
    localStorage.setItem(completedInboxCleanupKey(companyId!, userId!), "true");
    api.archiveCompletedFromInbox.mockResolvedValue({ archived: false, reason: "already_archived" });
    await render();
    issues = [issue("done")];
    updatedAt++;
    await render();
    expect(api.archiveCompletedFromInbox).toHaveBeenCalledTimes(1);
    issues = [{ ...issue("done"), completedAt: new Date("2026-10-23T12:00:00Z") }];
    updatedAt++;
    await render();
    expect(api.archiveCompletedFromInbox).toHaveBeenCalledTimes(2);
  });

  it("stops queued requests when opt-in is disabled or the task reopens during an in-flight batch", async () => {
    let finish!: (value: { archived: boolean }) => void;
    api.archiveCompletedFromInbox.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    issues = [issue("first"), issue("second")];
    localStorage.setItem(completedInboxCleanupKey(companyId!, userId!), "true");
    await render();
    issues = [issue("first"), issue("second", "in_progress")];
    updatedAt++;
    await render();
    await act(async () => { finish({ archived: true }); });
    expect(api.archiveCompletedFromInbox).toHaveBeenCalledTimes(1);
    await act(async () => observed.setEnabled(false));
    issues = [issue("third")];
    updatedAt++;
    await render();
    expect(api.archiveCompletedFromInbox).toHaveBeenCalledTimes(1);
  });

  it("stops queued work when Inbox closes during an in-flight batch", async () => {
    let finish!: (value: { archived: boolean }) => void;
    api.archiveCompletedFromInbox.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    issues = [issue("first"), issue("second")];
    localStorage.setItem(completedInboxCleanupKey(companyId!, userId!), "true");
    await render();
    await act(async () => root.render(<></>));
    await act(async () => { finish({ archived: true }); });
    expect(api.archiveCompletedFromInbox).toHaveBeenCalledTimes(1);
  });

  it("keeps cleanup off and shows an error when browser preference storage cannot be written", async () => {
    await render();
    const save = vi.spyOn(Object.getPrototypeOf(window.localStorage), "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
    try {
      await act(async () => observed.setEnabled(true));
      expect(observed.enabled).toBe(false);
      expect(observed.error).toContain("Could not save automatic inbox cleanup");
      expect(api.archiveCompletedFromInbox).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });

  it("surfaces errors without hiding a failed item and retries only on a later refresh", async () => {
    localStorage.setItem(completedInboxCleanupKey(companyId!, userId!), "true");
    api.archiveCompletedFromInbox.mockRejectedValueOnce(new Error("network unavailable"));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await render();
    expect(observed.error).toBe("network unavailable");
    expect(api.archiveCompletedFromInbox).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    updatedAt++;
    await render();
    expect(api.archiveCompletedFromInbox).toHaveBeenCalledTimes(2);
    expect(observed.error).toBeNull();
  });
});
