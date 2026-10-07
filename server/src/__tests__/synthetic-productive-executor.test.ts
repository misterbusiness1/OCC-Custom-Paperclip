import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(process.cwd(), "../scripts/qa/synthetic-productive-executor.mjs");
const issueId = "11111111-1111-4111-8111-111111111111";
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function executeFixture(hasMarker: boolean) {
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
      if (request.url?.endsWith("/comments") && request.method === "GET") {
        response.end(JSON.stringify(hasMarker ? [{ body: "[synthetic-timer-provenance] productive terminal marker" }] : []));
      } else if (request.url === `/api/issues/${issueId}` && request.method === "GET") {
        response.end(JSON.stringify({ id: issueId, status: "in_progress" }));
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
});
