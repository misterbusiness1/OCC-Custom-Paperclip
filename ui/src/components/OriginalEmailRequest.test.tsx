// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OriginalRequestBlock } from "./ApprovalPayload";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("original email disclosure", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const payload = {
    body: "Proposed outgoing reply only.",
    recipient: "synthetic@example.test",
    originalRequest: {
      text: "Original incoming question.\n<script>alert('untrusted')</script>",
      source: { kind: "external", sender: "synthetic@example.test", snapshotOrigin: "requester" },
    },
  };
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  it("keeps the incoming message in a collapsed, labelled disclosure as literal selectable text", () => {
    act(() => root.render(<OriginalRequestBlock payload={payload} compact />));
    const disclosure = container.querySelector("details")!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector("summary")?.textContent).toBe("Original request");
    expect(disclosure.querySelector("pre")?.textContent).toBe(payload.originalRequest.text);
    expect(disclosure.querySelector("script")).toBeNull();
    expect(disclosure.textContent).toContain("Quoted by the requesting agent, not verified");
    expect(disclosure.textContent).not.toContain(payload.body);
  });
  it("collapses a previously opened message when its retained source changes", () => {
    act(() => root.render(<OriginalRequestBlock payload={payload} />));
    container.querySelector("details")!.open = true;
    const updated = { ...payload, originalRequest: { ...payload.originalRequest, text: "New incoming question" } };
    act(() => root.render(<OriginalRequestBlock payload={updated} />));
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("pre")?.textContent).toBe(updated.originalRequest.text);
  });
  it("shows an explicit missing-source state without presenting the outgoing draft as incoming", () => {
    act(() => root.render(<OriginalRequestBlock payload={{ body: payload.body, recipient: payload.recipient }} />));
    expect(container.textContent).toContain("No original request was attached");
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain(payload.body);
  });
});
