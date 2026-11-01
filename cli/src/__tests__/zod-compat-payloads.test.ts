import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentCommands } from "../commands/client/agent.js";
import { registerGoalCommands } from "../commands/client/goal.js";
import { registerIssueCommands } from "../commands/client/issue.js";
import { registerProjectCommands } from "../commands/client/project.js";
import { readConfig } from "../config/store.js";

/**
 * zod 4 applies a `.default()` that sits under `.optional()`/`.partial()` when
 * the key is missing; zod 3 left the key out. The CLI validates PATCH bodies
 * with the shared update schemas before sending them, so these tests pin that
 * an omitted field is still not sent, and that validation errors keep zod 3's
 * text.
 */

const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const PRODUCT_ID = "77777777-7777-4777-8777-777777777777";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const GOAL_ID = "55555555-5555-4555-8555-555555555555";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerIssueCommands(program);
  registerProjectCommands(program);
  registerAgentCommands(program);
  registerGoalCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

function sentBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map((call) => ({
    method: (call[1] as RequestInit | undefined)?.method,
    url: String(call[0]),
    body: JSON.parse(String((call[1] as RequestInit | undefined)?.body)),
  }));
}

describe("CLI update payloads and validation errors on zod 4", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
    process.env.PAPERCLIP_CONTEXT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-zod-compat-")), "context.json");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_CONTEXT;
  });

  it("sends only the fields an update command names", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: true }))));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "update", ISSUE_ID, "--title", "New title"]);
    await run(["issue", "work-product:update", PRODUCT_ID, "--payload-json", JSON.stringify({ title: "Updated PR" })]);
    await run(["project", "update", PROJECT_ID, "--status", "in_progress"]);
    await run(["agent", "update", AGENT_ID, "--payload-json", JSON.stringify({ title: "Senior Builder" })]);
    await run(["goal", "update", GOAL_ID, "--title", "Ship it"]);

    // zod 3 never applied the defaults of updateIssueSchema (priority, workMode),
    // updateIssueWorkProductSchema, updateProjectSchema, updateAgentSchema
    // (adapterConfig, runtimeConfig, ...) or updateGoalSchema to omitted keys.
    expect(sentBodies(fetchMock)).toEqual([
      { method: "PATCH", url: `http://localhost:3100/api/issues/${ISSUE_ID}`, body: { title: "New title" } },
      { method: "PATCH", url: `http://localhost:3100/api/work-products/${PRODUCT_ID}`, body: { title: "Updated PR" } },
      { method: "PATCH", url: `http://localhost:3100/api/projects/${PROJECT_ID}`, body: { status: "in_progress" } },
      { method: "PATCH", url: `http://localhost:3100/api/agents/${AGENT_ID}`, body: { title: "Senior Builder" } },
      { method: "PATCH", url: `http://localhost:3100/api/goals/${GOAL_ID}`, body: { title: "Ship it" } },
    ]);
  });

  it("prints zod 3's issue text when a command's input is invalid", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(run(["issue", "update", ISSUE_ID, "--priority", "bogus"])).rejects.toThrow("process.exit(1)");

    expect(fetchMock).not.toHaveBeenCalled();
    // ZodError.message recorded with zod 3.25.76 for an invalid enum value at `priority`.
    expect(errors.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""))).toEqual([
      "[\n  {\n    \"received\": \"bogus\",\n    \"code\": \"invalid_enum_value\",\n    \"options\": [\n" +
        "      \"critical\",\n      \"high\",\n      \"medium\",\n      \"low\"\n    ],\n    \"path\": [\n" +
        "      \"priority\"\n    ],\n    \"message\": \"Invalid enum value. Expected 'critical' | 'high' | 'medium' | 'low', received 'bogus'\"\n  }\n]",
    ]);
  });

  it("words config file issues as zod 3 did", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-zod-compat-config-"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      $meta: { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", source: "onboard" },
      database: { mode: "embedded-postgres", embeddedPostgresPort: "abc" },
      logging: { mode: "file" },
      server: { port: -1, deploymentMode: "nope" },
    }));

    // Message from readConfig on the zod 3.25.76 tree (origin/master before the migration).
    expect(() => readConfig(configPath)).toThrow(
      `Invalid config at ${configPath}: database.embeddedPostgresPort: Expected number, received string; ` +
        "server.deploymentMode: Invalid enum value. Expected 'local_trusted' | 'authenticated', received 'nope'; " +
        "server.port: Number must be greater than or equal to 1",
    );
  });
});
