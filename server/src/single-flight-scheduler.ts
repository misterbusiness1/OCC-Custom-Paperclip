/** Skip overlapping ticks per queue, without blocking unrelated queues.
 * Work must be lazy: accepting an already-started promise cannot bound it.
 * The tracker owns error handling and shutdown draining, as for other work.
 */
export function createSingleFlightScheduler(
  track: (work: Promise<unknown>) => void,
) {
  const active = new Set<string>();
  return (key: string, work: () => unknown | Promise<unknown>): boolean => {
    if (active.has(key)) return false;
    active.add(key);
    track(Promise.resolve().then(work).finally(() => active.delete(key)));
    return true;
  };
}
