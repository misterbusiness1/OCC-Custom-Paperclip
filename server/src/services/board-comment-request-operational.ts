import { logger } from "../middleware/logger.js";
import { randomUUID } from "node:crypto";
import { BOARD_COMMENT_REQUEST_PROTOCOL_VERSION } from "./issue-comment-request-canonical.js";

const processBootId = randomUUID();
let lastControls: string | null = null;
const inFlight = { admission: 0, dispatch: 0 };

export function boardCommentRequestControls() {
  const controls = {
    admission: process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED === "true",
    dispatch: process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED === "true",
  };
  const identity = `${controls.admission}:${controls.dispatch}`;
  if (identity !== lastControls) {
    lastControls = identity;
    logger.info({ event: "board_comment_request.switch_state", ...controls, protocolVersion: BOARD_COMMENT_REQUEST_PROTOCOL_VERSION }, "Board comment protocol switches");
  }
  return controls;
}

export function boardCommentRequestOperationalSnapshot() {
  return { protocolVersion: BOARD_COMMENT_REQUEST_PROTOCOL_VERSION, processBootId,
    controls: boardCommentRequestControls(), inFlight: { ...inFlight } };
}

export async function trackBoardCommentRequestOperation<T>(kind: keyof typeof inFlight, work: () => Promise<T>): Promise<T> {
  inFlight[kind]++;
  try { return await work(); } finally { inFlight[kind]--; }
}
