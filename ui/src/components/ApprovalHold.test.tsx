// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVE_AFTER_PAUSE_LIMIT_MS, type HeldApproval, useApprovalHolds } from "./ApprovalHold";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A pause ended by its limit leaves the reader a moment before the approval goes out.
describe("useApprovalHolds: a pause ended by the pause limit", () => {
  const PAUSE_LIMIT_MS = 10_000;
  let root: Root;
  let holds!: ReturnType<typeof useApprovalHolds>;
  const send = vi.fn<(held: HeldApproval) => void>();
  const onPauseLimit = vi.fn<(held: HeldApproval) => void>();

  function Harness({ holdMs }: { holdMs: number }) {
    holds = useApprovalHolds({ send, holdMs, pauseLimitMs: PAUSE_LIMIT_MS, onPauseLimit });
    return null;
  }
  const mount = (holdMs: number) => act(() => root.render(<Harness holdMs={holdMs} />));
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  /** Holds a request and pauses it when `left` milliseconds of the hold remain. */
  const holdAndPauseWith = (holdMs: number, left: number) => {
    mount(holdMs);
    act(() => {
      holds.hold({ id: "request", subject: "Request", companyId: "company-1" });
    });
    advance(holdMs - left);
    act(() => holds.pause("request", "pointer"));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset();
    onPauseLimit.mockReset();
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("runs for the minimum when less than that was left, and is sent once", () => {
    holdAndPauseWith(5_000, 50);
    advance(PAUSE_LIMIT_MS);
    expect(onPauseLimit).toHaveBeenCalledTimes(1);
    expect(onPauseLimit.mock.calls[0][0].sendAt - Date.now()).toBe(APPROVE_AFTER_PAUSE_LIMIT_MS);
    advance(APPROVE_AFTER_PAUSE_LIMIT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    advance(1);
    expect(send).toHaveBeenCalledTimes(1);
    advance(PAUSE_LIMIT_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the time it had when that was more", () => {
    holdAndPauseWith(5_000, 4_000);
    advance(PAUSE_LIMIT_MS);
    expect(onPauseLimit.mock.calls[0][0].sendAt - Date.now()).toBe(4_000);
  });

  it("never runs for longer than the hold itself", () => {
    holdAndPauseWith(1_000, 50);
    advance(PAUSE_LIMIT_MS);
    expect(onPauseLimit.mock.calls[0][0].sendAt - Date.now()).toBe(1_000);
    advance(999);
    expect(send).not.toHaveBeenCalled();
    advance(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is still undone, and still sent at once by a flush, in that time", () => {
    holdAndPauseWith(5_000, 50);
    advance(PAUSE_LIMIT_MS + 1_000);
    let undone: HeldApproval | null = null;
    act(() => {
      undone = holds.undo("request");
    });
    expect(undone).toMatchObject({ id: "request" });
    advance(PAUSE_LIMIT_MS);
    expect(send).not.toHaveBeenCalled();

    act(() => {
      holds.hold({ id: "request", subject: "Request", companyId: "company-1" });
    });
    advance(4_950);
    act(() => holds.pause("request", "focus"));
    advance(PAUSE_LIMIT_MS + 1_000);
    act(() => holds.flush());
    expect(send).toHaveBeenCalledTimes(1);
    advance(PAUSE_LIMIT_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
