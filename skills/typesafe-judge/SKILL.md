---
name: typesafe-judge
description: >
  Use Paperclip's typesafe_judge runtime tool for a focused judgment from supplied
  evidence: classify into defined categories, choose between explicit options,
  score against a rubric, or evaluate a true/false statement. Use during an
  authorized task when this optional judgment helps the next decision.
---

# TypeSafe judgments in Paperclip

Paperclip owns task execution, permissions, approvals, credentials, and budgets.
Use `typesafe_judge` as supporting information within your current task. Keep
your primary reasoning model and the existing authorized workflow.

## Choose the right tool

Use TypeSafe for semantic judgments over supplied information:

- **Choice:** classify or select one of explicit options. Include a no-match
  option when the candidates might not cover the input.
- **Score:** assess a single dimension against ordered, concrete rubric levels.
- **Noul:** evaluate one focused true/false statement from supplied evidence.

Use ordinary tools for calculations, exact lookups, compilation, linting, tests,
schema validation, and deterministic permission or budget rules. Verify external
actions through their actual execution results. A judgment cannot prove that a
message was sent, a test passed, or an approval exists.

## Make the call

1. Discover `typesafe_judge` in this run's tool list and load this skill. Its
   presence in documentation alone does not mean this runtime can call it.
   Some runtimes receive Paperclip's runtime tools through the environment
   instead of the tool list: there, `PAPERCLIP_RUNTIME_TOOLS_AVAILABLE` names
   the tool, and `PAPERCLIP_RUNTIME_TOOLS_TYPESAFE_JUDGE_URL` accepts the same
   input as a JSON `POST` authorized with this run's
   `PAPERCLIP_RUNTIME_TOOLS_TOKEN` as the bearer. That is the same governed
   gateway. Never print or store the token.
2. Supply minimal, non-sensitive context in `state`; it is sent to the external
   TypeSafe provider. Exclude credentials and unrelated data. Private customer
   information requires explicit authorization for that disclosure; otherwise
   use a non-sensitive summary or continue with ordinary tools.
3. Send `questions` keyed by stable IDs, with `type` and `instructions` for each:
   - `choice`: `criteria` is an object mapping option IDs to their meanings.
   - `score`: `criteria` is an array of 2–10 ordered levels, lowest first.
   - `noul`: `criteria` is optional; if supplied, use `true` and `false` meanings.
   Question IDs start with a letter and contain letters, numbers, `_`, or `-`.
   Each question must stand alone; questions in one call cannot see each other's
   answers. Batch only independent questions about the same state.
4. Invoke the existing tool once. Supply `model` explicitly: use the task's model
   pin if required, otherwise `jev-latest`. The runtime owns timeout and its
   bounded retry. Do not add a retry loop, even when `error.retryable` is true.

For synthetic qualification, use [pilot.json](pilot.json) unchanged. It is the
single source for the pilot state, questions, and rubric. For recurring real
work, keep that task's questions and criteria in one small shared task file.

## Consume the structured result

- With `ok: true`, inspect `answers` by question ID and type. Choice returns
  `choice`, `probabilities`, and `confidence`. Score returns `score`, `legend`,
  `probabilities`, and `confidence`; its range is zero through the last level
  index. Noul returns `noul`, the probability of yes, with no separate confidence.
  Use `model`, `usage`, and `latencyMs` for evidence when available.
- Probabilities and confidence do not guarantee correctness. Compare the answer
  with supplied evidence; report uncertainty when it affects the task. Keep the
  task's existing review and approval gates.
- With `ok: false`, inspect `error.code`. Optional advice that is unavailable,
  malformed, stale, or inconclusive supplies no usable judgment. Continue through
  the existing authorized workflow and report the limitation when relevant.
- If task/run authority is revoked or the control plane tells you to stop, stop
  work under that authority. This is not an optional-advice fallback.
- If discovery fails, the tool is disabled, or credentials are denied, report
  the missing capability to the operator. Never bypass it with a separate API
  call, credential lookup, script, or another agent's authority.

The official `typesafe-ai` developer skill explains the vendor API and patterns.
This skill governs operational calls inside Paperclip; the company-scoped managed
`secret_ref` binding stays with the runtime, never in these instructions.
