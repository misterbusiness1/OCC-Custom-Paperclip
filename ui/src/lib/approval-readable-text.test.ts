// @vitest-environment node

import { describe, expect, it } from "vitest";
import { approvalReadableText } from "./approval-readable-text";

describe("approvalReadableText", () => {
  it("leaves a trace of an embedded image: that it was one, its alternative text and its target", () => {
    expect(approvalReadableText("see ![](https://files.example/receipt.png) attached")).toBe(
      "see [image] (https://files.example/receipt.png) attached",
    );
    expect(approvalReadableText("see ![receipt](https://files.example/receipt.png) attached")).toBe(
      "see [image: receipt] (https://files.example/receipt.png) attached",
    );
    // No target to show: the image is still named as one.
    expect(approvalReadableText("![chart]()")).toBe("[image: chart]");
    expect(approvalReadableText("![  ]( )")).toBe("[image]");
    // Two on a line, and one beside a link: each keeps its own target.
    expect(approvalReadableText("![a](https://x.test/1.png) and ![b](https://x.test/2.png), see [the sheet](https://x.test/s)")).toBe(
      "[image: a] (https://x.test/1.png) and [image: b] (https://x.test/2.png), see the sheet (https://x.test/s)",
    );
    // An image used as a link keeps both targets: the picture's and the page's.
    expect(approvalReadableText("Status: [![badge](https://x.test/b.png)](https://x.test/build) today")).toBe(
      "Status: [image: badge] (https://x.test/b.png) (https://x.test/build) today",
    );
    expect(approvalReadableText("[![](https://x.test/b.png)]()")).toBe("[image] (https://x.test/b.png)");
    // The outer link is not closed: nothing is dropped.
    expect(approvalReadableText("[![badge](https://x.test/b.png)](https://x.test/build")).toBe(
      "[[image: badge] (https://x.test/b.png)](https://x.test/build",
    );
    // What is not image markup stays as written.
    expect(approvalReadableText("Wow! [really](https://x.test/r)")).toBe("Wow! really (https://x.test/r)");
    expect(approvalReadableText("![not closed](https://x.test/a.png")).toBe("![not closed](https://x.test/a.png");
    expect(approvalReadableText("![alt]\n(https://x.test/a.png)")).toBe("![alt]\n(https://x.test/a.png)");
  });

  it("does not rewrite numbers and paths written with two asterisks", () => {
    for (const kept of [
      "Compute grows from 2**10 to 2**12 units",
      "Glob src/**/a.ts and test/**/b.ts",
      "x**2 + y**2",
      "Run 3**3**2 first",
      "pattern **/*.snap and docs/**",
    ]) {
      expect(approvalReadableText(kept)).toBe(kept);
    }
    // Bold used as markup still goes, wherever punctuation touches it.
    expect(approvalReadableText("Rate: **$5**/unit")).toBe("Rate: $5/unit");
    expect(approvalReadableText("**Approve:** send it (**today**), cost **2**.")).toBe("Approve: send it (today), cost 2.");
    expect(approvalReadableText("1. **Grow** wholesale\n2. Raise to **2**")).toBe("1. Grow wholesale\n2. Raise to 2");
  });

  it("finds the same links as before, up to the same limits", () => {
    expect(approvalReadableText("See [the diff](https://example.test/a_b) and [x](x)")).toBe(
      "See the diff (https://example.test/a_b) and x",
    );
    expect(approvalReadableText("[wiki](https://en.example/wiki/A_(b)) end")).toBe("wiki (https://en.example/wiki/A_(b)) end");
    expect(approvalReadableText("[a [b](https://x.test)")).toBe("a [b (https://x.test)");
    expect(approvalReadableText("[](https://x.test) [ ](u)")).toBe("[](https://x.test)   (u)");
    const label = "l".repeat(300);
    const target = "t".repeat(2000);
    expect(approvalReadableText(`[${label}](${target})`)).toBe(`${label} (${target})`);
    expect(approvalReadableText(`[${label}l](${target})`)).toBe(`[${label}l](${target})`);
    expect(approvalReadableText(`[${label}](${target}t)`)).toBe(`[${label}](${target}t)`);
    expect(approvalReadableText("[a](one\ntwo)")).toBe("[a](one\ntwo)");
  });

  // Measured before this change with node on 1 MB: "[a](" repeated 3.1 s, "[" 2.1 s, "![" 2.1 s,
  // "![a](" 5.2 s. The limit below is far above what the single pass needs (a few milliseconds)
  // and far below what the patterns it replaced took.
  it("converts a megabyte of hostile text in well under a second", () => {
    const megabyte = 1024 * 1024;
    const fill = (unit: string) => unit.repeat(Math.ceil(megabyte / unit.length)).slice(0, megabyte);
    const hostile = [
      fill("[a]("),
      fill("["),
      fill("!["),
      fill("![a]("),
      fill("[![a](b)]("),
      fill("]("),
      `${fill("[a](").slice(0, megabyte - 1)})`,
      fill(`[${"x".repeat(299)}](`),
      fill(`[a](b${"x".repeat(1990)}\n`),
      fill("**a"),
      fill("`a"),
    ];
    for (const text of hostile) {
      const started = performance.now();
      approvalReadableText(text);
      expect(performance.now() - started).toBeLessThan(750);
    }
  });
});
