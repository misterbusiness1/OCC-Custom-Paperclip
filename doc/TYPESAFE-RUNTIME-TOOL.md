# TypeSafe runtime judgment tool

Task-bound agent runs discover `typesafe_judge` through Paperclip's run-scoped runtime MCP server. It is an optional bounded-judgment primitive, not a replacement for the agent's primary reasoning provider. Its output cannot grant permission, satisfy an approval, or override explicit/mandatory skill rules.

## Shared operational skill

The canonical usage instructions are [typesafe-judge](../skills/typesafe-judge/SKILL.md).
They explain when a bounded judgment helps, how to call the existing tool, and how
to handle unavailable advice without bypassing task authority. Its
[pilot.json](../skills/typesafe-judge/pilot.json) is the single source for the
synthetic pilot questions and criteria. The official vendor `typesafe-ai` skill
remains the developer reference for API work.

The runtime skill ships through the existing repo-root `skills/` inventory as
`paperclipai/paperclip/typesafe-judge`. It is optional: library availability does
not attach it to an agent, enable the tool, or grant credentials. See
[installation and pilot verification](TYPESAFE-SHARED-SKILL.md) for the controlled
setup. Automatic skill suggestions and background classification remain separate;
further development is paused pending demonstrated benefit from direct use.

## Runtime contract

The tool accepts one shared `state`, a model (normally `jev-latest`), and one or more independent questions keyed by stable IDs. Supported question types are `choice`, `noul`, and `score`. Paperclip validates question schemas before sending them and validates every returned type, option/level distribution, finite range, question ID, model, and token count before returning a result.

Use [the shared pilot input](../skills/typesafe-judge/pilot.json) for a complete schema-valid example covering all three question types.

The tool's MCP input schema describes the question contract, because an agent can discover the tool without loading the skill. Through MCP, malformed arguments come back as a tool result with `isError: true` and `{"ok":false,"error":{"code":"invalid_input","retryable":false,"issues":[...]}}`, where each issue names a path and a reason. An issue never echoes an input value; its path does name the caller's own question ID. The agent corrects the call; no provider request is made. A Noul `criteria` of `null` is treated as omitted. The REST endpoint keeps HTTP `400` for malformed input. The MCP endpoint is POST only: it answers the stream probe (`GET`) with `405`, answers `ping`, and accepts notifications with `202`. A body that is not one JSON-RPC request object gets `400`.

With the kill switch off, every call returns `disabled`, a malformed one included: the agent is not asked to correct a call that cannot run. Nothing is sent to the provider. The tool stays in the tool list.

The two connection tools on the same endpoint follow the same rule for outcomes the agent should read. Malformed arguments, an unknown or unavailable service, and a declined request come back as a tool result with `isError: true` and the message. Authentication, lost run authority and server faults stay HTTP errors.

The invoking agent must have a current company-scoped `TYPESAFE_API_KEY` `secret_ref` binding in its adapter environment. Paperclip resolves it at call time, never exposes it in the tool contract, and rejects configuration changes that race an invocation. `PAPERCLIP_TYPESAFE_TOOL_ENABLED=true` is the kill switch; it is off by default. `PAPERCLIP_TYPESAFE_TIMEOUT_MS` may lower or raise the request timeout within 1–15 seconds. All failures return a code without typed answers, so callers must fall back to their existing authorized reasoning path.

The binding lives in the adapter environment, so Paperclip also resolves it into the agent process environment like any other adapter secret. An agent with a shell can read it there. The rule that agents call TypeSafe only through `typesafe_judge` is therefore a policy the skill states, not a technical barrier. Bind the key only to agents that are trusted with it.

Rate-limit (`429`) and overload (`529`) responses receive at most one retry. The retry honors `retry-after-ms` or `Retry-After` (seconds or an HTTP date). If neither header supplies a valid delay, the first backoff is 500 milliseconds. A delay that reaches the remaining request deadline prevents the retry. Paperclip rechecks live-run authority, the agent configuration, the credential version, and the skill catalog before sending a retry; stale authority or bindings prevent another provider call.

An explicitly requested model ID must match the response model. The documented aliases `jev-latest` and `jev-preview` must return a resolved `jev-MAJOR.MINOR.PATCH` ID, such as `jev-1.13.0`; echoed aliases, unrelated model names, and malformed versions are rejected. Aliases can advance to newer versions without a client release. See the [TypeSafe model reference](https://docs.typesafe.ai/models) and [API reference](https://docs.typesafe.ai/api).

No database migration is required. Roll back by disabling the kill switch; code rollback removes the tool definition and endpoint.
