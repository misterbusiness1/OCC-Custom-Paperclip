import { DEFAULT_MINIMAX_LOCAL_MODEL, models } from "../constants.js";
import { firstNonEmptyString } from "./util.js";

// The canonical, correctly-cased model ids the MiniMax API expects.
const CANONICAL_MODEL_IDS = models.map((m) => m.id);

// Canonicalize a configured model id: a hand-typed value like "minimax-m3",
// "MINIMAX-M2.7", or "some-provider/MiniMax-M2.7-highspeed" resolves to the
// exact id the API expects. Unknown ids pass through trimmed (the API is the
// source of truth for validity). Shared by execute() and the environment
// probe so a model-alias change is edited once.
export function normalizeMiniMaxModel(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_MINIMAX_LOCAL_MODEL;

  const bare = trimmed.includes("/")
    ? trimmed.slice(trimmed.lastIndexOf("/") + 1)
    : trimmed;
  const lower = bare.toLowerCase();

  for (const canonical of CANONICAL_MODEL_IDS) {
    if (lower === canonical.toLowerCase()) return canonical;
  }
  return trimmed;
}

// The request model for a config: primaryModel (documented override) first,
// then model. Shared by execute() and the environment probe so Test checks the
// same model a run will use.
export function resolveMiniMaxModel(config: Record<string, unknown>): string {
  return normalizeMiniMaxModel(firstNonEmptyString(config.primaryModel, config.model));
}
