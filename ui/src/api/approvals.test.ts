import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalsApi } from "./approvals";
import { ApiError } from "./client";
import { approvalVersionConflict } from "../lib/approval-version";

const fetchMock = vi.fn();
const VERSION = "2026-10-07T12:34:56.789Z";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const sent = (call = 0) => {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown> };
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({ id: "a1" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("approvalsApi decisions", () => {
  it("sends exactly the old body when no version is given", async () => {
    await approvalsApi.approve("a1", "ok");
    await approvalsApi.reject("a1");
    await approvalsApi.requestRevision("a1", "Quote the date");
    await approvalsApi.approve("a1", undefined, { keepalive: true });

    expect(sent(0)).toMatchObject({ url: "/api/approvals/a1/approve", body: { decisionNote: "ok" } });
    expect(sent(1)).toMatchObject({ url: "/api/approvals/a1/reject", body: {} });
    expect(sent(2)).toMatchObject({ url: "/api/approvals/a1/request-revision", body: { decisionNote: "Quote the date" } });
    for (const call of [0, 1, 2, 3]) expect("expectedUpdatedAt" in sent(call).body).toBe(false);
    expect("keepalive" in sent(0).init).toBe(false);
    expect(sent(3).init.keepalive).toBe(true);
  });

  it("sends the version as the ISO string the API gave, from a string or a Date, on all three decisions", async () => {
    await approvalsApi.approve("a1", "ok", { expectedUpdatedAt: VERSION });
    await approvalsApi.reject("a1", undefined, { expectedUpdatedAt: new Date(VERSION) });
    await approvalsApi.requestRevision("a1", "Quote the date", { expectedUpdatedAt: new Date(VERSION) });

    expect(sent(0).body).toEqual({ decisionNote: "ok", expectedUpdatedAt: VERSION });
    expect(sent(1).body).toEqual({ expectedUpdatedAt: VERSION });
    expect(sent(2).body).toEqual({ decisionNote: "Quote the date", expectedUpdatedAt: VERSION });
    // A version alone does not make the request outlive the page.
    expect("keepalive" in sent(0).init).toBe(false);
  });

  it("sends the version with a held approval that outlives the page", async () => {
    await approvalsApi.approve("a1", "ok", { keepalive: true, expectedUpdatedAt: new Date(VERSION) });

    expect(sent().body).toEqual({ decisionNote: "ok", expectedUpdatedAt: VERSION });
    expect(sent().init.keepalive).toBe(true);
  });

  it("rejects with an error the pages can recognise when the server answers 409", async () => {
    const message = "This request changed after you opened it. Reload it and decide again.";
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: message,
          code: "approval_version_conflict",
          details: { code: "approval_version_conflict", currentStatus: "approved", currentUpdatedAt: VERSION },
        },
        409,
      ),
    );

    const error = await approvalsApi.approve("a1", "ok", { expectedUpdatedAt: VERSION }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe(message);
    expect(approvalVersionConflict(error)).toEqual({ currentStatus: "approved", currentUpdatedAt: VERSION });
  });
});
