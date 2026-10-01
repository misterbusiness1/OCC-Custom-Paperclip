/**
 * Pure keyboard-shortcut mapping for the Board Approval decision card (OXFA-2799).
 *
 * Kept free of React/DOM so the decision table can be unit-tested directly. The
 * caller is responsible for wiring a `keydown` listener, deriving
 * {@link ApprovalShortcutContext} from the live approval, and dispatching the
 * returned action.
 */

export type ApprovalShortcutAction = "approve" | "reject" | "request_revision" | "toggle_raw";

export interface ApprovalShortcutContext {
  /** pending or revision_requested — the two states that accept approve/reject. */
  isActionable: boolean;
  /** budget overrides resolve from /costs, never from the card buttons. */
  isBudgetApproval: boolean;
  status: string;
  /** true when focus is in an input/textarea/contenteditable — shortcuts suppressed. */
  typingInField: boolean;
}

/**
 * Resolve a pressed key to a decision-card action, or `null` when the key is
 * unmapped or not permitted in the current context. Modifier chords (Ctrl/Meta/Alt)
 * are ignored so browser and OS shortcuts are never shadowed.
 */
export function resolveApprovalShortcut(
  key: string,
  ctx: ApprovalShortcutContext,
): ApprovalShortcutAction | null {
  if (ctx.typingInField) return null;
  const normalized = key.length === 1 ? key.toLowerCase() : key;

  // Viewing the raw payload is always safe, regardless of actionability.
  if (normalized === "v") return "toggle_raw";

  if (!ctx.isActionable || ctx.isBudgetApproval) return null;

  if (normalized === "a") return "approve";
  if (normalized === "r") return "reject";
  // Request revision only makes sense from a fresh pending request.
  if (normalized === "e" && ctx.status === "pending") return "request_revision";

  return null;
}

/** Human-readable shortcut hints for the card's help affordance. */
export const APPROVAL_SHORTCUT_HINTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: "A", label: "Approve" },
  { keys: "R", label: "Reject" },
  { keys: "E", label: "Request revision" },
  { keys: "V", label: "View raw payload" },
];
