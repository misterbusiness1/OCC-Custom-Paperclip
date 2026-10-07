/**
 * Agent-written approval text as readable plain text.
 *
 * This file imports nothing, so the cost of its patterns can be measured with
 * plain `node` (see "Cost on hostile text" in doc/approval-original-request.md).
 */

/** The longest link label and image alternative text that is rewritten. */
const LABEL_LIMIT = 300;
/** The longest link or image target that is rewritten. */
const TARGET_LIMIT = 2000;

const CLOSE_BRACKET = 93; // "]"
const OPEN_BRACKET = 91; // "["
const NEWLINE = 10;
const BANG = 33; // "!"

/**
 * Rewrites `[label](target)` or `![alt](target)` in one pass over the text.
 *
 * It finds the same matches as the patterns it replaces
 * (`\[([^\]\n]{1,300})\]\(([^)\n]{0,2000})\)` and the image form with an
 * optional alt), but a regular expression retries the 2,000-character target
 * from every `[`, which cost about three seconds per megabyte on text such as
 * `[a](` repeated. Here the next `)` and the next line break are looked up once
 * and reused, and the walk back to the opening `[` never passes the previous
 * `]`, so the work is linear in the length of the text.
 */
function rewriteTargets(
  text: string,
  kind: "link" | "image",
  render: (label: string, target: string) => string,
): string {
  let mid = text.indexOf("](");
  if (mid === -1) return text;

  let out = "";
  /** End of the text already written to `out`; a match never starts before it. */
  let copied = 0;
  /** Position of the next ")" and of the next line break; -1 once there is none left, -2 before the first search. */
  let closeAt = -2;
  let newlineAt = -2;

  while (mid !== -1) {
    const targetStart = mid + 2;
    if (closeAt !== -1 && closeAt < targetStart) closeAt = text.indexOf(")", targetStart);
    // With no ")" left, nothing further in the text can be a link or an image.
    if (closeAt === -1) break;
    if (newlineAt !== -1 && newlineAt < targetStart) newlineAt = text.indexOf("\n", targetStart);

    const targetCloses =
      closeAt - targetStart <= TARGET_LIMIT && (newlineAt === -1 || newlineAt > closeAt);
    let start = -1;
    if (targetCloses) {
      // The leftmost opener on this line, after the previous "]", within the label limit.
      const firstOpener = Math.max(kind === "image" ? copied + 1 : copied, mid - LABEL_LIMIT - 1);
      for (let index = mid - 1; index >= firstOpener; index -= 1) {
        const code = text.charCodeAt(index);
        if (code === CLOSE_BRACKET || code === NEWLINE) break;
        if (code !== OPEN_BRACKET) continue;
        if (kind === "image") {
          if (text.charCodeAt(index - 1) === BANG) start = index - 1;
        } else if (index < mid - 1) {
          // A link needs a label of at least one character.
          start = index;
        }
      }
    }

    if (start === -1) {
      mid = text.indexOf("](", mid + 1);
      continue;
    }
    const labelStart = kind === "image" ? start + 2 : start + 1;
    let rendered = render(text.slice(labelStart, mid), text.slice(targetStart, closeAt));
    let end = closeAt + 1;
    // An image used as the label of a link, `[![alt](image)](page)`: the page it links to is
    // kept as a link's target is, after the image's own trace.
    if (
      kind === "image" &&
      start > copied &&
      text.charCodeAt(start - 1) === OPEN_BRACKET &&
      text.startsWith("](", end)
    ) {
      const outerStart = end + 2;
      closeAt = text.indexOf(")", outerStart);
      if (newlineAt !== -1 && newlineAt < outerStart) newlineAt = text.indexOf("\n", outerStart);
      if (
        closeAt !== -1 &&
        closeAt - outerStart <= TARGET_LIMIT &&
        (newlineAt === -1 || newlineAt > closeAt)
      ) {
        const page = text.slice(outerStart, closeAt);
        if (page.trim()) rendered += ` (${page})`;
        start -= 1;
        end = closeAt + 1;
      }
    }
    out += text.slice(copied, start) + rendered;
    copied = end;
    mid = text.indexOf("](", copied);
  }

  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * An embedded image cannot be shown in a plain-text summary, but it must leave a
 * trace: that there was an image, its alternative text, and where it points.
 * The board may be approving what the picture shows. An image that is itself a
 * link, `[![alt](image)](page)`, becomes `[image: alt] (image) (page)`.
 */
function imageTrace(alt: string, target: string): string {
  const label = alt.trim() ? `[image: ${alt.trim()}]` : "[image]";
  return target.trim() ? `${label} (${target})` : label;
}

/** A link keeps its target: where it points can be what the board is approving. */
function linkWithTarget(label: string, target: string): string {
  return target && target !== label ? `${label} (${target})` : label;
}

/**
 * `**bold**` pairs only where they are markup: the opening pair does not follow
 * a word character, a slash, or another asterisk, and the closing pair is not
 * followed by a word character or an asterisk. `2**10 to 2**12` is arithmetic
 * and two asterisks between slashes are a glob path: both stay as written.
 */
const BOLD_PAIR = /(?<![\w/*])\*\*(?=\S)([^\n*]{0,200}?\S)\*\*(?![\w*])/g;

/**
 * Agent-written text as readable plain text. Line breaks, numbering, bullets
 * and indentation are structure, so they stay; only the markup around the
 * words goes. Identifiers keep their underscores and tildes, and a leading
 * ">" or "+" stays where it is (it may be a comparison or a sign): the board
 * must read what the agent wrote. An image becomes `[image: alt] (target)`.
 * Every step is bounded and linear, so a hostile payload cannot stall the page.
 */
export function approvalReadableText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalised = value.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const plain = rewriteTargets(rewriteTargets(normalised, "image", imageTrace), "link", linkWithTarget)
    .split("\n")
    .map((line) => line.trimEnd())
    // A line that is only a rule (---, ***, ___) carries no words.
    .filter((line) => !/^ {0,3}([-*_])(?: {0,2}\1){2,}$/.test(line))
    .map((line) =>
      line
        .replace(/^ {0,3}#{1,6} +/, "")
        .replace(/^( {0,12})[-*] +/, "$1• ")
        .replace(BOLD_PAIR, "$1")
        .replace(/`([^`\n]{1,200})`/g, "$1"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain || null;
}
