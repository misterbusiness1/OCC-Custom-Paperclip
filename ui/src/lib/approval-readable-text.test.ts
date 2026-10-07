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

  it("keeps the asterisks of a glob that starts or ends a path", () => {
    for (const kept of [
      "Exclude **/dist/** from the build",
      "Run rm -rf **/cache/** before the deploy",
      "Delete everything matching **/tmp/** on the build host",
      "Ignore **/dist and build/**",
      "CODEOWNERS: **/billing/** @finance",
      "Globs: **/a.ts,**/b.ts",
    ]) {
      expect(approvalReadableText(kept)).toBe(kept);
    }
    // In backticks the glob loses the backticks and nothing else.
    expect(approvalReadableText("Add `**/node_modules/**` to the ignore list")).toBe(
      "Add **/node_modules/** to the ignore list",
    );
    // The price: bold text that starts with a slash is shown with its asterisks.
    expect(approvalReadableText("Use **/approve** to confirm")).toBe("Use **/approve** to confirm");
    // Bold beside a glob on the same line is still removed.
    expect(approvalReadableText("**Exclude** **/dist/** from the **build**")).toBe("Exclude **/dist/** from the build");
  });

  it("drops a rule line and nothing that only looks like one", () => {
    const dropped = ["---", "***", "___", "- - -", "*  *  *", "   ---", "_ _ _ _", "-----------", "- -- -"];
    for (const line of dropped) {
      expect(approvalReadableText(`above\n${line}\nbelow`)).toBe("above\nbelow");
      expect(approvalReadableText(`above\n${line}   \nbelow`)).toBe("above\nbelow");
    }
    const kept = ["--", "- -", "    ---", "-*-", "--- x", "---x", "-   -   -", "_ _", "x---", "-_-", "= = ="];
    for (const line of kept) {
      expect(approvalReadableText(`above\n${line}\nbelow`)?.split("\n")).toHaveLength(3);
    }

    // Every line of up to six characters over the characters that matter gives the same answer as
    // the pattern the loop replaced.
    const pattern = /^ {0,3}([-*_])(?: {0,2}\1){2,}$/;
    const alphabet = [" ", "-", "*", "_", "x"];
    let lines = [""];
    let checked = 0;
    for (let length = 1; length <= 6; length += 1) {
      lines = lines.flatMap((line) => alphabet.map((character) => line + character));
      for (const line of lines) {
        const isDropped = approvalReadableText(`above\n${line}\nbelow`) === "above\nbelow";
        if (isDropped !== pattern.test(line.trimEnd())) throw new Error(`rule line mismatch for ${JSON.stringify(line)}`);
        checked += 1;
      }
    }
    expect(checked).toBe(5 + 25 + 125 + 625 + 3125 + 15625);
  });

  // The pattern this replaced threw "Maximum call stack size exceeded" from about 3.36 million
  // markers on one line, and the error took the whole page with it.
  it("converts one line of millions of rule markers without throwing", () => {
    const length = 4 * 1024 * 1024;
    const fill = (unit: string) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    // A rule line of any length is dropped, as a short one is.
    for (const rule of [fill("-"), fill("_"), fill("*"), `${fill("- ")}-`, `${fill("* ")}*`, `${fill("-  ")}-`, `   ${fill("-")}`]) {
      expect(approvalReadableText(`Approve the spend.\n${rule}`)).toBe("Approve the spend.");
      expect(approvalReadableText(`Approve the spend.\n${rule}\nIt is due on Friday.`)).toBe(
        "Approve the spend.\nIt is due on Friday.",
      );
    }
    // Markers followed by words are not a rule line: the line is kept whole.
    for (const marker of ["-", "_"]) {
      const kept = approvalReadableText(`${fill(marker)} approve`);
      expect(kept?.length).toBe(length + " approve".length);
      expect(kept?.endsWith(`${marker}${marker} approve`)).toBe(true);
    }
    const mixed = approvalReadableText(`${fill("-")}_`);
    expect(mixed?.length).toBe(length + 1);
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
      // Text of many short lines.
      `a${fill("\n")}b`,
      fill("x\n"),
      fill("\r\n"),
      // One long line of rule markers, and one that only starts like a rule.
      fill("-"),
      fill("* "),
      `${fill("_")} x`,
    ];
    for (const text of hostile) {
      const started = performance.now();
      approvalReadableText(text);
      expect(performance.now() - started).toBeLessThan(750);
    }
  });

  // Measured with node on 1 MB before the per-line checks: a run of line breaks 701 ms and "x\n"
  // repeated 356 ms, 16 and 10 times the cost of splitting the text into lines and joining it
  // again; after them 100 ms and 95 ms, about 2.5 times. The limit is a ratio, so that it holds on
  // a slow machine and still fails when every line pays for every pattern again.
  it("converts text of many short lines for little more than splitting it into lines", () => {
    const megabyte = 1024 * 1024;
    const bestOf = (run: () => unknown) => {
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const started = performance.now();
        run();
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    for (const text of [`a${"\n".repeat(megabyte)}b`, "x\n".repeat(megabyte / 2)]) {
      const floor = bestOf(() => text.split("\n").map((line) => line.trimEnd()).join("\n"));
      const cost = bestOf(() => approvalReadableText(text));
      expect(cost / floor).toBeLessThan(6);
    }
  });
});
