import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_REQUEST_TOOL_DESCRIPTION,
  CONNECTION_RUNTIME_TOOL_NAMES,
  CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
} from "@paperclipai/shared";
import {
  RUNTIME_CONNECTION_TOOL_DEFINITIONS,
  wakeConnectionIntentAfterResolution,
} from "./connection-intents.js";
import { typeSafeJudgeInputSchema } from "../services/typesafe-runtime-tool.js";

describe("runtime connection MCP contract", () => {
  it("advertises the canonical runtime tools with narrow schemas", () => {
    expect(
      RUNTIME_CONNECTION_TOOL_DEFINITIONS.map((tool) => tool.name),
    ).toEqual(CONNECTION_RUNTIME_TOOL_NAMES);
    expect(RUNTIME_CONNECTION_TOOL_DEFINITIONS).toEqual([
      {
        name: "connections_search",
        description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", maxLength: 4000 },
            retryProviderChoice: {
              type: "boolean",
              description: "Only when the user explicitly asks to reconsider a previous provider choice or decline",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "connection_request",
        description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            service: { type: "string" },
            targetService: { type: "string", description: "App slug returned by search only when the user explicitly named this external provider" },
            selectionInteractionId: {
              type: "string",
              description: "Saved answered provider-choice interaction ID for aggregator routes",
            },
          },
          required: ["service"],
          additionalProperties: false,
        },
      },
      expect.objectContaining({ name: "typesafe_judge", inputSchema: expect.objectContaining({ required: ["state", "model", "questions"] }) }),
    ]);
  });

  it("describes the typesafe_judge question contract in the schema agents see", () => {
    const judge = RUNTIME_CONNECTION_TOOL_DEFINITIONS.find((tool) => tool.name === "typesafe_judge")!;
    // The tool supplies a judgment to the agent; it never stands in for it.
    expect(judge.description).toContain("cannot authorize actions or replace the primary reasoning model");
    const question = (judge.inputSchema.properties.questions as unknown as {
      additionalProperties: {
        properties: Record<string, { enum?: readonly string[]; anyOf?: ReadonlyArray<{ type: string; description?: string }> }>;
        required: readonly string[];
      };
    }).additionalProperties;
    expect(question.properties.type.enum).toEqual(["choice", "noul", "score"]);
    expect(question.required).toEqual(["type", "instructions"]);
    // An untyped `criteria` reached the tool as prose text from a real agent,
    // so its JSON shapes are declared, and each names the types it serves.
    const criteria = question.properties.criteria.anyOf ?? [];
    expect(criteria.map((shape) => shape.type)).toEqual(["object", "array", "null"]);
    expect(criteria[2]?.description).toContain("noul only");
    expect(criteria[0]?.description).toContain("choice");
    expect(criteria[0]?.description).toContain("noul");
    expect(criteria[1]?.description).toContain("score");
  });

  it("gives an example in the schema that the tool itself accepts", () => {
    const judge = RUNTIME_CONNECTION_TOOL_DEFINITIONS.find((tool) => tool.name === "typesafe_judge")!;
    const description = (judge.inputSchema.properties.questions as { description: string }).description;
    const example = JSON.parse(description.slice(description.indexOf("Example: ") + "Example: ".length));
    const parsed = typeSafeJudgeInputSchema.safeParse({ state: "synthetic", model: "jev-latest", questions: example });
    expect(parsed.success).toBe(true);
    expect(Object.values(example as Record<string, { type: string }>).map((question) => question.type).sort())
      .toEqual(["choice", "noul", "score"]);
  });

  it("does not accept run identity, task identity, users, or credentials from tool input", () => {
    const serialized = JSON.stringify(
      RUNTIME_CONNECTION_TOOL_DEFINITIONS.map(
        (definition) => definition.inputSchema,
      ),
    );
    expect(serialized).not.toMatch(
      /companyId|agentId|runId|issueId|responsibleUserId|credential|token/i,
    );
  });
});

describe("connection intent continuation wake contract", () => {
  it.each([
    ["accepted", "connected"],
    ["rejected", "declined"],
  ])(
    "emits one idempotent continuation wake for %s intents",
    async (status) => {
      const wakeup = vi.fn().mockResolvedValue(undefined);

      await wakeConnectionIntentAfterResolution({ wakeup } as never, {
        loaded: {
          issue: {
            id: "issue-123",
            assigneeAgentId: "agent-123",
            status: "in_progress",
          },
          interaction: { id: "interaction-123" },
        },
        status,
        actorId: "user-123",
      });

      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup).toHaveBeenCalledWith(
        "agent-123",
        expect.objectContaining({
          idempotencyKey: `connection-intent:interaction-123:${status}`,
          requestedByActorType: "user",
          requestedByActorId: "user-123",
          contextSnapshot: expect.objectContaining({
            issueId: "issue-123",
            interactionId: "interaction-123",
            interactionStatus: status,
            forceFreshSession: true,
          }),
        }),
      );
    },
  );

  it.each(["backlog", "todo", "done", "blocked", "cancelled"])(
    "does not wake a parked or closed %s task",
    async (issueStatus) => {
      const wakeup = vi.fn().mockResolvedValue(undefined);

      await wakeConnectionIntentAfterResolution({ wakeup } as never, {
        loaded: {
          issue: {
            id: "issue-closed",
            assigneeAgentId: "agent-123",
            status: issueStatus,
          },
          interaction: { id: "interaction-123" },
        },
        status: "accepted",
        actorId: "user-123",
      });

      expect(wakeup).not.toHaveBeenCalled();
    },
  );
});
