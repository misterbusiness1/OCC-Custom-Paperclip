import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/qa/synthetic-productive-executor.mjs",
);
const issueId = "11111111-1111-4111-8111-111111111111";
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function executeFixture(hasMarker: boolean, options: { checkoutStatus?: number; cwd?: string } = {}) {
  const requests: Array<{ method: string; url: string; body: string; runId: string | undefined }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "",
        body,
        runId: request.headers["x-paperclip-run-id"] as string | undefined,
      });
      response.setHeader("content-type", "application/json");
      if (request.url === `/api/issues/${issueId}/checkout` && request.method === "POST") {
        response.statusCode = options.checkoutStatus ?? 200;
        response.end(options.checkoutStatus && options.checkoutStatus !== 200
          ? JSON.stringify({ error: "Issue checkout conflict" })
          : JSON.stringify({
              id: issueId,
              status: "in_progress",
              checkoutRunId: "22222222-2222-4222-8222-222222222222",
              executionRunId: "22222222-2222-4222-8222-222222222222",
            }));
      } else if (request.url?.endsWith("/comments") && request.method === "GET") {
        response.end(JSON.stringify(hasMarker ? [{ body: "[synthetic-timer-provenance] productive terminal marker" }] : []));
      } else if (request.url === `/api/issues/${issueId}` && request.method === "GET") {
        response.end(JSON.stringify({ id: issueId, status: "in_progress", assigneeAgentId: "33333333-3333-4333-8333-333333333333" }));
      } else {
        response.end(JSON.stringify({ ok: true, status: "done" }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [script, issueId], {
      cwd: options.cwd,
      env: {
        ...process.env,
        PAPERCLIP_API_URL: `http://127.0.0.1:${address.port}`,
        PAPERCLIP_API_KEY: "synthetic-token",
        PAPERCLIP_RUN_ID: "22222222-2222-4222-8222-222222222222",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { requests, result };
}

describe("synthetic productive executor", () => {
  it("records one run-scoped productive marker without completing the issue", async () => {
    const { requests, result } = await executeFixture(false);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("leaving issue in progress");
    const mutation = requests.find((request) => request.method === "POST");
    expect(mutation).toMatchObject({
      url: `/api/issues/${issueId}/checkout`,
      runId: "22222222-2222-4222-8222-222222222222",
    });
    expect(JSON.parse(mutation?.body ?? "{}")).toEqual({
      agentId: "33333333-3333-4333-8333-333333333333",
      expectedStatuses: ["in_progress"],
    });
    const markerMutation = requests.find((request) => request.url.endsWith("/comments") && request.method === "POST");
    expect(markerMutation).toMatchObject({
      url: `/api/issues/${issueId}/comments`,
      runId: "22222222-2222-4222-8222-222222222222",
    });
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("completes the same issue on its deterministic continuation", async () => {
    const { requests, result } = await executeFixture(true);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("continuation completed");
    const mutation = requests.find((request) => request.method === "PATCH");
    expect(mutation?.url).toBe(`/api/issues/${issueId}`);
    expect(JSON.parse(mutation?.body ?? "{}")).toMatchObject({ status: "done" });
  });

  it("runs from a non-root process-adapter cwd when configured with the absolute script path", async () => {
    const { result } = await executeFixture(false, { cwd: path.dirname(script) });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("leaving issue in progress");
  });

  it("fails closed when a different run already owns the issue", async () => {
    const { requests, result } = await executeFixture(false, { checkoutStatus: 409 });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Issue checkout conflict");
    expect(requests.some((request) => request.url.endsWith("/comments"))).toBe(false);
  });
});
