/** Personal inbox routing; company-wide run visibility is unchanged. */
export function isHeartbeatRunVisibleInMine(
  run: { responsibleUserId?: string | null },
  currentUserId: string | null | undefined,
): boolean {
  if (!currentUserId) return false;
  if (run.responsibleUserId) return run.responsibleUserId === currentUserId;
  // Fork rule: a run attributed to no one is shown to every board user. Upstream shows it only
  // to the single-user local board, so on an authenticated instance such failures would leave
  // Mine and the inbox badge for everyone and be seen only on All.
  return true;
}
