import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long an approval is held in the browser before it is sent. The server acts on an
 * approval in the same request (it wakes the requester) and has no route that reverses a
 * decision, so this hold is the only moment at which an approval can still be taken back.
 */
export const APPROVE_HOLD_MS = 5_000;

/**
 * After a decision the queue opens the next request by itself, and the cards below move up: an
 * Approve button can land where the last one was pressed. For this long after such a move an
 * Approve on any card is taken for the second half of a double click, and is ignored. The same
 * goes for a row the reader has just opened by its header: its Approve lands where the header was.
 */
export const APPROVE_AFTER_ADVANCE_MS = 800;

/**
 * The longest a hold's countdown may stand still, counted over all its pauses and both reasons
 * together. Once it is used up the countdown runs whatever the pointer or focus does, so a pointer
 * left on a row cannot keep an approval unsent for as long as the window stays open.
 */
export const APPROVE_PAUSE_LIMIT_MS = 30_000;

/**
 * The least time a hold runs for once that limit has ended its pause, however little it had left
 * when it was paused (never more than the hold itself): the notice that the pause is over can be
 * read and heard, and Undo still reached, before the approval goes out.
 */
export const APPROVE_AFTER_PAUSE_LIMIT_MS = 3_000;

/** What keeps a hold from running out: the pointer moved onto its row, or keyboard focus on its Undo button. */
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
  /** True once the hold has used up its pause time (`APPROVE_PAUSE_LIMIT_MS`): it cannot be paused again. */
  pauseUsedUp?: boolean;
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
  /** When the pause now in force began. Null while the countdown runs. */
  pausedSince: number | null;
  /** How much longer the hold may stand still, over all its pauses. */
  pauseLeft: number;
  /** Ends a pause that has used up that time. Null while the countdown runs. */
  limitTimer: number | null;
};

function stopClocks(hold: RunningHold) {
  if (hold.timer !== null) window.clearTimeout(hold.timer);
  if (hold.limitTimer !== null) window.clearTimeout(hold.limitTimer);
  hold.timer = null;
  hold.limitTimer = null;
}

/**
 * Approvals held back for a short undo window. `send` is called once for every hold that is
 * not undone: when its time is up, or at once when the page is about to stop showing it
 * (`flush`, the component unmounting, the document becoming hidden, `pagehide`). A hold is
 * therefore never dropped, and never sent twice.
 *
 * `pause` stops a hold's clock while the reader is at its Undo (pointer on the row, focus on the
 * button) and `resume` lets the rest of its time run. A hold stands still for `pauseLimitMs` at
 * most, all its pauses taken together: then its time runs, `onPauseLimit` is called once, and it
 * cannot be paused again. A paused hold is still sent at once by `flush` and the page-level
 * events, and is still cancelled by `undo`.
 */
export function useApprovalHolds({
  send,
  holdMs = APPROVE_HOLD_MS,
  pauseLimitMs = APPROVE_PAUSE_LIMIT_MS,
  onPauseLimit,
}: {
  /** Sends the approval. The caller calls `release` once the request has settled. */
  send: (held: HeldApproval) => void;
  holdMs?: number;
  pauseLimitMs?: number;
  /** A paused hold has used up its pause time and is counting down again. */
  onPauseLimit?: (held: HeldApproval) => void;
}) {
  const [held, setHeld] = useState<Record<string, HeldApproval>>({});
  // The holds whose time is still running. Read by the timers and the page-level events, outside rendering.
  const running = useRef(new Map<string, RunningHold>());
  // Every request this hook holds or is sending, so a second hold of the same request is refused.
  const active = useRef(new Set<string>());
  const seq = useRef(0);
  const sendRef = useRef(send);
  sendRef.current = send;
  const pauseLimitRef = useRef(onPauseLimit);
  pauseLimitRef.current = onPauseLimit;

  const dispatch = useCallback((id: string) => {
    const hold = running.current.get(id);
    // Undone, or already sent by the timer or an earlier flush.
    if (!hold) return;
    running.current.delete(id);
    stopClocks(hold);
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
      running.current.set(entry.id, {
        timer,
        entry,
        pausedBy: new Set(),
        remaining: holdMs,
        pausedSince: null,
        pauseLeft: pauseLimitMs,
        limitTimer: null,
      });
      setHeld((current) => ({ ...current, [entry.id]: entry }));
      return true;
    },
    [dispatch, holdMs, pauseLimitMs],
  );

  /** Cancels a hold whose time is still running and returns it. Null when it has already been sent. */
  const undo = useCallback((id: string) => {
    const hold = running.current.get(id);
    if (!hold) return null;
    running.current.delete(id);
    stopClocks(hold);
    active.current.delete(id);
    setHeld((current) => without(current, id));
    return hold.entry;
  }, []);

  /**
   * Ends the pause of a hold: the rest of its time runs, and the time it stood still is taken off
   * its pause time. `usedUp`: the pause ended because that time ran out.
   */
  const run = useCallback(
    (id: string, hold: RunningHold, usedUp = false) => {
      stopClocks(hold);
      hold.pauseLeft = usedUp ? 0 : Math.max(0, hold.pauseLeft - (Date.now() - (hold.pausedSince ?? Date.now())));
      hold.pausedSince = null;
      const entry: HeldApproval = {
        ...hold.entry,
        sendAt: Date.now() + hold.remaining,
        pausedMs: null,
        pauseUsedUp: hold.pauseLeft <= 0,
      };
      hold.entry = entry;
      hold.timer = window.setTimeout(() => dispatch(id), hold.remaining);
      setHeld((current) => (current[id] ? { ...current, [id]: entry } : current));
      return entry;
    },
    [dispatch],
  );

  /**
   * Stops the clock of a hold that is still running. Each reason is lifted by its own `resume`.
   * Does nothing once the hold has used up its pause time.
   */
  const pause = useCallback(
    (id: string, reason: ApprovalHoldPauseReason) => {
      const hold = running.current.get(id);
      // Undone or already sent: there is no clock to stop. Out of pause time: it is not stopped again.
      if (!hold || hold.pauseLeft <= 0) return;
      const alreadyPaused = hold.pausedBy.size > 0;
      hold.pausedBy.add(reason);
      if (alreadyPaused) return;
      if (hold.timer !== null) window.clearTimeout(hold.timer);
      hold.timer = null;
      hold.remaining = Math.max(0, hold.entry.sendAt - Date.now());
      hold.pausedSince = Date.now();
      hold.limitTimer = window.setTimeout(() => {
        const paused = running.current.get(id);
        if (!paused || paused.pausedBy.size === 0) return;
        // The pointer may still be on the row and focus on Undo: neither holds the clock any longer.
        paused.pausedBy.clear();
        // A pause that began in the hold's last moment would otherwise end with the approval sent at once.
        paused.remaining = Math.max(paused.remaining, Math.min(holdMs, APPROVE_AFTER_PAUSE_LIMIT_MS));
        pauseLimitRef.current?.(run(id, paused, true));
      }, hold.pauseLeft);
      const entry: HeldApproval = { ...hold.entry, pausedMs: hold.remaining };
      hold.entry = entry;
      setHeld((current) => (current[id] ? { ...current, [id]: entry } : current));
    },
    [run, holdMs],
  );

  /** Lifts one reason for a pause. Once none is left, the rest of the hold's time runs. */
  const resume = useCallback(
    (id: string, reason: ApprovalHoldPauseReason) => {
      const hold = running.current.get(id);
      if (!hold || !hold.pausedBy.delete(reason) || hold.pausedBy.size > 0) return;
      run(id, hold);
    },
    [run],
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
 * paused it stands still and says so: "Paused, 3s left". A hold that has used up its pause time
 * says that too, because the pointer or focus that paused it may still be there: "Pause over,
 * sending in 3s".
 */
export function ApprovalHoldCountdown({
  sendAt,
  pausedMs = null,
  pauseUsedUp = false,
}: {
  sendAt: number;
  pausedMs?: number | null;
  pauseUsedUp?: boolean;
}) {
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
  if (pauseUsedUp) return <>Pause over, sending in {seconds}s</>;
  return <>Approving in {seconds}s</>;
}

/** The seconds until a held approval is sent, as its row shows them. */
export function approvalHoldSecondsLeft(held: Pick<HeldApproval, "sendAt">) {
  return secondsUntil(held.sendAt);
}

function wholeSeconds(ms: number) {
  return Math.max(1, Math.ceil(ms / 1000));
}

function secondsUntil(sendAt: number) {
  return wholeSeconds(sendAt - Date.now());
}
