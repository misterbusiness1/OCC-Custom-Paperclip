// Shared assistant-text sanitization. Used by execute() (final + interleaved
// output) and by the environment probe so the health check and the real run
// sanitize identical bytes.

// Remove <think>...</think> reasoning blocks. Handles paired tags AND a
// leading orphan <think> with no closing tag (truncated reasoning responses),
// so a cut-off chain-of-thought is never surfaced verbatim.
export function stripThinkBlocks(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*<think>[\s\S]*?(?:<\/think>|$)/i, "")
    .trim();
}

export function applyStripThink(value: string, stripThink: boolean): string {
  return stripThink ? stripThinkBlocks(value) : value.trim();
}
