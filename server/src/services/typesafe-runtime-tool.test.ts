import { describe, expect, it } from "vitest";
import { typeSafeJudgeInputSchema, validateTypeSafeAnswers } from "./typesafe-runtime-tool.js";

const input = typeSafeJudgeInputSchema.parse({
  state: { message: "A synthetic non-sensitive test request" },
  model: "jev-latest",
  questions: {
    route: { type: "choice", instructions: "Choose a route", criteria: { alpha: "A", no_match: "Neither" } },
    applies: { type: "noul", instructions: "Does it apply?", criteria: { true: "yes", false: "no" } },
    quality: { type: "score", instructions: "Rate quality", criteria: ["low", "medium", "high"] },
  },
});

describe("TypeSafe runtime tool contract", () => {
  it("accepts a batched typed result and preserves uncertainty/no-match", () => {
    expect(validateTypeSafeAnswers(input, {
      model: "jev-1.13.0",
      answers: {
        route: { type: "choice", choice: "no_match", probabilities: { alpha: 0.4, no_match: 0.6 }, confidence: 0.2 },
        applies: { type: "noul", noul: 0.51 },
        quality: { type: "score", score: 1.2, legend: { 0: "low", 1: "medium", 2: "high" }, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, confidence: 0.4 },
      },
      usage: { input_tokens: 123, output_tokens: 45 },
    })).toMatchObject({ model: "jev-1.13.0", answers: { route: { choice: "no_match" }, applies: { noul: 0.51 }, quality: { score: 1.2 } }, usage: { inputTokens: 123, outputTokens: 45 } });
  });

  it.each([
    ["non-finite noul", { applies: { type: "noul", noul: Number.NaN } }],
    ["unknown choice", { route: { type: "choice", choice: "foreign", probabilities: { alpha: 0.4, no_match: 0.6 }, confidence: 0.2 } }],
    ["out-of-range score", { quality: { type: "score", score: 3, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, confidence: 0.4 } }],
  ])("rejects %s", (_label, replacement) => {
    const valid = {
      route: { type: "choice", choice: "alpha", probabilities: { alpha: 0.6, no_match: 0.4 }, confidence: 0.2 },
      applies: { type: "noul", noul: 0.5 },
      quality: { type: "score", score: 1, probabilities: { 0: 0.2, 1: 0.6, 2: 0.2 }, confidence: 0.4 },
    };
    expect(() => validateTypeSafeAnswers(input, { model: "jev-1.13.0", answers: { ...valid, ...replacement }, usage: { input_tokens: 1, output_tokens: 1 } })).toThrow("invalid_response");
  });

  it("rejects invalid question IDs and underspecified choice/score schemas", () => {
    expect(() => typeSafeJudgeInputSchema.parse({ state: "x", model: "jev-latest", questions: { "bad id": { type: "noul", instructions: "x" } } })).toThrow();
    expect(() => typeSafeJudgeInputSchema.parse({ state: "x", model: "jev-latest", questions: { q: { type: "choice", instructions: "x", criteria: { only: null } } } })).toThrow();
    expect(() => typeSafeJudgeInputSchema.parse({ state: "x", model: "jev-latest", questions: { q: { type: "score", instructions: "x", criteria: ["only"] } } })).toThrow();
  });
});
