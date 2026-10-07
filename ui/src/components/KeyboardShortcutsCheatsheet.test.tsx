// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyboardShortcutsCheatsheetContent } from "./KeyboardShortcutsCheatsheet";

describe("KeyboardShortcutsCheatsheet", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("lists the Approvals page shortcuts, with the undo that follows an approval", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent />);
    });

    const section = [...container.querySelectorAll("h3")].find((node) => node.textContent === "Approvals")
      ?.parentElement;
    expect(section).toBeDefined();
    const entries = [...section!.querySelectorAll(":scope > div > div")].map((row) => [
      row.querySelector("span")!.textContent,
      [...row.querySelectorAll("kbd")].map((key) => key.textContent).join("+"),
    ]);
    expect(entries).toEqual([
      ["Next request (opens it and moves focus into it)", "j"],
      ["Previous request (opens it and moves focus into it)", "k"],
      // The decision keys are handled by the open request, so they need focus inside it; the list says so.
      ["Approve the open request, with focus inside it", "Shift+A"],
      ["Request changes to the open request, with focus inside it", "Shift+C"],
      ["Reject the open request, with focus inside it (asks to confirm)", "Shift+X"],
      ["Undo the last approval (within 5 seconds)", "Shift+Z"],
    ]);
    // A chord reads "Shift + A", not "Shift then A".
    expect(section!.textContent).not.toContain("then");

    flushSync(() => {
      root.unmount();
    });
  });

  it("does not advertise the retired sidebar collapse shortcut", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(<KeyboardShortcutsCheatsheetContent />);
    });

    const row = [...container.querySelectorAll("span")].find(
      (node) => node.textContent?.trim() === "Collapse or expand sidebar",
    )?.parentElement;
    expect(row).toBeUndefined();

    flushSync(() => {
      root.unmount();
    });
  });
});
