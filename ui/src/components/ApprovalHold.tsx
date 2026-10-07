import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long an approval is held in the browser before it is sent. The server acts on an
 * approval in the same request (it wakes the requester) and has no route that reverses a
 * decision, so this hold is the only moment at which an approval can still be taken back.
 */
export const APPROVE_HOLD_MS = 5_000;

/**
 * After a decision the queue opens the next request by itself, and its Approve button can land
 * where the last one was pressed. For this long after such a move an Approve on the card the page
 * just opened is taken for the second half of a double click, and is ignored.
 */
export const APPROVE_AFTER_ADVANCE_MS = 800;

/** What keeps a hold from running out: the pointer resting on its row, or keyboard focus on its Undo button. */
export type ApprovalHoldPauseReason = "pointer" | "focus";

export type HeldApproval = {
  id: string;
  /** The note typed with Approve; it is sent with the approval. */
  note?: string;
  /** The name the request goes by in its row and in announcements. */
  subject: string;
  /** The company whose list the request belongs to, for the reload once the approval lands. */
  companyId: string;
  /** When the approval is sent, in milliseconds since the epoch. It moves on when a paused hold runs again. */
  sendAt: number;
  /** The time left, in milliseconds, of a hold whose countdown is paused. Null or absent while it runs. */
  pausedMs?: number | null;
  /** "holding": nothing has been sent and it can be undone. "sending": the request is on its way. */
  phase: "holding" | "sending";
  /** The order the holds were started in. */
  seq: number;
};

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

type RunningHold = {
  /** Null while the countdown is paused. */
  timer: number | null;
  entry: HeldApproval;
  pausedBy: Set<ApprovalHoldPauseReason>;
  /** The time a paused hold has left when it runs again. */
  remaining: number;
};

/**
 * Approvals held back for a short undo window. `send` is called once for every hold that is
 * not undone: when its time is up, or at once when the page is about to stop showing it
 * (`flush`, the component unmounting, the document becoming hidden, `pagehide`). A hold is
 * therefore never dropped, and never sent twice.
 *
 * `pause` stops a hold's clock while the reader is at its Undo (pointer on the row, focus on the
 * button) and `resume` lets the rest of its time run. A paused hold is still sent at once by
 * `flush` and the page-level events, and is still cancelled by `undo`.
 */
export function useApprovalHolds({
  send,
  holdMs = APPROVE_HOLD_MS,
}: {
  /** Sends the approval. The caller calls `release` once the request has settled. */
  send: (held: HeldApproval) => void;
  holdMs?: number;
}) {
  const [held, setHeld] = useState<Record<string, HeldApproval>>({});
  // The holds whose time is still running. Read by the timers and the page-level events, outside rendering.
  const running = useRef(new Map<string, RunningHold>());
  // Every request this hook holds or is sending, so a second hold of the same request is refused.
  const active = useRef(new Set<string>());
  const seq = useRef(0);
  const sendRef = useRef(send);
  sendRef.current = send;

  const dispatch = useCallback((id: string) => {
    const hold = running.current.get(id);
    // Undone, or already sent by the timer or an earlier flush.
    if (!hold) return;
    running.current.delete(id);
    if (hold.timer !== null) window.clearTimeout(hold.timer);
    const sending: HeldApproval = { ...hold.entry, phase: "sending", pausedMs: null };
    setHeld((current) => (current[id] ? { ...current, [id]: sending } : current));
    sendRef.current(sending);
  }, []);

  /** Starts the hold. False when the request is already held or on its way. */
  const hold = useCallback(
    (input: Pick<HeldApproval, "id" | "note" | "subject" | "companyId">) => {
      if (active.current.has(input.id)) return false;
      active.current.add(input.id);
      seq.current += 1;
      const entry: HeldApproval = { ...input, sendAt: Date.now() + holdMs, phase: "holding", seq: seq.current };
      const timer = window.setTimeout(() => dispatch(entry.id), holdMs);
      running.current.set(entry.id, { timer, entry, pausedBy: new Set(), remaining: holdMs });
      setHeld((current) => ({ ...current, [entry.id]: entry }));
      return true;
    },
    [dispatch, holdMs],
  );

  /** Cancels a hold whose time is still running and returns it. Null when it has already been sent. */
  const undo = useCallback((id: string) => {
    const hold = running.current.get(id);
    if (!hold) return null;
    running.current.delete(id);
    if (hold.timer !== null) window.clearTimeout(hold.timer);
    active.current.delete(id);
    setHeld((current) => without(current, id));
    return hold.entry;
  }, []);

  /** Stops the clock of a hold that is still running. Each reason is lifted by its own `resume`. */
  const pause = useCallback((id: string, reason: ApprovalHoldPauseReason) => {
    const hold = running.current.get(id);
    // Undone or already sent: there is no clock to stop.
    if (!hold) return;
    const alreadyPaused = hold.pausedBy.size > 0;
    hold.pausedBy.add(reason);
    if (alreadyPaused) return;
    if (hold.timer !== null) window.clearTimeout(hold.timer);
    hold.timer = null;
    hold.remaining = Math.max(0, hold.entry.sendAt - Date.now());
    const entry: HeldApproval = { ...hold.entry, pausedMs: hold.remaining };
    hold.entry = entry;
    setHeld((current) => (current[id] ? { ...current, [id]: entry } : current));
  }, []);

  /** Lifts one reason for a pause. Once none is left, the rest of the hold's time runs. */
  const resume = useCallback(
    (id: string, reason: ApprovalHoldPauseReason) => {
      const hold = running.current.get(id);
      if (!hold || !hold.pausedBy.delete(reason) || hold.pausedBy.size > 0) return;
      const entry: HeldApproval = { ...hold.entry, sendAt: Date.now() + hold.remaining, pausedMs: null };
      hold.entry = entry;
      hold.timer = window.setTimeout(() => dispatch(id), hold.remaining);
      setHeld((current) => (current[id] ? { ...current, [id]: entry } : current));
    },
    [dispatch],
  );

  /** Forgets a hold whose request has settled. */
  const release = useCallback((id: string) => {
    active.current.delete(id);
    setHeld((current) => without(current, id));
  }, []);

  /** Sends every hold that is still running, now. */
  const flush = useCallback(() => {
    for (const id of [...running.current.keys()]) dispatch(id);
  }, [dispatch]);

  /** The most recently started hold that can still be undone. */
  const latestRunningId = useCallback(() => {
    let latest: HeldApproval | null = null;
    for (const { entry } of running.current.values()) {
      if (!latest || entry.seq > latest.seq) latest = entry;
    }
    return latest?.id ?? null;
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flush);
      // The page is going away: what it still holds is sent, not dropped.
      flush();
    };
  }, [flush]);

  return { held, hold, undo, release, flush, pause, resume, latestRunningId };
}

/**
 * "Approving in 5s", counting down once a second until the approval is sent. While the hold is
 * paused it stands still and says so: "Paused, 3s left".
 */
export function ApprovalHoldCountdown({ sendAt, pausedMs = null }: { sendAt: number; pausedMs?: number | null }) {
  const [seconds, setSeconds] = useState(() => secondsUntil(sendAt));
  const paused = pausedMs !== null;
  useEffect(() => {
    if (paused) return;
    setSeconds(secondsUntil(sendAt));
    // Checked more often than once a second, so the number changes on the second.
    const timer = window.setInterval(() => setSeconds(secondsUntil(sendAt)), 250);
    return () => window.clearInterval(timer);
  }, [sendAt, paused]);
  if (pausedMs !== null) return <>Paused, {wholeSeconds(pausedMs)}s left</>;
  return <>Approving in {seconds}s</>;
}

function wholeSeconds(ms: number) {
  return Math.max(1, Math.ceil(ms / 1000));
}

function secondsUntil(sendAt: number) {
  return wholeSeconds(sendAt - Date.now());
}
