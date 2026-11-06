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
3. **Plugin store file:** add a record to `$PAPERCLIP_HOME/adapter-plugins.json` and restart the server. This is the same record options 1 and 2 write; for a local-path install `packageName` is the directory path, not the npm name:

   ```json
   [
     {
       "packageName": "/app/packages/adapters/minimax",
       "localPath": "/app/packages/adapters/minimax",
       "type": "minimax_local",
       "installedAt": "2026-01-01T00:00:00.000Z"
     }
   ]
   ```

   The server resolves the package from `localPath`, so `packageName` only affects how the record is shown. The adapter list (`GET /api/adapters`) labels external adapters by their type, so it shows `minimax_local` whichever `packageName` is stored.

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
| `baseUrl` *(form)* | string | `https://api.minimax.io/v1` | API base URL. A custom endpoint must use `https` (loopback IP literals and `localhost` excepted), must have no query string, fragment or credentials, and must use its own `env.MINIMAX_API_KEY`. See [Credentials and security](#credentials-and-security). |
| `temperature` *(form)* | number | `0.2` | Sampling temperature. |
| `max_completion_tokens` / `maxTokens` *(form)* | number | `8192` | Completion token limit. |
| `stripThink` *(form)* | boolean | `true` | Strip `<think>...</think>` blocks from logged and stored output. |
| `toolsEnabled` *(form)* | boolean | `false` | Enable the `bash` tool loop. **Off by default.** |
| `maxToolIterations` *(form)* | number | `25` | Cap on send/execute round trips. Reaching it **fails** the run. |
| `toolCommandTimeoutSec` *(form)* | number | `120` | Per-command timeout. |
| `toolOutputLimitBytes` | number | `32768` | Combined stdout+stderr cap per command, in UTF-8 bytes, before truncation. |
| `timeoutSec` *(form)* | number | `0` (off) | Whole-run wall-clock budget including tool execution. |
| `requestTimeoutSec` | number | `300` | Per-request timeout for each `/chat/completions` call, covering both the response headers and reading the body. Always applies. |
| `instructionsFilePath` *(form)* | string | — | Markdown instructions file prepended to the prompt. |
| `promptTemplate` | string | Paperclip default | Heartbeat prompt template. |
| `pricing` | object | built-in estimate | Per-model USD rate overrides. See [Cost and budgets](#cost-and-budgets). |
| `env.MINIMAX_API_KEY` | secret ref / string | — | MiniMax API key. Bind a company secret. |

Operator-level environment variables on the Paperclip server:

| Variable | Effect |
|----------|--------|
| `MINIMAX_API_KEY` / `MINIMAX_API_KEY_FILE` | Shared host key, used only when the agent has no `env.MINIMAX_API_KEY` and only for the default endpoint. |
| `MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS` | Comma-separated allowlist of hosts (`host` or `host:port`) for a custom `baseUrl`. Unset by default. When set it applies to every custom host, loopback included, and only listed hosts are accepted. It is also the only way to allow a private or link-local IP literal. |
| `MINIMAX_LOCAL_PRICING_JSON` | Rate-card overrides, same shape as `pricing`. Takes precedence over an agent's `pricing` for every model it lists. |
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
| A single request timed out (including a response body that stalls after the headers) | `1`, `timedOut` | `minimax_request_timeout` / `transient_upstream` |
| Response body larger than 8 MiB | `1` | `minimax_response_too_large` |
| HTTP 200 with an empty or unparseable payload | `1` | `minimax_empty_completion` |
| HTTP 200 with a non-zero `base_resp.status_code` (MiniMax's in-band error) | `1` | `minimax_api_<code>`; `provider_quota` for 1002 / 1039 (rate limits), `transient_upstream` for 1000 / 1001 / 1013, none otherwise (for example 1004 auth, 1008 balance) |
| HTTP 429 | `1` | `http_429` / `provider_quota` |
| HTTP 5xx or a network failure | `1` | `http_<status>` or `minimax_error` / `transient_upstream` |
| Other HTTP errors (for example 401, 402) | `1` | `http_<status>` |
| The endpoint answered with a redirect (3xx); redirects are never followed | `1` | `minimax_redirect_refused` |
| Missing key or refused `baseUrl` | `1` | `minimax_credentials` / `minimax_base_url` |

The exit code is always a process-style `1` for a failure; the HTTP status is in `errorCode` and `errorMeta.httpStatus`. For a retryable failure (`provider_quota` or `transient_upstream`), a `Retry-After` header (seconds or an HTTP date, capped at one hour) is returned as `retryNotBefore`, which the heartbeat uses instead of its default backoff. The error message includes MiniMax's own `error.message` or `base_resp.status_msg`, redacted.

Token usage and cost are recorded on every outcome that reached the API and returned usage, including failures. If a successful completion carries no usage block (no non-negative `prompt_tokens` or `completion_tokens`), the run has no `costUsd` and is ledgered as **unpriced** rather than $0. Cached tokens are clamped to the reported input tokens. The final answer kept as the run summary is capped at 100,000 characters.

These defaults differ from the original MiniMax fork, which enabled tools by default, capped at 50 iterations and reported the cap, tool-markup and repeated-failure outcomes as successful runs. Agents migrated from that fork that rely on the bash tool must set `toolsEnabled: true`. This adapter does not PATCH issue status on the agent's behalf.

**Issues assigned to a chat-only agent end `blocked`.** Without tools (the default), the agent cannot call the Paperclip API, so it cannot record an issue disposition (`done`, `in_review`, `blocked` and so on). Paperclip's recovery handling then treats each successful run as missing a disposition: it wakes the agent once more to finish the handoff (`finish_successful_run_handoff`, one attempt by default), then queues a source-scoped recovery action, and finally moves the issue to `blocked` for a recovery owner. In review testing against a local stub, assigning one issue to a `toolsEnabled: false` agent produced three billed completions (`issue_assigned`, `finish_successful_run_handoff`, `source_scoped_recovery_action`) and the issue ended `blocked`; with a bad key (HTTP 401) it produced four failed runs. Use chat-only mode for on-demand or routine work that does not need an issue disposition, and set `toolsEnabled: true` for agents that work issues.

## Tool mode

With `toolsEnabled: true` the model gets one `bash` tool. Each command runs in the run's execution workspace (the heartbeat-provided cwd) through the adapter-utils execution target.

- **It runs on the Paperclip host.** In this fork external adapters only get the `local` environment driver (remote drivers are limited to built-in adapters in `packages/shared/src/environment-support.ts`), so commands run as the server's OS user. They inherit the server's environment minus `PAPERCLIP_*` keys, so other host secrets (for example `DATABASE_URL` or `BETTER_AUTH_SECRET`) are visible to the commands. This matches the other local CLI adapters, and it is why tool mode is opt-in.
- **Non-local environments are refused.** When the run's resolved environment is not `local` (an instance-default SSH or sandbox environment, or the managed Kubernetes environment that `executionMode=kubernetes` forces), the server fails the run with `unsupported_adapter_environment` before acquiring a lease, instead of silently running the adapter on the host. This applies to every external adapter without remote environment support; built-in adapters are unchanged. On a Kubernetes-forced instance this means the MiniMax adapter cannot run at all.
- Commands receive `PAPERCLIP_API_URL`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_RUN_ID`, the wake variables (`PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_*`) and the run's server-minted `PAPERCLIP_API_KEY`. Configured env cannot override these identity values.
- `MINIMAX_API_KEY` and `MINIMAX_API_KEY_FILE` are set to empty strings in the command environment. This keeps the key out of the environment only. It is **not** an isolation boundary: commands run as the server's OS user, so they can still read a host key file or `/proc/<server pid>/environ`. Treat `toolsEnabled: true` as granting host-level access, including to a shared host MiniMax key.
- Output is truncated at `toolOutputLimitBytes` (UTF-8 bytes); malformed tool-call arguments are replaced with `{}` in the conversation history so MiniMax does not reject the next request, and the model is told its arguments were invalid.

## Credentials and security

- **Key resolution:** `env.MINIMAX_API_KEY` (company scoped, recommended), then the host `MINIMAX_API_KEY`, then the host `MINIMAX_API_KEY_FILE`.
- **Key files are operator-only.** An agent's `env.MINIMAX_API_KEY_FILE` is ignored.
- **Default endpoint:** only `https://api.minimax.io/...` counts as the default endpoint. `http://api.minimax.io` is treated as a custom endpoint and refused, so the shared host key is never sent in cleartext.
- **Custom `baseUrl`:** the shared host key is only ever sent to the default MiniMax endpoint. A custom endpoint must use a company key and must be `https`, except for `localhost` or a loopback IP literal (`127.0.0.0/8`, `::1`). Loopback is an exact match: a DNS name such as `127.example.com` is not loopback. A query string, fragment or `user:pass@` in the URL is refused, because it would neutralise the appended `/chat/completions` path. If `MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS` is set, only the listed hosts are allowed, loopback included.
- **Non-public IP literals are refused by default:** with no allowlist, a custom `baseUrl` whose host is a private (`10/8`, `172.16/12`, `192.168/16`), carrier-grade NAT (`100.64/10`), link-local (`169.254/16`, including cloud metadata at `169.254.169.254`; `fe80::/10`), unique-local (`fc00::/7`), unspecified or multicast IP literal is refused, including its IPv4-mapped IPv6 form. Add the host to the allowlist to use it. DNS names are **not** resolved, so a public-looking name that resolves to a private address is not caught; set the allowlist when you need a strict posture.
- **Redirects are never followed:** both the run and the environment test send requests with `redirect: "manual"`. A 3xx answer fails the request (`minimax_redirect_refused`) and nothing is sent to the `Location` host, so a redirect cannot carry the prompt to a host the `baseUrl` checks never saw.
- **Bounded responses:** the response body is streamed and read under the request timeout, with an 8 MiB cap per completion (256 KiB for the environment test).
- **Pricing overrides are range-checked:** `inputPerMTok` and `outputPerMTok` must be greater than 0 and at most 1000; `cachedInputPerMTok` must be at least 0 and is capped at the input rate. An invalid override is ignored (the next source, the built-in card, or unpriced applies). This is a sanity check, not a control: anyone who can edit the agent's config (`agent_config:update`) can set a tiny positive `pricing` rate and under-record cost. When the rate must be authoritative, set it in `MINIMAX_LOCAL_PRICING_JSON`, which wins over the agent's `pricing`. Reported token counts are capped at 10M per completion and 100M per run.
- Error messages from MiniMax and network errors are passed through `redactCommandTextForLogs`, and the literal API key is scrubbed, before logging. Successful model output (the final answer and any narration between tool calls) has the literal API key scrubbed too (keys of 8 characters or more), so an endpoint that echoes the `Authorization` header cannot put the key into the run summary or run log.

## Cost and budgets

The adapter reports `billingType: "metered_api"`, `provider` and `biller` `"minimax"`, and `usageBasis: "per_run"`. It reads `usage.prompt_tokens`, `usage.completion_tokens` and `usage.prompt_tokens_details.cached_tokens`.

`costUsd` comes from a per-model rate card (USD per 1M tokens). **The built-in card is an unverified estimate** carried over from the original fork so budgets enforce out of the box:

| Model | Input | Cached input | Output |
|-------|-------|--------------|--------|
| `MiniMax-M3` | 0.30 | 0.03 | 1.20 |
| `MiniMax-M2.7` | 0.30 | 0.03 | 1.20 |
| `MiniMax-M2.7-highspeed` | 0.50 | 0.05 | 2.20 |

The heartbeat records cost in whole cents per run (`cost_cents`, rounded), so a typical small MiniMax run that costs under about $0.005 is recorded as 0 cents. This is platform behaviour, but it means budgets undercount many cheap heartbeats.

Set real pricing with `MINIMAX_LOCAL_PRICING_JSON` (operator, takes precedence) or `adapterConfig.pricing`, for example `{ "MiniMax-M3": { "inputPerMTok": 0.3, "outputPerMTok": 1.2, "cachedInputPerMTok": 0.03 } }`. A model with no rate (an unknown id without an override) has no `costUsd`, so the cost ledger records the run as **unpriced** rather than $0. The run's invocation notes say whether the estimate or a configured rate was used.

## Environment test

The **Test** button resolves the same key, `baseUrl` and model (`primaryModel`, then `model`) as a run, then sends one small completion (`Return exactly: OK`, 45 s timeout). This is a real, billed MiniMax request. A successful completion passes even if the text is not exactly `OK`; an HTTP 200 without a completion, or with a non-zero `base_resp.status_code`, fails. Check details never include the raw response body: on failure they show only a structured error message (`error.message`, `message` or `base_resp.status_msg`), redacted and truncated. Secret values are never echoed.

## Transcript parser

The package ships `ui-parser.cjs` (contract `paperclip.adapterUiParser: 1.0.0`). It maps `[tool] $ <cmd>` to a tool call, `[tool] exit <n>` to a tool result (an error when `n` is not 0), command output to plain stdout, `[paperclip] ...` to system notes, and everything else to assistant text.
