# TypeSafe runtime judgment tool

Task-bound agent runs discover `typesafe_judge` through Paperclip's run-scoped runtime MCP server. It is an optional bounded-judgment primitive, not a replacement for the agent's primary reasoning provider. Its output cannot grant permission, satisfy an approval, or override explicit/mandatory skill rules.

The tool accepts one shared `state`, a model (normally `jev-latest`), and one or more independent questions keyed by stable IDs. Supported question types are `choice`, `noul`, and `score`. Paperclip validates question schemas before sending them and validates every returned type, option/level distribution, finite range, question ID, model, and token count before returning a result.

```json
{
  "state": { "request": "The export fails, but CSV still works." },
  "model": "jev-latest",
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Choose the best handling route.",
      "criteria": { "support": "Usage help", "engineering": "Product defect", "no_match": "Neither" }
    },
    "is_blocking": {
      "type": "noul",
      "instructions": "Is there no usable workaround?"
    },
    "severity": {
      "type": "score",
      "instructions": "Rate operational severity.",
      "criteria": ["cosmetic", "degraded with workaround", "blocking"]
    }
  }
}
```

The invoking agent must have a current company-scoped `TYPESAFE_API_KEY` `secret_ref` binding in its adapter environment. Paperclip resolves it at call time, never exposes it in the tool contract, and rejects configuration changes that race an invocation. `PAPERCLIP_TYPESAFE_TOOL_ENABLED=true` is the kill switch; it is off by default. `PAPERCLIP_TYPESAFE_TIMEOUT_MS` may lower or raise the request timeout within 1–15 seconds. All failures return a code without typed answers, so callers must fall back to their existing authorized reasoning path.

Rate-limit (`429`) and overload (`529`) responses receive at most one retry. The retry honors `retry-after-ms` or `Retry-After` (seconds or an HTTP date). If neither header supplies a valid delay, the first backoff is 500 milliseconds. A delay that reaches the remaining request deadline prevents the retry. Paperclip rechecks live-run authority, the agent configuration, the credential version, and the skill catalog before sending a retry; stale authority or bindings prevent another provider call.

An explicitly requested model ID must match the response model. The documented aliases `jev-latest` and `jev-preview` may resolve to a versioned ID. See the [TypeSafe model reference](https://docs.typesafe.ai/models) and [API reference](https://docs.typesafe.ai/api).

No database migration is required. Roll back by disabling the kill switch; code rollback removes the tool definition and endpoint.
