import { isStartupWorkHeld, startupWorkBarrier } from "./startup-work-barrier.js";
import { logger } from "../middleware/logger.js";
import { BOARD_COMMENT_REQUEST_PROTOCOL_VERSION } from "./issue-comment-request-canonical.js";

const processBootId = startupWorkBarrier.snapshot().bootId;
let lastControls: string | null = null;
const inFlight = { admission: 0, dispatch: 0 };

export function configuredBoardCommentRequestControls() {
  return {
    admission: process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED === "true",
    dispatch: process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED === "true",
  };
}

export function boardCommentRequestControls() {
  const configured = configuredBoardCommentRequestControls();
  const controls = { admission: configured.admission && !isStartupWorkHeld(), dispatch: configured.dispatch && !isStartupWorkHeld() };
  const identity = `${controls.admission}:${controls.dispatch}`;
  if (identity !== lastControls) {
    lastControls = identity;
    logger.info({ event: "board_comment_request.switch_state", ...controls, protocolVersion: BOARD_COMMENT_REQUEST_PROTOCOL_VERSION }, "Board comment protocol switches");
  }
  return controls;
}

export function boardCommentRequestOperationalSnapshot() {
  return { protocolVersion: BOARD_COMMENT_REQUEST_PROTOCOL_VERSION, processBootId,
    controls: boardCommentRequestControls(), configuredControls: configuredBoardCommentRequestControls(), startupWork: startupWorkBarrier.snapshot(), inFlight: { ...inFlight } };
}

export async function trackBoardCommentRequestOperation<T>(kind: keyof typeof inFlight, work: () => Promise<T>): Promise<T> {
  inFlight[kind]++;
  try { return await work(); } finally { inFlight[kind]--; }
}
