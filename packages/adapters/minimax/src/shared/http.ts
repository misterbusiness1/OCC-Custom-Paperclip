// Bounded HTTP response reading shared by execute() and the environment probe.
//
// fetch() resolves as soon as response HEADERS arrive. Reading the body is a
// separate await that, on its own, has no deadline and no size limit: an
// upstream (or proxy) that sends headers and then stalls would hang the run
// forever, and a huge body would be buffered whole into memory. This helper
// reads the body as a stream, stops at `maxBytes`, and gives up as soon as
// `signal` aborts — whether or not the underlying fetch implementation itself
// propagates the abort into the body stream.

export type CappedReadResult =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: "aborted" | "too_large" | "error"; bytes: number; message?: string };

export async function readResponseTextCapped(
  response: Response,
  options: { maxBytes: number; signal: AbortSignal },
): Promise<CappedReadResult> {
  const { maxBytes, signal } = options;
  if (signal.aborted) return { ok: false, reason: "aborted", bytes: 0 };
  const body = response.body;
  if (!body) return { ok: true, text: "", bytes: 0 };

  const reader = body.getReader();
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const stop = () => {
    reader.cancel().catch(() => {});
  };

  try {
    while (true) {
      let step: ReadableStreamReadResult<Uint8Array> | "aborted";
      try {
        step = await Promise.race([reader.read(), aborted]);
      } catch (error) {
        stop();
        if (signal.aborted) return { ok: false, reason: "aborted", bytes };
        return {
          ok: false,
          reason: "error",
          bytes,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (step === "aborted") {
        stop();
        return { ok: false, reason: "aborted", bytes };
      }
      if (step.done) break;
      const chunk = step.value;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        stop();
        return { ok: false, reason: "too_large", bytes };
      }
      chunks.push(chunk);
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }

  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged), bytes };
}

// Both MiniMax requests are sent with redirect: "manual" so a redirect cannot
// carry the request (prompt body included) to a host the baseUrl guard never
// validated. A 3xx, or the opaque redirect a spec-compliant fetch returns for
// "manual", is treated as a failure.
export const NO_REDIRECT: RequestRedirect = "manual";

export function isRedirectResponse(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

// Parse a Retry-After header (delta-seconds or an HTTP-date) into an ISO
// timestamp. Returns null when absent or unparseable. The hint is capped at
// one hour (a per-run quota hint, not a schedule) so a hostile/buggy upstream
// cannot park the agent for long.
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let delayMs: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    delayMs = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    delayMs = at - now;
  }
  if (!Number.isFinite(delayMs)) return null;
  const bounded = Math.min(Math.max(0, delayMs), MAX_RETRY_AFTER_MS);
  return new Date(now + bounded).toISOString();
}
