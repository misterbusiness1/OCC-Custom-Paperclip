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
  const longPayload = {
    ...payload,
    originalRequest: {
      ...payload.originalRequest,
      text: Array.from({ length: 10 }, (_, index) => `Incoming line ${index + 1}.`).join("\n") + "\n<script>alert('untrusted')</script>",
    },
  };
  const toggle = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((button) => button.textContent === label);
  it("previews the incoming message under its own label as literal selectable text, with Show more", () => {
    act(() => root.render(<OriginalRequestBlock payload={longPayload} compact />));
    const block = container.querySelector<HTMLElement>("[data-approval-original-request]")!;
    expect(block.textContent).toContain("Original email");
    expect(block.querySelector("pre")?.textContent).toBe(longPayload.originalRequest.text);
    expect(block.querySelector("pre")?.className).toMatch(/line-clamp-6/);
    expect(block.querySelector("script")).toBeNull();
    expect(block.textContent).toContain("Quoted by the requesting agent, not verified");
    expect(block.textContent).not.toContain(payload.body);
    expect(toggle("Show more")?.getAttribute("aria-label")).toBe("Show more: Original email from synthetic@example.test");
    expect(block.querySelector("div.border-dashed")).not.toBeNull();
  });
  it("collapses a previously expanded message when its retained source changes", () => {
    act(() => root.render(<OriginalRequestBlock payload={longPayload} compact />));
    act(() => toggle("Show more")!.click());
    expect(container.querySelector("pre")?.className).not.toMatch(/line-clamp/);
    const updated = {
      ...longPayload,
      originalRequest: { ...longPayload.originalRequest, text: `${longPayload.originalRequest.text}\nRevised.` },
    };
    act(() => root.render(<OriginalRequestBlock payload={updated} compact />));
    expect(container.querySelector("pre")?.className).toMatch(/line-clamp-6/);
    expect(container.querySelector("pre")?.textContent).toBe(updated.originalRequest.text);
    expect(toggle("Show more")).toBeDefined();
  });
  it("shows a whole message on the full page, with no clamp and no button", () => {
    act(() => root.render(<OriginalRequestBlock payload={longPayload} />));
    expect(container.querySelector("pre")?.className).not.toMatch(/line-clamp|max-h-|overflow-/);
    expect(container.querySelector("button")).toBeNull();
  });
  it("shows an explicit missing-source state without presenting the outgoing draft as incoming", () => {
    act(() => root.render(<OriginalRequestBlock payload={{ body: payload.body, recipient: payload.recipient }} />));
    expect(container.textContent).toContain("did not attach the email this reply answers");
    expect(container.textContent).not.toContain("Open the linked task");
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain(payload.body);
  });
});
