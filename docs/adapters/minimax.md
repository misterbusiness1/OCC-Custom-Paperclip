---
title: MiniMax (external)
summary: In-repo external adapter that calls the MiniMax chat completions API directly, with an optional bash tool
---

The `minimax_local` adapter calls the MiniMax OpenAI-compatible chat completions API (`POST {baseUrl}/chat/completions`) directly. It does not start a CLI and does not route through OpenCode.

It ships in this repository as an **external adapter package** at `packages/adapters/minimax` (`@paperclipai/minimax-paperclip-adapter`, private, not published). It is **not built in**: it is not registered in the server or UI adapter registries, and Paperclip only loads it after an operator installs it through the external-adapter plugin system.

It runs in two modes:

- **Chat mode** (default): one completion per heartbeat, returned as the run output.
- **Tool mode** (opt-in, `toolsEnabled: true`): a native tool-calling loop with one `bash` tool, until the model answers without requesting tools.

The type key is `minimax_local` so agents created by the original MiniMax fork keep working once the adapter is installed. The name is historical: the adapter calls a remote HTTP API.

## Enable the adapter

Pick one of these. All of them register the package directory with Paperclip's plugin store (`$PAPERCLIP_HOME/adapter-plugins.json`, default `~/.paperclip/adapter-plugins.json`).

1. **UI (preferred):** Instance Settings → Adapters → Install adapter → **Local path**, then enter the absolute path of the package directory:
   - source checkout: `<repo>/packages/adapters/minimax`
   - Docker image: `/app/packages/adapters/minimax`
2. **CLI or API:**

   ```sh
   paperclipai adapter install --payload-json '{"packageName":"/app/packages/adapters/minimax","isLocalPath":true}'

   # or
   curl -X POST http://localhost:3100/api/adapters/install \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"packageName":"/app/packages/adapters/minimax","isLocalPath":true}'
   ```

   Both require instance-admin access.
3. **Plugin store file:** add a record to `$PAPERCLIP_HOME/adapter-plugins.json` and restart the server:

   ```json
   [
     {
       "packageName": "@paperclipai/minimax-paperclip-adapter",
       "localPath": "/app/packages/adapters/minimax",
       "type": "minimax_local",
       "installedAt": "2026-01-01T00:00:00.000Z"
     }
   ]
   ```

If you restrict adapters with `PAPERCLIP_ADAPTERS` / `PAPERCLIP_ADAPTERS_FILE`, add `minimax_local` there too.

The package exports TypeScript source (`exports["."]` is `./src/index.ts`). The server loads it through the `tsx` loader, which both `pnpm dev` and the Docker image's `CMD` (`node --import tsx/dist/loader.mjs`) provide. A server started with plain `node` and no `tsx` loader cannot import it.

Then, for each agent:

1. Create a company secret holding your MiniMax API key.
2. On the agent, bind that secret to the environment variable `MINIMAX_API_KEY`.
3. Click **Test** (see [Environment test](#environment-test)).

## Configuration fields

The schema-driven form shows the fields marked *(form)*. The rest can be set in the agent's adapter config JSON.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` *(form)* | string | `MiniMax-M3` | `MiniMax-M3`, `MiniMax-M2.7` or `MiniMax-M2.7-highspeed`. Mis-cased or provider-prefixed ids are normalized; unknown ids pass through. |
| `primaryModel` | string | `model` | Explicit request-model override. |
| `baseUrl` *(form)* | string | `https://api.minimax.io/v1` | API base URL. A custom endpoint must use `https` (loopback hosts excepted) and its own `env.MINIMAX_API_KEY`. |
| `temperature` *(form)* | number | `0.2` | Sampling temperature. |
| `max_completion_tokens` / `maxTokens` *(form)* | number | `8192` | Completion token limit. |
| `stripThink` *(form)* | boolean | `true` | Strip `<think>...</think>` blocks from logged and stored output. |
| `toolsEnabled` *(form)* | boolean | `false` | Enable the `bash` tool loop. **Off by default.** |
| `maxToolIterations` *(form)* | number | `25` | Cap on send/execute round trips. Reaching it **fails** the run. |
| `toolCommandTimeoutSec` *(form)* | number | `120` | Per-command timeout. |
| `toolOutputLimitBytes` | number | `32768` | Combined stdout+stderr cap per command before truncation. |
| `timeoutSec` *(form)* | number | `0` (off) | Whole-run wall-clock budget including tool execution. |
| `requestTimeoutSec` | number | `300` | Per-request timeout for each `/chat/completions` call. Always applies. |
| `instructionsFilePath` *(form)* | string | — | Markdown instructions file prepended to the prompt. |
| `promptTemplate` | string | Paperclip default | Heartbeat prompt template. |
| `pricing` | object | built-in estimate | Per-model USD rate overrides. See [Cost and budgets](#cost-and-budgets). |
| `env.MINIMAX_API_KEY` | secret ref / string | — | MiniMax API key. Bind a company secret. |

Operator-level environment variables on the Paperclip server:

| Variable | Effect |
|----------|--------|
| `MINIMAX_API_KEY` / `MINIMAX_API_KEY_FILE` | Shared host key, used only when the agent has no `env.MINIMAX_API_KEY` and only for the default endpoint. |
| `MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS` | Comma-separated allowlist of hosts for a custom `baseUrl`. |
| `MINIMAX_LOCAL_PRICING_JSON` | Rate-card overrides, same shape as `pricing`. |
| `MINIMAX_LOCAL_TOOLS_ENABLED` | `true`/`false` forces tool mode on or off for every MiniMax agent, overriding `toolsEnabled`. |
| `MINIMAX_LOCAL_MAX_TOOL_ITERATIONS` | Overrides `maxToolIterations` for every MiniMax agent. |

## Run outcomes

| Outcome | Exit | `errorCode` / `errorFamily` |
|---------|------|-----------------------------|
| Final answer | `0` | — |
| Wake with no task content under the default prompt template (no issue, comment or handoff) | `0`, no API call | — (`resultJson.stopReason: "contentless_wake"`) |
| Blank final answer (for example only `<think>` content) | `0` | — (`resultJson.stopReason: "empty_output"`) |
| Tool iteration cap reached | `1` | `minimax_iteration_cap` |
| Same command failed 3 times in a row | `1` | `minimax_repeated_command_failure` |
| Final text contains tool-call markup (the model narrated actions it never ran) | `1` | `minimax_tool_markup` |
| `timeoutSec` budget expired | `1`, `timedOut` | `minimax_run_budget` |
| A single request timed out | `1`, `timedOut` | `minimax_request_timeout` / `transient_upstream` |
| HTTP 200 with an empty or unparseable payload | `1` | `minimax_empty_completion` |
| HTTP 429 | `429` | `http_429` / `provider_quota` |
| HTTP 5xx or a network failure | status or `1` | `transient_upstream` |
| Other HTTP errors (for example 401, 402) | status | `http_<status>` |
| Missing key or refused `baseUrl` | `1` | `minimax_credentials` / `minimax_base_url` |

Token usage and cost are recorded on every outcome that reached the API, including failures.

These defaults differ from the original MiniMax fork, which enabled tools by default, capped at 50 iterations and reported the cap, tool-markup and repeated-failure outcomes as successful runs. Agents migrated from that fork that rely on the bash tool must set `toolsEnabled: true`. Without tools an issue-scoped agent cannot change its issue's status itself; Paperclip's run-liveness and re-wake handling covers that case. This adapter does not PATCH issue status on the agent's behalf.

## Tool mode

With `toolsEnabled: true` the model gets one `bash` tool. Each command runs in the run's execution workspace (the heartbeat-provided cwd) through the adapter-utils execution target.

- **It runs on the Paperclip host.** In this fork external adapters only get the `local` environment driver (remote drivers are limited to built-in adapters in `packages/shared/src/environment-support.ts`), so commands run as the server's OS user. They inherit the server's environment minus `PAPERCLIP_*` keys, so other host secrets (for example `DATABASE_URL` or `BETTER_AUTH_SECRET`) are visible to the commands. This matches the other local CLI adapters, and it is why tool mode is opt-in.
- Commands receive `PAPERCLIP_API_URL`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_RUN_ID`, the wake variables (`PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_*`) and the run's server-minted `PAPERCLIP_API_KEY`. Configured env cannot override these identity values.
- Commands never receive the MiniMax key: `MINIMAX_API_KEY` and `MINIMAX_API_KEY_FILE` are set to empty strings.
- Output is truncated at `toolOutputLimitBytes`; malformed tool-call arguments are replaced with `{}` in the conversation history so MiniMax does not reject the next request, and the model is told its arguments were invalid.

## Credentials and security

- **Key resolution:** `env.MINIMAX_API_KEY` (company scoped, recommended), then the host `MINIMAX_API_KEY`, then the host `MINIMAX_API_KEY_FILE`.
- **Key files are operator-only.** An agent's `env.MINIMAX_API_KEY_FILE` is ignored.
- **Custom `baseUrl`:** the shared host key is only ever sent to the default MiniMax endpoint. A custom endpoint must be `https` (or `localhost` / `127.x` / `::1`) and must use a company key; `MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS` can restrict hosts further.
- Error messages from MiniMax and network errors are passed through `redactCommandTextForLogs` before logging.

## Cost and budgets

The adapter reports `billingType: "metered_api"`, `provider` and `biller` `"minimax"`, and `usageBasis: "per_run"`. It reads `usage.prompt_tokens`, `usage.completion_tokens` and `usage.prompt_tokens_details.cached_tokens`.

`costUsd` comes from a per-model rate card (USD per 1M tokens). **The built-in card is an unverified estimate** carried over from the original fork so budgets enforce out of the box:

| Model | Input | Cached input | Output |
|-------|-------|--------------|--------|
| `MiniMax-M3` | 0.30 | 0.03 | 1.20 |
| `MiniMax-M2.7` | 0.30 | 0.03 | 1.20 |
| `MiniMax-M2.7-highspeed` | 0.50 | 0.05 | 2.20 |

Set real pricing with `adapterConfig.pricing` or `MINIMAX_LOCAL_PRICING_JSON`, for example `{ "MiniMax-M3": { "inputPerMTok": 0.3, "outputPerMTok": 1.2, "cachedInputPerMTok": 0.03 } }`. A model with no rate (an unknown id without an override) has no `costUsd`, so the cost ledger records the run as **unpriced** rather than $0. The run's invocation notes say whether the estimate or a configured rate was used.

## Environment test

The **Test** button resolves the same key and `baseUrl` as a run, then sends one small completion (`Return exactly: OK`, 45 s timeout). This is a real, billed MiniMax request. A successful HTTP response passes even if the text is not exactly `OK`. Secret values are never echoed.

## Transcript parser

The package ships `ui-parser.cjs` (contract `paperclip.adapterUiParser: 1.0.0`). It maps `[tool] $ <cmd>` to a tool call, `[tool] exit <n>` to a tool result (an error when `n` is not 0), command output to plain stdout, `[paperclip] ...` to system notes, and everything else to assistant text.
