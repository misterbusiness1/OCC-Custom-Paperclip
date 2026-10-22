// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalRevocation } from "./ApprovalRevocation";
const revoke = vi.hoisted(() => vi.fn());
vi.mock("../api/approvals", () => ({ approvalsApi: { revoke } }));
let container: HTMLDivElement, root: Root, client: QueryClient;
const approval = { id: "approval", type: "request_board_approval", status: "approved", updatedAt: new Date("2026-10-22T00:00:00Z") } as Approval;
beforeEach(() => { revoke.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
async function render(value = approval, onResolved = vi.fn()) {
  await act(async () => root.render(<QueryClientProvider client={client}><ApprovalRevocation approval={value} onResolved={onResolved} /></QueryClientProvider>));
  return onResolved;
}
async function reason(text: string) {
  const field = container.querySelector("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); });
}
it("requires an explicit reason and sends the displayed version", async () => {
  revoke.mockResolvedValue({ ...approval, status: "cancelled" }); const done = await render();
  const button = container.querySelector("button")!; expect(button.disabled).toBe(true);
  await reason("Withdraw superseded copy"); expect(button.disabled).toBe(false);
  await act(async () => button.click());
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("approval", { decisionNote: "Withdraw superseded copy", expectedUpdatedAt: "2026-10-22T00:00:00.000Z" }));
  await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
});
it("shows execution conflicts and refreshes without claiming revocation", async () => {
  revoke.mockRejectedValue(new Error("Execution has started; reconcile its outcome")); const done = await render(); await reason("Withdraw");
  await act(async () => container.querySelector("button")!.click());
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Execution has started"));
  expect(done).toHaveBeenCalledTimes(1);
});
it("does not offer revocation for pending or hire approvals", async () => {
  await render({ ...approval, status: "pending" }); expect(container.textContent).toBe("");
  await render({ ...approval, type: "hire_agent" }); expect(container.textContent).toBe("");
});
