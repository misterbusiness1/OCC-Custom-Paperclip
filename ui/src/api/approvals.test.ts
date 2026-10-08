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

describe("approvalsApi.listLinkedIssues", () => {
  const row = (id: string) => ({ id, identifier: null, title: id, status: "todo" });

  it("reads the linked tasks of several approvals in one request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ a1: [row("i1")] }));

    const result = await approvalsApi.listLinkedIssues("co 1", ["a1", "a2", "a1", ""]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/companies/co 1/approvals/linked-issues?ids=a1,a2");
    expect(result).toEqual({ a1: [row("i1")] });
  });

  it("sends nothing for an empty list", async () => {
    expect(await approvalsApi.listLinkedIssues("co-1", [])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a list longer than the server's cap in as few requests as it takes, and joins the answers", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `a${index}`);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ a0: [row("i0")] }))
      .mockResolvedValueOnce(jsonResponse({ a100: [row("i100")] }));

    const result = await approvalsApi.listLinkedIssues("co-1", ids);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]![0] as string).split("ids=")[1]!.split(",")).toHaveLength(100);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/companies/co-1/approvals/linked-issues?ids=a100");
    expect(result).toEqual({ a0: [row("i0")], a100: [row("i100")] });
  });

  describe("against a server without the batch route", () => {
    const notFound = () => jsonResponse({ error: "API route not found" }, 404);
    const issue = (id: string) => ({
      id, identifier: `OPS-${id}`, title: `Task ${id}`, status: "todo", description: "long text", companyId: "co-1",
    });

    it("reads each approval's linked tasks instead, as the same slim rows, with no key for an approval without tasks", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/linked-issues")) return notFound();
        if (url === "/api/approvals/a1/issues") return jsonResponse([issue("i1"), { ...issue("i2"), identifier: null }]);
        return jsonResponse([]);
      });

      const result = await approvalsApi.listLinkedIssues("co-1", ["a1", "a2"]);

      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        "/api/companies/co-1/approvals/linked-issues?ids=a1,a2",
        "/api/approvals/a1/issues",
        "/api/approvals/a2/issues",
      ]);
      expect(result).toEqual({
        a1: [
          { id: "i1", identifier: "OPS-i1", title: "Task i1", status: "todo" },
          { id: "i2", identifier: null, title: "Task i2", status: "todo" },
        ],
      });
    });

    it("keeps the other approvals' tasks when one approval is gone", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/linked-issues")) return notFound();
        if (url === "/api/approvals/a1/issues") return jsonResponse({ error: "Approval not found" }, 404);
        return jsonResponse([issue("i2")]);
      });

      expect(await approvalsApi.listLinkedIssues("co-1", ["a1", "a2"])).toEqual({
        a2: [{ id: "i2", identifier: "OPS-i2", title: "Task i2", status: "todo" }],
      });
    });

    it("fails when one approval's read fails, so a failed lookup is not shown as no linked tasks", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/linked-issues")) return notFound();
        if (url === "/api/approvals/a1/issues") return jsonResponse({ error: "boom" }, 500);
        return jsonResponse([issue("i2")]);
      });

      const error = await approvalsApi.listLinkedIssues("co-1", ["a1", "a2"]).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(500);
    });

    it("fails with the batch route's 404 when no approval can be read either", async () => {
      fetchMock.mockResolvedValue(notFound());

      const error = await approvalsApi.listLinkedIssues("co-1", ["a1", "a2"]).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
    });
  });

  it("fails on any other error of the batch route, without reading per approval", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const error = await approvalsApi.listLinkedIssues("co-1", ["a1", "a2"]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
