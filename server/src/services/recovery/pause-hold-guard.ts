import type { Db } from "@paperclipai/db";
import { issueTreeControlService } from "../issue-tree-control.js";

type IssueTreeControlService = ReturnType<typeof issueTreeControlService>;

export async function isAutomaticRecoverySuppressedByPauseHold(
  db: Db,
  companyId: string,
  issueId: string,
  treeControlSvc: IssueTreeControlService = issueTreeControlService(db),
  executor: Pick<Db, "select"> = db,
) {
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, issueId, executor);
  return Boolean(activePauseHold);
}
