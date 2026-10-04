import { and, eq } from "drizzle-orm";
import { executionWorkspaces, workspaceOperations, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

export const BOARD_COMMENT_WORKSPACE_RESERVATION = "boardCommentReopenReservation";
export interface BoardCommentWorkspaceCapability { operationId: string; generation: number }
export function hasBoardCommentWorkspaceReservation(metadata: Record<string, unknown> | null | undefined) {
  return metadata?.[BOARD_COMMENT_WORKSPACE_RESERVATION] != null;
}
export async function assertBoardCommentWorkspaceMaterializationAllowed(
  db: Db | null | undefined, workspaceId: string | null | undefined,
  snapshot: Record<string, unknown> | null | undefined, capability?: BoardCommentWorkspaceCapability,
) {
  let metadata = snapshot;
  if (db && workspaceId) {
    // This short row lock orders the check against admission's workspace lock.
    // Runtime owners commit their run/operation before reaching this check;
    // admission therefore sees earlier owners, while later owners see its reservation.
    // The statement releases its lock before any physical materialization.
    const [row] = await db.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId)).for("share");
    if (!row) throw conflict("Execution workspace disappeared");
    metadata = row.metadata;
  }
  if (!hasBoardCommentWorkspaceReservation(metadata)) {
    if (capability) throw conflict("Workspace reopen reservation disappeared");
    return;
  }
  const owner = metadata?.[BOARD_COMMENT_WORKSPACE_RESERVATION] as Record<string, unknown>;
  if (!db || !workspaceId || !capability || owner.operationId !== capability.operationId
      || owner.generation !== capability.generation) throw conflict("Workspace is reserved by an accepted Board request");
  const [operation] = await db.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.id, capability.operationId), eq(workspaceOperations.executionWorkspaceId, workspaceId),
    eq(workspaceOperations.phase, "board_comment_reopen"), eq(workspaceOperations.status, "running")));
  if (operation?.metadata?.phase !== "executing" || operation.metadata.generation !== capability.generation)
    throw conflict("Workspace reopen operation is no longer executing");
}
