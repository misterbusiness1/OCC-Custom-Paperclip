// Leaf module: shared constants + adapter metadata. Must NOT import from
// server/ or shared/ (those import back here), to keep module init acyclic.
export const type = "minimax_local";
export const label = "MiniMax";
export const DEFAULT_MINIMAX_LOCAL_MODEL = "MiniMax-M3";
export const DEFAULT_MINIMAX_LOCAL_BASE_URL = "https://api.minimax.io/v1";
export const DEFAULT_MINIMAX_LOCAL_TEMPERATURE = 0.2;
export const DEFAULT_MINIMAX_LOCAL_MAX_COMPLETION_TOKENS = 8192;
export const DEFAULT_MINIMAX_LOCAL_STRIP_THINK = true;
// Tool calling ships OFF by default: an LLM-driven shell on the Paperclip host
// is a powerful capability and must be an explicit operator opt-in. External
// adapters only get the "local" execution driver in this fork, so when enabled
// the bash tool runs on the host that runs the Paperclip server.
export const DEFAULT_MINIMAX_LOCAL_TOOLS_ENABLED = false;
export const DEFAULT_MINIMAX_LOCAL_MAX_TOOL_ITERATIONS = 25;
export const DEFAULT_MINIMAX_LOCAL_TOOL_COMMAND_TIMEOUT_SEC = 120;
export const DEFAULT_MINIMAX_LOCAL_TOOL_OUTPUT_LIMIT_BYTES = 32768;
// Per-request cap for a single /chat/completions call, independent of the
// whole-run timeoutSec budget, so a stalled request can never hang a run.
// The timer covers the whole request, including reading the response body:
// headers followed by a stalled body still times out.
export const DEFAULT_MINIMAX_LOCAL_REQUEST_TIMEOUT_SEC = 300;
// Hard cap on one /chat/completions response body. The body is streamed and
// the request is aborted past this size, so a hostile or broken endpoint
// cannot make the server buffer an unbounded payload.
export const MINIMAX_LOCAL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Cap on the final assistant text kept as the run summary / logged output.
export const MINIMAX_LOCAL_MAX_FINAL_TEXT_CHARS = 100_000;

export const models = [
  { id: "MiniMax-M3", label: "MiniMax-M3" },
  { id: "MiniMax-M2.7", label: "MiniMax-M2.7" },
  { id: "MiniMax-M2.7-highspeed", label: "MiniMax-M2.7-highspeed" },
];

export const agentConfigurationDoc = `# minimax_local agent configuration

Adapter: minimax_local (external adapter package @paperclipai/minimax-paperclip-adapter)

Use when:
- You want Paperclip to call the MiniMax OpenAI-compatible API directly
- You want a lightweight chat adapter, optionally with a single bash tool
  executed through native (structured) tool calling

Don't use when:
- You need a full coding-agent harness (file tools, compaction, skills,
  sandboxing): use opencode_local or codex_local
- You need webhook-style external invocation (use http or openclaw_gateway)

Core fields:
- model (string, optional): defaults to MiniMax-M3
- primaryModel (string, optional): defaults to model
- baseUrl (string, optional): defaults to https://api.minimax.io/v1
- temperature (number, optional): defaults to 0.2
- max_completion_tokens or maxTokens (number, optional): defaults to 8192
- stripThink (boolean, optional): defaults to true
- toolsEnabled (boolean, optional): defaults to false. Set true to enable the
  bash tool loop. Commands run on the Paperclip host (local execution target).
- maxToolIterations (number, optional): defaults to 25. Hard cap on
  send/execute round trips; reaching the cap fails the run
  (errorCode minimax_iteration_cap).
- toolCommandTimeoutSec (number, optional): defaults to 120. Per-command
  timeout; timed-out commands are killed and reported to the model.
- toolOutputLimitBytes (number, optional): defaults to 32768. Combined
  stdout+stderr cap per command, in UTF-8 bytes, before truncation.
- timeoutSec (number, optional): total wall-clock budget for the run
  including tool execution. 0 disables the budget (a per-request timeout of
  ${DEFAULT_MINIMAX_LOCAL_REQUEST_TIMEOUT_SEC}s still applies to each call).
- requestTimeoutSec (number, optional): per-request timeout covering the
  headers and the body read, defaults to ${DEFAULT_MINIMAX_LOCAL_REQUEST_TIMEOUT_SEC}.
- instructionsFilePath (string, optional): absolute path to a markdown
  instructions file prepended to the prompt
- promptTemplate (string, optional): heartbeat prompt template
- pricing (object, optional): per-model USD rate overrides, e.g.
  { "MiniMax-M3": { "inputPerMTok": 0.3, "outputPerMTok": 1.2 } }.
  Rates must be > 0 and <= 1000; an invalid override is ignored.
- env.MINIMAX_API_KEY (string or secret ref, recommended): MiniMax API key

Notes:
- The adapter calls POST /chat/completions. When toolsEnabled it also sends a
  single "bash" tool and loops on structured tool_calls until the model
  finishes, executing each command in the run's execution-workspace cwd.
- baseUrl defaults to the official MiniMax endpoint (https only). A custom
  baseUrl must use https (localhost and loopback IP literals excepted), must
  not contain a query string, fragment or credentials, and must supply its own
  env.MINIMAX_API_KEY: the shared host key is never sent to a non-default
  endpoint. Key files are operator-only (process.env.MINIMAX_API_KEY_FILE).
- Tool commands get MINIMAX_API_KEY / MINIMAX_API_KEY_FILE blanked in their
  environment. This is not isolation: they run as the server's OS user.
- Failures exit with 1. HTTP 429 and MiniMax base_resp rate limits
  (1002/1039) are provider_quota; 5xx, network errors and base_resp
  1000/1001/1013 are transient_upstream. Retry-After becomes retryNotBefore.
- The run fails (non-zero exit) when the iteration cap is reached
  (minimax_iteration_cap), when the run budget expires (timedOut), when the
  same command fails 3 consecutive times (minimax_repeated_command_failure),
  or when the final text contains tool-call markup
  (minimax_tool_markup), meaning the model narrated actions it never ran.
- A wake with no task content under the default prompt template is a no-op
  (exit 0) and does not call the API.
- Cost is estimated from reported tokens x a per-model rate card. The default
  card is an unverified estimate; override it with pricing or
  MINIMAX_LOCAL_PRICING_JSON. Unknown models are recorded as unpriced.
- By default, <think>...</think> blocks are removed before logging and storage.
- Environment tests send one small "Return exactly: OK" completion (billed by
  MiniMax) and never echo secret values.
`;
