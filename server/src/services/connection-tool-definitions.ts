import { CONNECTION_REQUEST_TOOL_DESCRIPTION, CONNECTIONS_SEARCH_TOOL_DESCRIPTION } from "@paperclipai/shared";

export const RUNTIME_CONNECTION_TOOL_DEFINITIONS = [
  {
    name: "connections_search",
    description: CONNECTIONS_SEARCH_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", maxLength: 4000 }, retryProviderChoice: { type: "boolean", description: "Only when the user explicitly asks to reconsider a previous provider choice or decline" } },
      additionalProperties: false,
    },
  },
  {
    name: "connection_request",
    description: CONNECTION_REQUEST_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { service: { type: "string" }, targetService: { type: "string", description: "App slug returned by search only when the user explicitly named this external provider" }, selectionInteractionId: { type: "string", description: "Saved answered provider-choice interaction ID for aggregator routes" } },
      required: ["service"],
      additionalProperties: false,
    },
  },
  {
    name: "typesafe_judge",
    description: "Explicitly evaluate one or more independent bounded Choice, Noul, or Score judgments over shared non-sensitive state. This optional tool returns typed values; it cannot authorize actions or replace the primary reasoning model.",
    // Many agents see only this schema, not the typesafe-judge skill, so it
    // carries the question contract. Every value that is not a plain string
    // declares its JSON types: a real Kimi run sent an untyped `criteria` as
    // prose text on seven consecutive calls.
    inputSchema: {
      type: "object",
      properties: {
        state: {
          anyOf: [{ type: "string", minLength: 1 }, { type: "object" }, { type: "array" }],
          description: "The material every question is judged against: a string, or a JSON object or array with named parts. Text only. Send the minimum the questions need, and nothing sensitive: it goes to the external TypeSafe provider.",
        },
        model: {
          type: "string",
          description: "Use \"jev-latest\" unless the task pins a versioned ID such as \"jev-1.13.0\".",
        },
        questions: {
          type: "object",
          minProperties: 1,
          maxProperties: 32,
          description: "Independent questions keyed by an ID you choose (a letter, then letters, digits, \"_\" or \"-\"; 64 characters at most). The ID is not shown to the model, so each question must be complete without it. Questions cannot see each other's answers. Example: {\"route\":{\"type\":\"choice\",\"instructions\":\"Which team should handle the request?\",\"criteria\":{\"billing\":\"Payments and invoices\",\"engineering\":\"Product defects\",\"none\":\"Neither fits\"}},\"blocked\":{\"type\":\"noul\",\"instructions\":\"Does the request say work is blocked?\"},\"severity\":{\"type\":\"score\",\"instructions\":\"How severe is the impact?\",\"criteria\":[\"Cosmetic\",\"Degraded, with a workaround\",\"Blocked\"]}}",
          additionalProperties: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["choice", "noul", "score"],
                description: "choice: select one option from a defined set. noul: the probability, 0 to 1, that the answer to a yes/no question is yes. score: a position on ordered levels.",
              },
              instructions: {
                anyOf: [{ type: "string", minLength: 1 }, { type: "object" }, { type: "array" }],
                description: "One focused judgment about the state: a string, or an object or array that holds the question and the data it refers to. Name a part of the state by its path in backticks, for example `ticket.messages[0].text`.",
              },
              criteria: {
                anyOf: [
                  {
                    type: "object",
                    description: "For choice (required): each option ID (1 to 128 characters) mapped to its meaning, or to null; 2 to 255 options; add a no-match option when none may fit. For noul (optional): \"true\" and \"false\" mapped to what yes and no mean.",
                  },
                  {
                    type: "array",
                    minItems: 2,
                    maxItems: 10,
                    description: "For score (required): the level descriptions, lowest first, each a concrete situation.",
                  },
                  // The validator reads a null Noul criteria as none. A client
                  // that checks arguments against this schema must agree.
                  { type: "null", description: "For noul only: the same as leaving criteria out." },
                ],
                description: "The possible answers, as a JSON object or array, never as text. Leave it out for a noul whose question is clear.",
              },
            },
            required: ["type", "instructions"],
            additionalProperties: false,
          },
        },
      },
      required: ["state", "model", "questions"],
      additionalProperties: false,
    },
  },
] as const;
