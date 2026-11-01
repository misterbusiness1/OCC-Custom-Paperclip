import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  collectSchemaBaseline,
  diffFieldBehaviour,
  findUnexportedSchemaDefaults,
  zodExports,
} from "@paperclipai/shared/testing/zod-schema-baseline";
import { loadOrUpdateGolden, readZodVersion, type BaselineGolden } from "@paperclipai/shared/testing/zod-baseline-golden";
import { createPaperclipMcpServer } from "./index.js";
import * as toolsModule from "./tools.js";

/**
 * zod 3 -> zod 4 baselines for the Paperclip MCP server, captured on zod 3.25.76:
 * - the `tools/list` result agents see (names, descriptions, input JSON Schemas),
 * - the omitted-key behaviour of every tool input schema and exported schema.
 * Differences after the migration must be listed in TOOLS_LIST_DIFFERENCES with
 * a reason, never re-recorded.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const zodVersion = readZodVersion(require.resolve("zod/package.json"));
const TOOLS_LIST_GOLDEN = path.join(here, "__fixtures__", "zod3-tools-list.json");
const SCHEMA_GOLDEN = path.join(here, "__fixtures__", "zod3-schema-baseline.json");

/** `${toolName}` -> reason the tools/list entry intentionally differs from the zod 3 golden. */
const TOOLS_LIST_DIFFERENCES: Record<string, string> = {};

const config = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
};

async function listTools() {
  const { server } = createPaperclipMcpServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "zod-baseline", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.listTools();
    return result.tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP tools/list baseline (paperclip)", () => {
  it("keeps every tool's name, description and input JSON Schema", async () => {
    const tools = await listTools();
    const golden = loadOrUpdateGolden(TOOLS_LIST_GOLDEN, tools, {
      zodVersion,
      note: "tools/list result of the Paperclip MCP server captured before the zod 4 migration. Do not regenerate on zod 4.",
    }).data;
    expect(tools.map((tool) => tool.name)).toEqual(golden.map((tool) => tool.name));
    const goldenByName = new Map(golden.map((tool) => [tool.name, tool]));
    const changed = tools
      .filter((tool) => JSON.stringify(tool) !== JSON.stringify(goldenByName.get(tool.name)))
      .map((tool) => tool.name)
      .filter((name) => !TOOLS_LIST_DIFFERENCES[name]);
    expect(changed).toEqual([]);
  });
});

describe("zod schema behaviour baseline (paperclip MCP tools)", () => {
  const { tools } = createPaperclipMcpServer(config);
  const roots: Record<string, unknown> = {
    ...zodExports(toolsModule as unknown as Record<string, unknown>, "tools.ts#"),
    ...Object.fromEntries(tools.map((tool) => [`tool:${tool.name}`, tool.schema])),
  };
  const current = collectSchemaBaseline(z, roots, { includeRequired: false });
  const golden = loadOrUpdateGolden<BaselineGolden>(SCHEMA_GOLDEN, current, {
    zodVersion,
    note:
      "Omitted-key behaviour of every MCP tool input schema captured before the zod 4 migration (absent entry = required). " +
      "Do not regenerate on zod 4.",
  }).data;

  it("keeps every field's omitted-key behaviour", () => {
    expect(Object.keys(current.roots).sort()).toEqual(Object.keys(golden.roots).sort());
    expect(diffFieldBehaviour(golden.fields, current.fields)).toEqual([]);
  });

  it("keeps every object's unknown-key policy and root results", () => {
    expect(current.objects).toEqual(golden.objects);
    expect(current.roots).toEqual(golden.roots);
  });

  it("leaves every default that sits under .optional() unapplied for an omitted key", () => {
    expect(current.defaultsUnderOptional.filter((fieldPath) => current.fields[fieldPath] !== "omitted")).toEqual([]);
  });

  it("only uses defaults, prefaults and partials inside exported consts", () => {
    const source = fs.readFileSync(path.join(here, "tools.ts"), "utf8");
    expect(findUnexportedSchemaDefaults(source)).toEqual([]);
  });
});
