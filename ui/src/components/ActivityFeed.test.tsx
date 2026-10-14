// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ActivityEvent } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "./ActivityFeed";
import { TooltipProvider } from "./ui/tooltip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { events } = vi.hoisted(() => ({ events: [] as ActivityEvent[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "activity" ? events : [], dataUpdatedAt: 0,
  }),
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/polling", () => ({ useVisibilityRefetchInterval: () => false }));
vi.mock("../hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({ enabled: true, refetchInterval: false }),
  usePublishSharedQueryData: () => undefined,
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, issueQuicklookSide: _, to, ...props }: React.ComponentProps<"a"> & { issueQuicklookSide?: string; to: string }) => (
    <a {...props} href={to}>{children}</a>
  ),
}));

describe("ActivityFeed retirement audit", () => {
  it("shows a linked retirement card by default while keeping the secondary wake audit hidden", () => {
    const base: ActivityEvent = {
      id: "retirement", companyId: "company-1", actorType: "user", actorId: "board",
      action: "approval.retired_closed_request", entityType: "approval", entityId: "approval-1",
      agentId: null, runId: null, details: { type: "request_board_approval", executionSuppressed: true },
      createdAt: new Date("2026-10-14T12:00:00Z"),
    };
    events.splice(0, events.length, base, { ...base, id: "wake-skipped", action: "approval.requester_wakeup_skipped" });
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<TooltipProvider><ActivityFeed /></TooltipProvider>));
      const cards = container.querySelectorAll('[data-fc="card"]');
      expect(cards).toHaveLength(1);
      expect(cards[0]?.querySelector('[data-fc="verb"]')?.textContent).toBe("retired");
      expect(container.querySelector('a[href="/approvals/approval-1"]')).not.toBeNull();
      expect(container.textContent).not.toContain("requester wakeup skipped");
    } finally {
      act(() => root.unmount()); container.remove();
    }
  });
});
