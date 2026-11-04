import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  describeAdapterExecutionTarget,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  runAdapterExecutionTargetShellCommand,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  redactCommandTextForLogs,
  renderPaperclipWakePrompt,
  renderTemplate,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_MINIMAX_LOCAL_MAX_COMPLETION_TOKENS,
  DEFAULT_MINIMAX_LOCAL_MAX_TOOL_ITERATIONS,
  DEFAULT_MINIMAX_LOCAL_MODEL,
  DEFAULT_MINIMAX_LOCAL_REQUEST_TIMEOUT_SEC,
  DEFAULT_MINIMAX_LOCAL_STRIP_THINK,
  DEFAULT_MINIMAX_LOCAL_TEMPERATURE,
  DEFAULT_MINIMAX_LOCAL_TOOL_COMMAND_TIMEOUT_SEC,
  DEFAULT_MINIMAX_LOCAL_TOOL_OUTPUT_LIMIT_BYTES,
  DEFAULT_MINIMAX_LOCAL_TOOLS_ENABLED,
  MINIMAX_LOCAL_MAX_FINAL_TEXT_CHARS,
  MINIMAX_LOCAL_MAX_RESPONSE_BYTES,
} from "../constants.js";
import { resolveBaseUrl, validateBaseUrlForCredential } from "../shared/base-url.js";
import { resolveMiniMaxCredential } from "../shared/credentials.js";
import { normalizeMiniMaxModel } from "../shared/model.js";
import { computeMiniMaxCostUsd, hasConfiguredMiniMaxRate } from "../shared/pricing.js";
import { parseRetryAfter, readResponseTextCapped } from "../shared/http.js";
import { applyStripThink } from "../shared/text.js";
import { firstNonEmptyString } from "../shared/util.js";
import {
  addBoundedTokens,
  classifyBaseRespError,
  extractAssistantTurn,
  extractUsage,
  readBaseRespError,
  sanitizeAssistantMessageForHistory,
} from "./response.js";

// ---------------------------------------------------------------------------
// Tool calling
//
// The adapter exposes exactly one tool ("bash") through MiniMax's
// OpenAI-compatible function-calling API and runs a send -> execute -> send
// loop until the model finishes without requesting tools. Commands run through
// the adapter-utils execution target in the run's execution-workspace cwd. In
// this fork external adapters only receive the "local" execution driver
// (packages/shared/src/environment-support.ts limits remote drivers to the
// built-in adapters), so in practice commands run on the Paperclip host. The
// remote branches are kept so the adapter keeps working if that changes. A
// model that emits tool-call *markup as plain text* (instead of structured
// tool_calls) is a protocol failure and the run fails.
// ---------------------------------------------------------------------------

const BASH_TOOL = {
  type: "function",
  function: {
    name: "bash",
    description:
      "Execute a shell command in the run's working directory. Returns combined " +
      "stdout+stderr (truncated if large) and the exit code. Use this for all " +
      "filesystem, CLI, and API interactions.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
      },
      required: ["command"],
    },
  },
} as const;

// Matches the failure signatures observed in production when tool definitions
// are absent and the model improvises tool syntax as prose.
export const TOOL_MARKUP_PATTERN = /<tool_call>|<invoke\b|\]<\]minimax\[>\[/i;

const MAX_CONSECUTIVE_IDENTICAL_FAILURES = 3;

async function readInstructionsPrefix(
  instructionsFilePath: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<string> {
  if (!instructionsFilePath) return "";
  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    return [
      contents.trim(),
      "",
      `The above agent instructions were loaded from ${instructionsFilePath}. Resolve relative file references from ${instructionsDir}.`,
    ].join("\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await onLog(
      "stdout",
      `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
    );
    return "";
  }
}

interface BuildErrorOptions {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
  transient?: boolean;
  timedOut?: boolean;
  // Explicit family (e.g. from a MiniMax base_resp code); overrides the
  // HTTP-status classification when set.
  family?: AdapterExecutionResult["errorFamily"];
  retryNotBefore?: string | null;
}

// HTTP 429 is MiniMax's rate-limit / quota response: classify it as
// provider_quota so the platform's quota handling applies. 5xx responses and
// connection-level failures are transient upstream errors.
function classifyErrorFamily(
  status: number | undefined,
  transient: boolean | undefined,
): AdapterExecutionResult["errorFamily"] {
  if (status === 429) return "provider_quota";
  const isTransient = transient ?? (typeof status === "number" && status >= 500);
  return isTransient ? "transient_upstream" : null;
}

// exitCode is always a process-style 1 for a failure; the HTTP status is
// carried in errorCode (http_<status>) and errorMeta.httpStatus instead.
function buildErrorResult(message: string, options: BuildErrorOptions = {}): AdapterExecutionResult {
  const { status, code, details, transient, timedOut, family, retryNotBefore } = options;
  const errorMeta = {
    ...(details ?? {}),
    ...(typeof status === "number" ? { httpStatus: status } : {}),
  };
  return {
    exitCode: 1,
    signal: null,
    timedOut: timedOut ?? false,
    errorMessage: message,
    errorCode: code ?? (typeof status === "number" ? `http_${status}` : "minimax_error"),
    errorFamily: family !== undefined ? family : classifyErrorFamily(status, transient),
    ...(Object.keys(errorMeta).length > 0 ? { errorMeta } : {}),
    ...(retryNotBefore
      ? { retryNotBefore, resultJson: { retryNotBefore } }
      : {}),
  };
}

function truncateText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[output truncated at ${limit} characters]`;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const rawEnv = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);

  // Prompt-rendering + tool-execution cwd. The run's execution-workspace
  // worktree (context.paperclipWorkspace.cwd) is the source of truth so file
  // writes land where cross-run persistence expects them; config.cwd is only a
  // fallback for agents that pin one explicitly.
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = firstNonEmptyString(config.cwd, config.workingDirectory) ?? "";
  const cwd = workspaceCwd || configuredCwd || process.cwd();

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsPrefix = await readInstructionsPrefix(instructionsFilePath, onLog);
  const model = normalizeMiniMaxModel(firstNonEmptyString(config.primaryModel, config.model));
  const resolvedBaseUrl = resolveBaseUrl(config);
  const temperature = asNumber(config.temperature, DEFAULT_MINIMAX_LOCAL_TEMPERATURE);
  const maxCompletionTokens = Math.max(
    1,
    Math.trunc(
      asNumber(
        config.max_completion_tokens,
        asNumber(config.maxTokens, DEFAULT_MINIMAX_LOCAL_MAX_COMPLETION_TOKENS),
      ),
    ),
  );
  const stripThink =
    config.stripThink === undefined ? DEFAULT_MINIMAX_LOCAL_STRIP_THINK : config.stripThink !== false;
  // Operator global overrides via host env take precedence over per-agent
  // config, so tool behavior can be tuned fleet-wide from the server env.
  const envTools = (process.env.MINIMAX_LOCAL_TOOLS_ENABLED ?? "").trim().toLowerCase();
  const toolsEnabled =
    envTools === "true" || envTools === "1"
      ? true
      : envTools === "false" || envTools === "0"
        ? false
        : config.toolsEnabled === undefined
          ? DEFAULT_MINIMAX_LOCAL_TOOLS_ENABLED
          : config.toolsEnabled !== false;
  const envMaxIters = asNumber(process.env.MINIMAX_LOCAL_MAX_TOOL_ITERATIONS, Number.NaN);
  const maxToolIterations = Math.max(
    1,
    Math.trunc(
      Number.isFinite(envMaxIters)
        ? envMaxIters
        : asNumber(config.maxToolIterations, DEFAULT_MINIMAX_LOCAL_MAX_TOOL_ITERATIONS),
    ),
  );
  const toolCommandTimeoutSec = Math.max(
    1,
    Math.trunc(asNumber(config.toolCommandTimeoutSec, DEFAULT_MINIMAX_LOCAL_TOOL_COMMAND_TIMEOUT_SEC)),
  );
  const toolOutputLimitBytes = Math.max(
    1024,
    Math.trunc(asNumber(config.toolOutputLimitBytes, DEFAULT_MINIMAX_LOCAL_TOOL_OUTPUT_LIMIT_BYTES)),
  );
  const timeoutSec = Math.max(0, Math.trunc(asNumber(config.timeoutSec, 0)));
  const requestTimeoutSec = Math.max(
    1,
    Math.trunc(asNumber(config.requestTimeoutSec, DEFAULT_MINIMAX_LOCAL_REQUEST_TIMEOUT_SEC)),
  );
  const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : null;

  // Tool-command environment. The bash tool MUST carry the same Paperclip agent
  // environment every CLI adapter provides, or the agent cannot reach the
  // runtime API (fetch its issue, comment, set a disposition). buildPaperclipEnv
  // supplies PAPERCLIP_API_URL / PAPERCLIP_AGENT_ID / PAPERCLIP_COMPANY_ID;
  // ctx.authToken is the per-run credential the runtime API authenticates with.
  // The heartbeat strips any configured PAPERCLIP_API_KEY binding
  // (FORBIDDEN_ENV_BINDING_KEYS), so the server-minted token is always used.
  // The wake-context vars tell the agent which issue it is on.
  const paperclipEnv = buildPaperclipEnv({ id: agent.id, companyId: agent.companyId });
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  const wakeTaskId = firstNonEmptyString(context.taskId, context.issueId);
  const wakeReason = asString(context.wakeReason, "").trim();
  const wakeCommentId = firstNonEmptyString(context.wakeCommentId, context.commentId);
  // Blank the MiniMax credential vars in the tool env (overriding, not
  // deleting, so nothing inherited re-introduces them). This only keeps the
  // key out of the tool's ENVIRONMENT; it is NOT an isolation boundary. Tool
  // commands run as the server's OS user on the local host, so they can still
  // read MINIMAX_API_KEY_FILE or /proc/<server pid>/environ, along with other
  // host secrets. Treat toolsEnabled as granting host-level access.
  const toolEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...env,
    // Authenticated runtime identity is server-minted and must win over every
    // configured adapter value, including an attempted selector/binding spoof.
    ...paperclipEnv,
    PAPERCLIP_RUN_ID: runId,
    ...(wakeTaskId ? { PAPERCLIP_TASK_ID: wakeTaskId } : {}),
    ...(issueWorkMode ? { PAPERCLIP_ISSUE_WORK_MODE: issueWorkMode } : {}),
    ...(wakeReason ? { PAPERCLIP_WAKE_REASON: wakeReason } : {}),
    ...(wakeCommentId ? { PAPERCLIP_WAKE_COMMENT_ID: wakeCommentId } : {}),
    ...(wakePayloadJson ? { PAPERCLIP_WAKE_PAYLOAD_JSON: wakePayloadJson } : {}),
    ...(authToken ? { PAPERCLIP_API_KEY: authToken } : {}),
    MINIMAX_API_KEY: "",
    MINIMAX_API_KEY_FILE: "",
  };

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: false });
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  // A MiniMax agent is a raw LLM + bash loop with none of the Paperclip operating
  // knowledge a CLI harness bakes in. Without the base URL + auth spelled out the
  // model curls the wrong host with no Authorization header, gets 401, and then
  // wanders the filesystem hunting for its issue. Spell out the exact recipe.
  const apiAccessNote = toolsEnabled
    ? [
        "## Paperclip API access (use this — do NOT search the filesystem for your issue)",
        "Authenticate EVERY Paperclip API request with this header (never omit it):",
        "  Authorization: Bearer $PAPERCLIP_API_KEY",
        "The API base URL is in $PAPERCLIP_API_URL and your current issue id is in $PAPERCLIP_TASK_ID.",
        "The full issue is already inlined in $PAPERCLIP_WAKE_PAYLOAD_JSON, so you rarely need to re-fetch it.",
        "Read your issue:",
        '  curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID"',
        "",
        "CRITICAL — before this heartbeat ends you MUST record a final disposition by PATCHing",
        'the issue to a TERMINAL status. Comments do NOT count, and leaving it "in_progress"',
        "blocks the issue and wastes the run. Pick exactly one: done (complete), blocked (name",
        "the external blocker in a comment first), or in_review (handed to a reviewer). Example:",
        '  curl -sS -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" -d \'{"status":"done"}\' "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID"',
        "Add a comment via POST $PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments (same header).",
        "Do not curl any other host and do not list or touch other issues.",
      ].join("\n")
    : "";
  const prompt = joinPromptSections([
    instructionsPrefix,
    apiAccessNote,
    wakePrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // Resolve + validate the credential/baseUrl pair before anything is sent.
  const credentialResolution = await resolveMiniMaxCredential(config);
  if (!credentialResolution.ok) {
    await onLog("stderr", `${credentialResolution.reason}\n`);
    return buildErrorResult(credentialResolution.reason, {
      code: "minimax_credentials",
      details: { code: "minimax_credentials" },
    });
  }
  const { key: apiKey, source: credentialSource } = credentialResolution.credential;
  const baseUrlError = validateBaseUrlForCredential(resolvedBaseUrl, credentialSource);
  if (baseUrlError) {
    await onLog("stderr", `${baseUrlError}\n`);
    return buildErrorResult(baseUrlError, { code: "minimax_base_url", details: { code: "minimax_base_url" } });
  }
  const baseUrl = resolvedBaseUrl.baseUrl;
  // Upstream-provided text (error messages, transport errors) is redacted
  // with the shared log redactor AND scrubbed of the literal API key, in case
  // a proxy or custom endpoint echoes the Authorization header back.
  const redactSecrets = (text: string): string => {
    const redacted = redactCommandTextForLogs(text);
    return apiKey ? redacted.split(apiKey).join("***REDACTED***") : redacted;
  };

  // Running usage totals — attached to EVERY result (success or failure) so a
  // run that spends tokens then fails still records cost and never bills $0.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;

  const accounting = (): Partial<AdapterExecutionResult> => {
    const usage = {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedInputTokens: totalCachedTokens,
    };
    const cost = computeMiniMaxCostUsd(model, usage, config);
    return {
      provider: "minimax",
      biller: "minimax",
      model,
      billingType: "metered_api",
      usage,
      usageBasis: "per_run",
      // No rate for this model (unknown id, no override): leave costUsd unset
      // so the ledger records the run as "unpriced" instead of $0.
      ...(cost ? { costUsd: cost.costUsd } : {}),
    };
  };
  const withAccounting = (result: AdapterExecutionResult): AdapterExecutionResult => ({
    ...result,
    ...accounting(),
  });

  // A heartbeat with nothing to act on (contentless wake) or a blank final
  // answer is a no-op: exit 0 with an honest summary. Usage/cost are recorded.
  const noop = (note: string, details: Record<string, unknown>): AdapterExecutionResult =>
    withAccounting({
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: note,
      resultJson: { ...details, stopReason: details.stopReason ?? "no_op", note },
    } as AdapterExecutionResult);

  // A run that did not converge (iteration cap, repeated identical failures,
  // narrated tool markup) FAILS with a specific errorCode so it is reported
  // truthfully rather than shown as a green run. Usage/cost are still recorded.
  const stopFailure = (
    code: string,
    message: string,
    details: Record<string, unknown>,
  ): AdapterExecutionResult =>
    withAccounting({
      ...buildErrorResult(message, { code, details }),
      summary: message,
      resultJson: { ...details, note: message },
    });

  // Contentless-wake short-circuit. The model only ever sees
  // instructionsPrefix + wakePrompt + sessionHandoffNote + renderedPrompt. With
  // the default prompt template (which interpolates only {{agent.id}}/{{agent.name}}
  // and no {{context.*}} task data), an empty wakePrompt AND empty handoff means
  // zero per-heartbeat task reached the model — instructions + boilerplate only.
  // renderPaperclipWakePrompt returns "" exactly when normalizePaperclipWakePayload
  // is null, i.e. no issue, comment (user messages arrive as wake comments),
  // execution-stage review, blocker, continuation, child issue, or tree hold. So
  // this is a bare liveness/on_demand heartbeat with nothing to act on: no-op
  // cleanly instead of spending a MiniMax round-trip that returns "resend the task"
  // chatter. A custom template could inject context we don't inspect, so restrict
  // the short-circuit to the default template.
  const usingDefaultTemplate = promptTemplate === DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
  if (wakePrompt.trim() === "" && sessionHandoffNote === "" && usingDefaultTemplate) {
    const message = "No actionable task in this wake; standing by.";
    await onLog("stdout", `[paperclip] ${message}\n`);
    return noop(message, { toolIterations: 0, toolCallCount: 0, stopReason: "contentless_wake" });
  }

  if (onMeta) {
    await onMeta({
      adapterType: "minimax_local",
      command: `POST ${baseUrl}/chat/completions`,
      cwd,
      commandNotes: [
        "MiniMax Local uses the MiniMax OpenAI-compatible HTTP API directly.",
        toolsEnabled
          ? `Native tool calling enabled: bash tool via ${describeAdapterExecutionTarget(executionTarget)}, max ${maxToolIterations} iterations.`
          : "Tool calling disabled (chat-only mode).",
        stripThink ? "Final output will strip <think>...</think> blocks." : "Final output keeps raw assistant text.",
        hasConfiguredMiniMaxRate(config, model)
          ? "Cost uses the configured MiniMax rate (pricing / MINIMAX_LOCAL_PRICING_JSON)."
          : "Cost uses the built-in ESTIMATED MiniMax rate card (unknown models are recorded as unpriced); set pricing or MINIMAX_LOCAL_PRICING_JSON for exact rates.",
      ],
      env: buildInvocationEnvForLogs(env, { includeRuntimeKeys: [], resolvedCommand: "fetch" }),
      prompt,
      promptMetrics,
      context,
    });
  }

  const postChat = async (
    messages: Array<Record<string, unknown>>,
  ): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; result: AdapterExecutionResult }> => {
    const perRequestMs = deadline !== null
      ? Math.max(1000, Math.min(requestTimeoutSec * 1000, deadline - Date.now()))
      : requestTimeoutSec * 1000;
    const controller = new AbortController();
    // The timer stays armed until the BODY has been read (see finally below):
    // fetch() resolves on headers, so clearing it earlier would let an
    // upstream that sends headers and then stalls hang the run forever.
    const timer = setTimeout(() => controller.abort(), perRequestMs);
    const timeoutResult = async () => {
      const message = `MiniMax request timed out after ${Math.round(perRequestMs / 1000)}s.`;
      await onLog("stderr", `${message}\n`);
      return {
        ok: false as const,
        result: buildErrorResult(message, { code: "minimax_request_timeout", transient: true, timedOut: true }),
      };
    };
    try {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: maxCompletionTokens,
            ...(toolsEnabled ? { tools: [BASH_TOOL] } : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        const err = error as Error & { name?: string };
        if (err.name === "AbortError" || controller.signal.aborted) return await timeoutResult();
        // Connection-level failures (DNS/ECONNRESET/TLS) are transient upstream.
        const message = `MiniMax request failed: ${redactSecrets(err.message ?? String(error))}`;
        await onLog("stderr", `${message}\n`);
        return { ok: false, result: buildErrorResult(message, { transient: true }) };
      }

      const body = await readResponseTextCapped(response, {
        maxBytes: MINIMAX_LOCAL_MAX_RESPONSE_BYTES,
        signal: controller.signal,
      });
      if (!body.ok) {
        if (body.reason === "aborted") return await timeoutResult();
        if (body.reason === "too_large") {
          const message =
            `MiniMax response exceeded ${MINIMAX_LOCAL_MAX_RESPONSE_BYTES} bytes; the request was aborted.`;
          await onLog("stderr", `${message}\n`);
          return {
            ok: false,
            result: buildErrorResult(message, {
              code: "minimax_response_too_large",
              details: { maxBytes: MINIMAX_LOCAL_MAX_RESPONSE_BYTES },
            }),
          };
        }
        const message = `MiniMax response body could not be read: ${redactSecrets(body.message ?? "unknown error")}`;
        await onLog("stderr", `${message}\n`);
        return { ok: false, result: buildErrorResult(message, { transient: true }) };
      }

      let payload: Record<string, unknown> = {};
      let parseFailed = false;
      try {
        payload = parseObject(JSON.parse(body.text));
      } catch {
        parseFailed = true;
        payload = {};
      }

      const baseRespError = readBaseRespError(payload);

      if (!response.ok) {
        const errorRecord = parseObject(payload.error);
        const rawMessage =
          firstNonEmptyString(
            errorRecord.message,
            payload.message,
            baseRespError?.statusMsg,
            `MiniMax API returned HTTP ${response.status}.`,
          ) ?? `MiniMax API returned HTTP ${response.status}.`;
        const message = redactSecrets(rawMessage).slice(0, 2000);
        await onLog("stderr", `${message}\n`);
        const family = classifyErrorFamily(response.status, undefined);
        const retryNotBefore = family ? parseRetryAfter(response.headers?.get?.("retry-after")) : null;
        return {
          ok: false,
          result: buildErrorResult(message, {
            status: response.status,
            details: { type: firstNonEmptyString(errorRecord.type, payload.type) },
            retryNotBefore,
          }),
        };
      }

      // MiniMax-specific: errors delivered as HTTP 200 + base_resp.
      if (baseRespError) {
        const statusMsg = redactSecrets(baseRespError.statusMsg).slice(0, 2000);
        const message =
          `MiniMax API error ${baseRespError.statusCode}` + (statusMsg ? `: ${statusMsg}` : ".");
        await onLog("stderr", `${message}\n`);
        return {
          ok: false,
          result: buildErrorResult(message, {
            code: `minimax_api_${baseRespError.statusCode}`,
            family: classifyBaseRespError(baseRespError.statusCode),
            details: { baseRespStatusCode: baseRespError.statusCode },
            retryNotBefore: parseRetryAfter(response.headers?.get?.("retry-after")),
          }),
        };
      }

      if (parseFailed || !Array.isArray(payload.choices) || payload.choices.length === 0) {
        const message =
          "MiniMax API returned HTTP 200 with an unparseable or empty completion payload; " +
          "failing the run rather than treating it as success.";
        await onLog("stderr", `${message}\n`);
        return {
          ok: false,
          result: buildErrorResult(message, {
            code: "minimax_empty_completion",
            details: { protocolError: "empty_completion_payload" },
          }),
        };
      }

      return { ok: true, payload };
    } finally {
      clearTimeout(timer);
    }
  };

  // Prepare the execution target for tool use (syncs the workspace to a remote
  // sandbox/ssh host and yields a restore hook; a no-op for the local target).
  let restoreWorkspace: () => Promise<void> = async () => {};
  let effectiveExecutionCwd = cwd;
  let runtimeExecutionTarget = executionTarget;
  if (toolsEnabled) {
    await onLog(
      "stdout",
      `[paperclip] Tool API access: PAPERCLIP_API_URL=${toolEnv.PAPERCLIP_API_URL ? "set" : "MISSING"}, PAPERCLIP_API_KEY=${toolEnv.PAPERCLIP_API_KEY ? "set" : "MISSING"}.\n`,
    );
    await fs.mkdir(cwd, { recursive: true }).catch(() => {});
    effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
    if (executionTargetIsRemote) {
      await onLog(
        "stdout",
        `[paperclip] Syncing MiniMax workspace to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const prepared = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "minimax",
        workspaceLocalDir: cwd,
        timeoutSec: timeoutSec > 0 ? timeoutSec : undefined,
      });
      restoreWorkspace = () => prepared.restoreWorkspace();
      effectiveExecutionCwd = prepared.workspaceRemoteDir ?? effectiveExecutionCwd;
    }
    runtimeExecutionTarget =
      overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd) ?? executionTarget;
  }

  // Run a single bash tool command through the execution target, capturing
  // (truncated) combined output for the model while streaming it live.
  const runToolCommand = async (
    command: string,
    perCommandTimeoutSec: number,
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> => {
    // The limit is in UTF-8 BYTES (not UTF-16 code units), matching its name.
    const captured: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    const capture = async (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
      if (!truncated) {
        const bytes = Buffer.from(chunk, "utf8");
        const room = toolOutputLimitBytes - capturedBytes;
        if (bytes.length > room) {
          captured.push(bytes.subarray(0, Math.max(0, room)));
          capturedBytes = toolOutputLimitBytes;
          truncated = true;
        } else {
          captured.push(bytes);
          capturedBytes += bytes.length;
        }
      }
      await onLog(stream, chunk);
    };
    const result = await runAdapterExecutionTargetShellCommand(runId, runtimeExecutionTarget, command, {
      cwd: effectiveExecutionCwd,
      env: toolEnv,
      timeoutSec: perCommandTimeoutSec,
      graceSec: 5,
      onLog: capture,
    });
    const suffix = [
      truncated ? "\n[output truncated]" : "",
      result.timedOut ? `\n[command timed out after ${perCommandTimeoutSec}s and was killed]` : "",
    ].join("");
    // A cut inside a multi-byte character decodes to U+FFFD; drop it.
    const buffer = Buffer.concat(captured).toString("utf8").replace(/\uFFFD+$/, "");
    return { output: buffer + suffix, exitCode: result.exitCode, timedOut: result.timedOut };
  };

  try {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: prompt }];
    let toolCallCount = 0;
    let iterations = 0;
    let lastPayload: Record<string, unknown> = {};
    let finalTurn: ReturnType<typeof extractAssistantTurn> | null = null;
    const consecutiveFailures = new Map<string, number>();

    while (true) {
      if (deadline !== null && Date.now() >= deadline) {
        const message = `Run exceeded configured timeoutSec=${timeoutSec}.`;
        await onLog("stderr", `${message}\n`);
        return withAccounting(buildErrorResult(message, { code: "minimax_run_budget", timedOut: true }));
      }
      if (iterations >= maxToolIterations) {
        const message =
          `Reached the ${maxToolIterations}-iteration tool cap without a final answer; failing the run.`;
        await onLog("stdout", `[paperclip] ${message}\n`);
        return stopFailure("minimax_iteration_cap", message, {
          toolIterations: iterations,
          toolCallCount,
          stopReason: "iteration_cap",
        });
      }
      iterations += 1;

      const outcome = await postChat(messages);
      if (!outcome.ok) return withAccounting(outcome.result);
      lastPayload = outcome.payload;

      const usage = extractUsage(lastPayload);
      totalInputTokens = addBoundedTokens(totalInputTokens, usage.inputTokens);
      totalOutputTokens = addBoundedTokens(totalOutputTokens, usage.outputTokens);
      totalCachedTokens = addBoundedTokens(totalCachedTokens, usage.cachedInputTokens);

      const turn = extractAssistantTurn(lastPayload);
      if (turn.toolCalls.length === 0) {
        finalTurn = turn;
        break;
      }

      // Surface interleaved narration so transcripts stay honest and live.
      const interleaved = applyStripThink(turn.content, stripThink);
      if (interleaved) await onLog("stdout", `${interleaved}\n`);

      messages.push(sanitizeAssistantMessageForHistory(turn.message));

      for (const call of turn.toolCalls) {
        if (deadline !== null && Date.now() >= deadline) {
          const message = `Run exceeded configured timeoutSec=${timeoutSec} during tool execution.`;
          await onLog("stderr", `${message}\n`);
          return withAccounting(buildErrorResult(message, { code: "minimax_run_budget", timedOut: true }));
        }

        if (call.name !== "bash") {
          const errorText = `Unknown tool "${call.name}". Only "bash" is available.`;
          await onLog("stderr", `[tool] ${errorText}\n`);
          messages.push({ role: "tool", tool_call_id: call.id, content: errorText });
          continue;
        }

        let command = "";
        try {
          const parsedArgs = parseObject(JSON.parse(call.args));
          command = firstNonEmptyString(parsedArgs.command) ?? "";
        } catch {
          command = "";
        }
        if (!command) {
          const errorText = 'Invalid bash tool arguments; expected JSON {"command": "..."}.';
          await onLog("stderr", `[tool] ${errorText}\n`);
          messages.push({ role: "tool", tool_call_id: call.id, content: errorText });
          continue;
        }

        toolCallCount += 1;
        await onLog("stdout", `[tool] $ ${command}\n`);
        const remainingSec = deadline !== null
          ? Math.max(1, Math.ceil((deadline - Date.now()) / 1000))
          : toolCommandTimeoutSec;
        const perCommandTimeoutSec = Math.min(toolCommandTimeoutSec, remainingSec);
        const result = await runToolCommand(command, perCommandTimeoutSec);
        const exitLabel = result.exitCode === null ? "spawn-error" : String(result.exitCode);
        await onLog("stdout", `[tool] exit ${exitLabel}\n`);

        if (result.exitCode !== 0) {
          const failures = (consecutiveFailures.get(command) ?? 0) + 1;
          consecutiveFailures.set(command, failures);
          if (failures >= MAX_CONSECUTIVE_IDENTICAL_FAILURES) {
            const message =
              `The same command failed ${failures} times ("${redactCommandTextForLogs(command.slice(0, 120))}"); failing the run.`;
            await onLog("stdout", `[paperclip] ${message}\n`);
            return stopFailure("minimax_repeated_command_failure", message, {
              toolIterations: iterations,
              toolCallCount,
              stopReason: "repeated_command_failure",
            });
          }
        } else {
          consecutiveFailures.delete(command);
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `exit code: ${exitLabel}\n${result.output}`,
        });
      }
    }

    const rawText = finalTurn?.content ?? "";
    const finalText = truncateText(applyStripThink(rawText, stripThink), MINIMAX_LOCAL_MAX_FINAL_TEXT_CHARS);

    // Narrated tool syntax means the model fell out of native tool calling and
    // did NOT actually run the work it describes: fail the run.
    if (TOOL_MARKUP_PATTERN.test(finalText)) {
      const message =
        "Model narrated tool-call markup instead of using native tool calling; the described actions were not executed.";
      await onLog("stdout", `[paperclip] ${message}\n`);
      return stopFailure("minimax_tool_markup", message, {
        toolIterations: iterations,
        toolCallCount,
        stopReason: "tool_markup_in_text",
      });
    }

    // No final assistant text (blank content / all-think) after the run — for a
    // heartbeat this means "nothing to report", a benign no-op rather than a
    // failure. (A malformed API payload was already caught upstream in postChat.)
    if (!finalText) {
      const message = "No actionable output this heartbeat.";
      await onLog("stdout", `[paperclip] ${message}\n`);
      return noop(message, { toolIterations: iterations, toolCallCount, stopReason: "empty_output" });
    }

    await onLog("stdout", `${finalText}\n`);

    return withAccounting({
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: finalText,
        resultJson: {
          id: firstNonEmptyString(lastPayload.id),
          object: firstNonEmptyString(lastPayload.object),
          finishReason: finalTurn?.finishReason ?? null,
          outputText: finalText,
          toolIterations: iterations,
          toolCallCount,
        },
      } as AdapterExecutionResult);
  } finally {
    // Sync remote-side workspace changes back into the local worktree. A failed
    // restore is a run-level error (workspace_finalize) — do not swallow it.
    await restoreWorkspace();
  }
}
