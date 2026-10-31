import { describe, expect, it } from "vitest";
import { createFinanceEventSchema } from "./finance.js";

const baseEvent = {
  eventKind: "inference_charge",
  biller: "openai",
  amountCents: 125,
  occurredAt: "2026-10-31T12:00:00.000Z",
};

describe("createFinanceEventSchema executionAdapterType", () => {
  it("accepts built-in adapter types", () => {
    const parsed = createFinanceEventSchema.parse({ ...baseEvent, executionAdapterType: "claude_local" });
    expect(parsed.executionAdapterType).toBe("claude_local");
  });

  it("accepts external adapter types registered at runtime", () => {
    const parsed = createFinanceEventSchema.parse({ ...baseEvent, executionAdapterType: "droid_local" });
    expect(parsed.executionAdapterType).toBe("droid_local");
  });

  it("accepts null and omission", () => {
    expect(createFinanceEventSchema.parse({ ...baseEvent, executionAdapterType: null }).executionAdapterType).toBeNull();
    expect(createFinanceEventSchema.parse(baseEvent).executionAdapterType).toBeUndefined();
  });

  it("rejects empty adapter types", () => {
    expect(() => createFinanceEventSchema.parse({ ...baseEvent, executionAdapterType: "   " })).toThrow();
  });

  it("caps adapter types at 100 characters", () => {
    const atLimit = "a".repeat(100);
    expect(createFinanceEventSchema.parse({ ...baseEvent, executionAdapterType: atLimit }).executionAdapterType).toBe(atLimit);
    expect(
      createFinanceEventSchema.parse({ ...baseEvent, executionAdapterType: `  ${atLimit}  ` }).executionAdapterType,
    ).toBe(atLimit);
    expect(createFinanceEventSchema.safeParse({ ...baseEvent, executionAdapterType: "a".repeat(101) }).success).toBe(false);
  });
});
