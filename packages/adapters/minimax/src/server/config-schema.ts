import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_MINIMAX_LOCAL_BASE_URL,
  DEFAULT_MINIMAX_LOCAL_MAX_COMPLETION_TOKENS,
  DEFAULT_MINIMAX_LOCAL_MAX_TOOL_ITERATIONS,
  DEFAULT_MINIMAX_LOCAL_MODEL,
  DEFAULT_MINIMAX_LOCAL_STRIP_THINK,
  DEFAULT_MINIMAX_LOCAL_TEMPERATURE,
  DEFAULT_MINIMAX_LOCAL_TOOL_COMMAND_TIMEOUT_SEC,
  DEFAULT_MINIMAX_LOCAL_TOOLS_ENABLED,
  models,
} from "../constants.js";

// Config form rendered by Paperclip's schema-driven UI for external adapters
// (ui/src/adapters/schema-config-fields.tsx). Field keys land directly on
// adapterConfig, which execute() reads. The MiniMax API key is NOT a field
// here: bind a company secret to env.MINIMAX_API_KEY through the agent's
// environment-variable editor instead.
export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "select",
        options: models.map((m) => ({ label: m.label, value: m.id })),
        default: DEFAULT_MINIMAX_LOCAL_MODEL,
        hint: "MiniMax model id.",
      },
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        default: DEFAULT_MINIMAX_LOCAL_BASE_URL,
        hint:
          "OpenAI-compatible endpoint. A custom endpoint must use https (loopback excepted) and its own env.MINIMAX_API_KEY.",
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        default: DEFAULT_MINIMAX_LOCAL_TEMPERATURE,
        hint: "Sampling temperature (0-2).",
      },
      {
        key: "max_completion_tokens",
        label: "Max completion tokens",
        type: "number",
        default: DEFAULT_MINIMAX_LOCAL_MAX_COMPLETION_TOKENS,
      },
      {
        key: "stripThink",
        label: "Strip <think> blocks",
        type: "toggle",
        default: DEFAULT_MINIMAX_LOCAL_STRIP_THINK,
        hint: "Remove reasoning blocks from logged and stored output.",
      },
      {
        key: "toolsEnabled",
        label: "Enable bash tool",
        type: "toggle",
        default: DEFAULT_MINIMAX_LOCAL_TOOLS_ENABLED,
        hint:
          "Off by default. When on, the model can run shell commands on the Paperclip host in the run workspace.",
      },
      {
        key: "maxToolIterations",
        label: "Max tool iterations",
        type: "number",
        default: DEFAULT_MINIMAX_LOCAL_MAX_TOOL_ITERATIONS,
        hint: "Only used when the bash tool is enabled. Reaching the cap fails the run.",
      },
      {
        key: "toolCommandTimeoutSec",
        label: "Per-command timeout (s)",
        type: "number",
        default: DEFAULT_MINIMAX_LOCAL_TOOL_COMMAND_TIMEOUT_SEC,
        hint: "Only used when the bash tool is enabled.",
      },
      {
        key: "timeoutSec",
        label: "Run timeout (s)",
        type: "number",
        default: 0,
        hint: "Whole-run budget. 0 disables it (a per-request timeout still applies).",
      },
      {
        key: "instructionsFilePath",
        label: "Agent instructions file",
        type: "text",
        hint: "Absolute path to a markdown file prepended to the prompt.",
      },
    ],
  };
}
