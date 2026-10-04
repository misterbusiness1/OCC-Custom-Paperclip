import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import type {
  DurablePrpControlPlane,
  HarnessRuntimeRequestResolution,
} from "../vendor/paperclip-runner/index.js";
import {
  assertNativeRuntimeRequestResolverAuthorized,
  type NativeRuntimeRequestResolver,
  type PendingNativeRuntimeRequest,
} from "../services/native-runtime/runtime-request-resolution-authority.js";

import { logger } from "../middleware/logger.js";

const CONNECT_PATH_PREFIX = "/api/runner/v1/connect/";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RegisteredAuthority {
  readonly companyId: string;
  readonly issueId: string | null;
  readonly agentId: string | null;
  readonly authority: DurablePrpControlPlane;
  readonly generation: symbol;
  readonly controllerInstanceId: string;
  readonly runtimeRequestResolutions: Map<
    string,
    { readonly fingerprint: string; readonly commandId: string }
  >;
}

interface CurrentLiveAuthority {
  readonly runId: string;
  readonly generation: symbol;
}

interface RunnerPrpUpgradeRequest extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
}

const registrations = new Map<string, RegisteredAuthority>();
const currentLiveAuthorities = new Map<string, CurrentLiveAuthority>();
let loopbackOrigin: string | null = null;

function liveAuthorityKey(input: {
  readonly companyId: string;
  readonly issueId: string;
  readonly agentId: string;
}): string {
  return JSON.stringify([input.companyId, input.issueId, input.agentId]);
}

function rejectUpgrade(
  socket: Duplex,
  status: "400 Bad Request" | "404 Not Found",
): void {
  if (socket.destroyed) return;
  try {
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : typeof error },
      "failed to reject runner PRP websocket upgrade",
    );
    socket.destroy();
  }
}

export function setupRunnerPrpWebSocketServer(
  server: Server,
  options: { readonly apiUrl: string },
): void {
  const apiUrl = new URL(options.apiUrl);
  if (!["http:", "https:"].includes(apiUrl.protocol)) {
    throw new Error("runner_prp_websocket_api_url_invalid");
  }
  apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  apiUrl.username = "";
  apiUrl.password = "";
  apiUrl.pathname = "";
  apiUrl.search = "";
  apiUrl.hash = "";
  loopbackOrigin = apiUrl.toString().replace(/\/$/, "");
  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://paperclip.invalid");
      if (!url.pathname.startsWith(CONNECT_PATH_PREFIX)) return;

      const ownedRequest = request as RunnerPrpUpgradeRequest;
      if (ownedRequest.paperclipWebSocketHandled) return;
      ownedRequest.paperclipWebSocketHandled = true;
      socket.on("error", (error) => {
        logger.warn(
          { errorName: error.name },
          "runner PRP websocket upgrade socket failed",
        );
      });

      const runId = url.pathname.slice(CONNECT_PATH_PREFIX.length);
      if (!UUID_PATTERN.test(runId)) {
        rejectUpgrade(socket, "400 Bad Request");
        return;
      }
      const registration = registrations.get(runId);
      if (!registration) {
        rejectUpgrade(socket, "404 Not Found");
        return;
      }
      registration.authority.handleUpgrade(request, socket, url.pathname, head);
    },
  );
}

export async function registerRunnerPrpAuthority(input: {
  readonly companyId: string;
  readonly issueId?: string;
  readonly agentId?: string;
  readonly runId: string;
  readonly authority: DurablePrpControlPlane;
}): Promise<{ readonly connectUrl: string; release(): Promise<void> }> {
  if (loopbackOrigin === null) {
    throw new Error("runner_prp_websocket_server_not_configured");
  }
  if (!UUID_PATTERN.test(input.runId) || input.companyId.length === 0) {
    throw new Error("runner_prp_authority_binding_invalid");
  }
  if (registrations.has(input.runId)) {
    throw new Error("runner_prp_authority_already_registered");
  }
  const generation = Symbol(input.runId);
  const registeredAuthority: RegisteredAuthority = {
    companyId: input.companyId,
    issueId: input.issueId ?? null,
    agentId: input.agentId ?? null,
    authority: input.authority,
    generation,
    controllerInstanceId: randomUUID(),
    runtimeRequestResolutions: new Map(),
  };
  registrations.set(input.runId, registeredAuthority);
  const currentKey = input.issueId && input.agentId
    ? liveAuthorityKey({
        companyId: input.companyId,
        issueId: input.issueId,
        agentId: input.agentId,
      })
    : null;
  if (currentKey !== null) {
    currentLiveAuthorities.set(currentKey, {
      runId: input.runId,
      generation,
    });
  }
  return {
    connectUrl: `${loopbackOrigin}${CONNECT_PATH_PREFIX}${input.runId}`,
    release: async () => {
      if (registrations.get(input.runId)?.generation === generation) {
        registrations.delete(input.runId);
      }
      if (currentKey !== null) {
        const current = currentLiveAuthorities.get(currentKey);
        if (
          current?.runId === input.runId &&
          current.generation === generation
        ) {
          currentLiveAuthorities.delete(currentKey);
        }
      }
    },
  };
}

export interface CapturedRunnerPrpSteerTarget {
  runId: string;
  controllerInstanceId: string;
  runnerInstanceId: string;
  environmentLeaseId: string;
  normalizedSessionId: string;
  turnId: string;
  itemId: string;
  providerTurnId: string;
  providerSessionId: string;
}

function capturedIdentityMatches(binding: RegisteredAuthority, target: CapturedRunnerPrpSteerTarget) {
  const identity = binding.authority.store.state.identity;
  return ["runId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "turnId", "itemId"].every(
    key => identity[key as keyof typeof identity] === target[key as keyof CapturedRunnerPrpSteerTarget]);
}

/** Read-only admission snapshot. A later generation/turn must never receive this request. */
export function captureLiveRunnerPrpSteerTarget(input: { companyId: string; issueId: string; agentId: string }): CapturedRunnerPrpSteerTarget | null {
  const current = currentLiveAuthorities.get(liveAuthorityKey(input));
  const binding = current ? registrations.get(current.runId) : null;
  if (!current || !binding || binding.generation !== current.generation || binding.companyId !== input.companyId
    || binding.issueId !== input.issueId || binding.agentId !== input.agentId) return null;
  const state = binding.authority.store?.state;
  if (!state || state.identity.runId !== current.runId) return null;
  const identity = state.identity;
  if (Object.values(identity).some(value => typeof value !== "string" || !value)) return null;
  const events = state.committedEvents;
  let accepted: { providerTurnId: string; providerSessionId: string } | null = null;
  for (const event of events) {
    if (["runId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "turnId", "itemId"].some(
      key => event.envelope[key] !== identity[key as keyof typeof identity])) continue;
    if (["turn.completed", "turn.failed", "turn.cancelled", "run.terminal"].includes(event.eventType)) accepted = null;
    if (event.eventType !== "turn.accepted") continue;
    const prpEvent = event.envelope.payload as Record<string, unknown> | undefined;
    const payload = prpEvent?.payload as Record<string, unknown> | undefined;
    accepted = payload && typeof payload.providerTurnId === "string" && payload.providerTurnId.length > 0
      && typeof payload.providerSessionId === "string" && payload.providerSessionId.length > 0
      ? { providerTurnId: payload.providerTurnId, providerSessionId: payload.providerSessionId } : null;
  }
  return accepted ? { ...identity, controllerInstanceId: binding.controllerInstanceId, ...accepted } : null;
}

/** Receipt-only lookup may inspect a reattached controller, but may not queue into it. */
export function readCapturedRunnerPrpSteerOutcome(input: {
  companyId: string; issueId: string; agentId: string; target: CapturedRunnerPrpSteerTarget; commandId: string; expectedTextSha256: string;
}) {
  const binding = registrations.get(input.target.runId);
  if (!binding || binding.companyId !== input.companyId || binding.issueId !== input.issueId || binding.agentId !== input.agentId
    || !capturedIdentityMatches(binding, input.target)) return null;
  const command = binding.authority.store.state.commands.find(command => command.commandId === input.commandId);
  if (!command || command.type !== "turn.steer" || command.payload.expectedProviderTurnId !== input.target.providerTurnId
    || command.payload.expectedProviderSessionId !== input.target.providerSessionId
    || typeof command.payload.text !== "string"
    || createHash("sha256").update(command.payload.text).digest("hex") !== input.expectedTextSha256) return null;
  return binding.authority.commandOutcome(input.commandId);
}

export function queueLiveRunnerPrpCommand(input: {
  companyId: string;
  issueId: string;
  agentId: string;
  type: string;
  payload?: Record<string, unknown>;
  commandId?: string;
  expectedSteerTarget?: CapturedRunnerPrpSteerTarget;
}): {
  runId: string;
  commandId: string;
  controllerSeq: number;
  completion: Promise<Record<string, unknown> | null>;
} | null {
  const current = currentLiveAuthorities.get(liveAuthorityKey(input));
  if (!current) return null;
  const binding = registrations.get(current.runId);
  if (!binding || binding.generation !== current.generation) return null;
  if (input.expectedSteerTarget) {
    const captured = captureLiveRunnerPrpSteerTarget(input);
    const expected = input.expectedSteerTarget;
    if (input.type !== "turn.steer" || !captured || Object.keys(expected).length !== Object.keys(captured).length
      || Object.keys(captured).some(key =>
      captured[key as keyof CapturedRunnerPrpSteerTarget] !== expected[key as keyof CapturedRunnerPrpSteerTarget])) return null;
    if (input.payload?.expectedProviderTurnId !== expected.providerTurnId
      || input.payload?.expectedProviderSessionId !== expected.providerSessionId) return null;
  }
  const runId = current.runId;
  const command = binding.authority.queueCommand(
    input.type,
    input.payload ?? {},
    input.commandId,
    true,
  );
  return {
    runId,
    commandId: command.commandId,
    controllerSeq: command.controllerSeq,
    completion: (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const outcome = binding.authority.commandOutcome(command.commandId);
        if (!outcome) {
          throw new Error(`runner_prp_command_missing:${command.commandId}`);
        }
        if (outcome.status === "completed") return outcome.result;
        if (outcome.status === "failed" || outcome.status === "rejected" || outcome.status === "indeterminate") {
          const message =
            outcome.result && typeof outcome.result.message === "string"
              ? outcome.result.message
              : `runner_prp_command_${outcome.status}:${command.commandId}`;
          throw new Error(message);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10);
          timer.unref();
        });
      }
      throw new Error(`runner_prp_command_timeout:${command.commandId}`);
    })(),
  };
}

export class RunnerPrpRuntimeRequestResolutionError extends Error {
  constructor(
    readonly code:
      | "runner_prp_authority_not_active"
      | "runtime_request_resolution_conflict",
  ) {
    super(code);
    this.name = "RunnerPrpRuntimeRequestResolutionError";
  }
}

/**
 * Queue one turn-bound runtime response on the active durable PRP authority.
 * Identical browser retries reuse the original command; a different answer for
 * the same request fails closed instead of answering the provider twice.
 */
export function queueRunnerPrpRuntimeRequestResolution(input: {
  readonly companyId: string;
  readonly runId: string;
  readonly pendingRequest: PendingNativeRuntimeRequest;
  readonly actor: NativeRuntimeRequestResolver;
  readonly resolution: HarnessRuntimeRequestResolution;
}): { readonly commandId: string } {
  const registration = registrations.get(input.runId);
  if (
    !registration
    || registration.companyId !== input.companyId
    // Warm attachment briefly registers two routes for the same mutable core.
    // A route is not dispatch authority before or after its exact run epoch.
    || registration.authority.store.state.identity.runId !== input.runId
  ) {
    throw new RunnerPrpRuntimeRequestResolutionError(
      "runner_prp_authority_not_active",
    );
  }
  const pending = input.pendingRequest;
  if (
    pending.companyId !== input.companyId
    || pending.runId !== input.runId
  ) {
    throw new RunnerPrpRuntimeRequestResolutionError(
      "runner_prp_authority_not_active",
    );
  }
  // Authorization is intentionally checked again at the command-consumption
  // boundary. The route performs the same check before parsing a resolution,
  // but only this edge owns the durable command mutation.
  assertNativeRuntimeRequestResolverAuthorized(pending, input.actor);

  const fingerprint = JSON.stringify({
    requestKind: pending.requestKind,
    turnId: pending.turnId,
    actor: input.actor,
    resolution: input.resolution,
  });
  const previous = registration.runtimeRequestResolutions.get(pending.requestId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) {
      throw new RunnerPrpRuntimeRequestResolutionError(
        "runtime_request_resolution_conflict",
      );
    }
    return { commandId: previous.commandId };
  }

  const command = registration.authority.queueCommand(
    "request.resolve",
    {
      requestId: pending.requestId,
      requestKind: pending.requestKind,
      turnId: pending.turnId,
      resolution: input.resolution,
      resolutionActor: input.actor,
    },
    undefined,
    true,
  );
  registration.runtimeRequestResolutions.set(pending.requestId, {
    fingerprint,
    commandId: command.commandId,
  });
  return { commandId: command.commandId };
}

export const runnerPrpWebSocketInternals = {
  connectPathPrefix: CONNECT_PATH_PREFIX,
  activeRegistration(input: {
    readonly companyId: string;
    readonly runId: string;
  }): boolean {
    return registrations.get(input.runId)?.companyId === input.companyId;
  },
  resetForTests(): void {
    registrations.clear();
    currentLiveAuthorities.clear();
    loopbackOrigin = null;
  },
};
