import { describe, expect, it } from "vitest";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

describe("DOMPurify dependency security qualification", () => {
  it.each(["parent", "sibling"])("neutralizes a hook-detached %s subtree in place", (target) => {
    const dom = new JSDOM("<div id='root'><section><span>trigger</span><img onerror='alert(1)'></section><aside><img onerror='alert(2)'></aside></div>");
    try {
      const purifier = createDOMPurify(dom.window as unknown as Parameters<typeof createDOMPurify>[0]);
      const root = dom.window.document.getElementById("root")!;
      const detached = root.querySelector(target === "parent" ? "section" : "aside")!;
      purifier.addHook("uponSanitizeElement", (node) => {
        if (node.nodeName === "SPAN") detached.remove();
      });
      purifier.sanitize(root, { IN_PLACE: true });
      expect(detached.querySelector("img")?.hasAttribute("onerror") ?? false).toBe(false);
    } finally {
      dom.window.close();
    }
  });
});
