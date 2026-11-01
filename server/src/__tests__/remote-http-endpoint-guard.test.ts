import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicRemoteHttpEndpoint, fetchRemoteHttpEndpoint } from "../services/remote-http-endpoint-guard.js";

function guardError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

describe("remote HTTP endpoint guard", () => {
  it("blocks hostnames that resolve to private network addresses", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://metadata.example/mcp"),
      { lookup: async () => [{ address: "10.0.0.12", family: 4 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("allows hostnames when every resolved address is public", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://public.example/mcp"),
      { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      guardError,
    )).resolves.toBeUndefined();
  });

  it.each([
    "http://[2001::1]/mcp",
    "http://[2001:20::1]/mcp",
    "http://[2001:2f::1]/mcp",
    "http://[64:ff9b:1::1]/mcp",
  ])("rejects reserved IPv6 endpoint %s", async (url) => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      {},
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });
});


describe("socket-bound remote HTTP guard", () => {
  afterEach(() => vi.restoreAllMocks());
  it("rejects DNS rebinding between preflight and socket resolution before connecting", async () => {
    let lookups = 0;
    const policyError = Object.assign(new Error("synthetic private endpoint"), { status: 422, code: "remote_http_private_endpoint" });
    await expect(fetchRemoteHttpEndpoint(
      new URL("http://rebinding.invalid:41999/token"),
      { method: "POST", headers: { authorization: "Bearer synthetic-regression-token" }, body: "synthetic" },
      {
        lookup: async () => {
          lookups += 1;
          // No real DNS or private service: the connector must reject this
          // second answer before it can create a TCP connection.
          return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
        },
      },
      () => policyError,
    )).rejects.toBe(policyError);
    expect(lookups).toBe(2);
  });

  it("rejects a mixed public/private socket DNS answer in its entirety", async () => {
    let lookups = 0;
    await expect(fetchRemoteHttpEndpoint(
      new URL("http://mixed-rebinding.invalid:41999/token"),
      { method: "POST", body: "synthetic" },
      {
        lookup: async () => {
          lookups += 1;
          return lookups === 1
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }];
        },
      },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    expect(lookups).toBe(2);
  });
});


describe("guarded request deadlines", () => {
  afterEach(() => vi.restoreAllMocks());

  it("bounds requests without a deadline and preserves an explicit caller deadline", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const endpoint = new URL("http://localhost/synthetic");
    await fetchRemoteHttpEndpoint(endpoint, {}, { allowPrivateNetwork: true }, guardError);
    const fallback = fetchMock.mock.calls[0]![1]!.signal;
    expect(fallback).toBe(timeoutController.signal);
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fallback!.aborted).toBe(false);
    timeoutController.abort();
    expect(fallback!.aborted).toBe(true);
    const controller = new AbortController();
    await fetchRemoteHttpEndpoint(endpoint, { signal: controller.signal }, { allowPrivateNetwork: true }, guardError);
    expect(fetchMock.mock.calls[1]![1]!.signal).toBe(controller.signal);
    expect(timeout).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(fetchMock.mock.calls[1]![1]!.signal!.aborted).toBe(true);
  });
});
