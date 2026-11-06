# @paperclipai/minimax-paperclip-adapter

External Paperclip adapter for the `minimax_local` agent type. It calls the
MiniMax OpenAI-compatible chat completions API (`POST {baseUrl}/chat/completions`,
default `https://api.minimax.io/v1`) directly, with an optional single `bash`
tool.

This package lives in the Paperclip repository but is **not built in**. The
server and UI registries do not import it; Paperclip loads it through the
external-adapter plugin loader after an operator installs it from this
directory. It is `private` and is not published to npm.

Full documentation: [`docs/adapters/minimax.md`](../../../docs/adapters/minimax.md).

## Install

Use the absolute path of this directory (`/app/packages/adapters/minimax` in
the Docker image):

- UI: Instance Settings → Adapters → Install Adapter → Local path.
- CLI: `paperclipai adapter install --payload-json '{"packageName":"/app/packages/adapters/minimax","isLocalPath":true}'`
- API: `POST /api/adapters/install` with `{"packageName":"<abs path>","isLocalPath":true}`.
- Or add `{ "packageName": "@paperclipai/minimax-paperclip-adapter", "localPath": "<abs path>", "type": "minimax_local", "installedAt": "<iso date>" }`
  to `$PAPERCLIP_HOME/adapter-plugins.json` and restart.

Then bind a company secret to `env.MINIMAX_API_KEY` on the agent and click **Test**.

The `exports` point at TypeScript source, so the server must run under the
`tsx` loader (`pnpm dev`, or the Docker image's default `CMD`).

## Defaults worth knowing

- `toolsEnabled` is **false**. When enabled, commands run on the Paperclip host
  (external adapters only get the `local` execution driver) with the server's
  environment minus `PAPERCLIP_*` keys and with the MiniMax key blanked in
  the environment. Blanking is not isolation: commands run as the server user
  and can read host files and process environments.
- Runs are refused (`unsupported_adapter_environment`) when the agent's
  resolved environment is not local, for example an instance-default sandbox
  environment or the managed Kubernetes environment that
  `executionMode=kubernetes` forces. The server no longer falls back to
  running external adapters on the host in that case.
- `maxToolIterations` is 25. The iteration cap, repeated identical command
  failures and narrated tool-call markup fail the run with
  `minimax_iteration_cap`, `minimax_repeated_command_failure` and
  `minimax_tool_markup`.
- Failures exit with `1`. HTTP 429 is reported as
  `errorFamily: "provider_quota"`; 5xx and network failures as
  `transient_upstream`. MiniMax's in-band HTTP 200 `base_resp` errors fail as
  `minimax_api_<code>` (1002/1039 -> `provider_quota`). `Retry-After` is
  returned as `retryNotBefore` (capped at one hour).
- Only `https://api.minimax.io` receives the shared host key. A custom
  `baseUrl` needs a company key, https (or an exact loopback host) and no
  query/fragment/userinfo; the operator allowlist applies to loopback too.
  Without an allowlist, private/link-local/other non-public IP literals are
  refused (DNS names are not resolved). Redirects are never followed: a 3xx
  fails with `minimax_redirect_refused`.
- The literal API key is scrubbed from model output (summary and run log) as
  well as from error text.
- Each request timeout covers reading the body; bodies are capped at 8 MiB.
- Pricing overrides must be > 0 and <= 1000 USD/MTok (a sanity check, not a
  control); token counts are capped and cached tokens are clamped to input.
- Cost uses an **estimated** rate card for the three known models; override it
  with `MINIMAX_LOCAL_PRICING_JSON` (operator, wins) or `pricing`. Unknown
  models, and completions with no usage block, are left unpriced.
- Without tools (the default) an agent cannot record an issue disposition, so
  an issue assigned to it ends `blocked` after about three runs (see the docs).

## Layout

- `src/constants.ts`: type, defaults, models, `agentConfigurationDoc` (leaf module)
- `src/index.ts`: package entry; re-exports constants, `createServerAdapter`, `getConfigSchema`
- `src/server/`: `execute`, `testEnvironment`, response parsing, config schema
- `src/shared/`: base URL guard, credential resolution, model ids, pricing, text helpers
- `ui-parser.cjs`: hand-written CommonJS transcript parser (`paperclip.adapterUiParser` 1.0.0)

## Development

```sh
pnpm --filter @paperclipai/minimax-paperclip-adapter typecheck
pnpm --filter @paperclipai/minimax-paperclip-adapter test
```

Tests mock `fetch`; they never call the MiniMax API.
