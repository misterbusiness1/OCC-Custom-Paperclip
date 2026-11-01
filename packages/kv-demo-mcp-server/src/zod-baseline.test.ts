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
import { classifyToolsListDifferences, diffToolsList } from "@paperclipai/shared/testing/mcp-tools-list-baseline";
import { createKvDemoMcpServer, createToolDefinitions, KvStore } from "./index.js";
import * as toolsModule from "./tools.js";

/**
 * zod 3 -> zod 4 baselines for the KV demo MCP server, captured on zod 3.25.76:
 * the `tools/list` result and the omitted-key behaviour of every tool input
 * schema. Differences after the migration must be
 * explained by a documented rule in @paperclipai/shared/testing/mcp-tools-list-baseline
 * or listed in TOOLS_LIST_DIFFERENCES with a reason, never re-recorded.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const zodVersion = readZodVersion(require.resolve("zod/package.json"));
const TOOLS_LIST_GOLDEN = path.join(here, "__fixtures__", "zod3-tools-list.json");
const SCHEMA_GOLDEN = path.join(here, "__fixtures__", "zod3-schema-baseline.json");

/**
 * `${toolName}${jsonPointer}` -> reason this part of the tools/list entry
 * intentionally differs from the zod 3 golden, beyond the documented rules in
 * @paperclipai/shared/testing/mcp-tools-list-baseline (REPRESENTATION_RULES,
 * CONTENT_RULES).
 */
const TOOLS_LIST_DIFFERENCES: Record<string, string> = {};

async function listTools() {
  const { server } = createKvDemoMcpServer(new KvStore());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "zod-baseline", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP tools/list baseline (kv demo)", () => {
  it("keeps every tool's name, description, annotations and input JSON Schema", async () => {
    const tools = await listTools();
    const golden = loadOrUpdateGolden(TOOLS_LIST_GOLDEN, tools, {
      zodVersion,
      note: "tools/list result of the KV demo MCP server captured before the zod 4 migration. Do not regenerate on zod 4.",
    }).data;
    expect(tools.map((tool) => tool.name)).toEqual(golden.map((tool) => tool.name));
    const { unexplained, staleDocumented } = classifyToolsListDifferences(
      diffToolsList(golden, tools),
      TOOLS_LIST_DIFFERENCES,
    );
    expect(unexplained).toEqual([]);
    expect(staleDocumented).toEqual([]);
  });
});

describe("zod schema behaviour baseline (kv demo MCP tools)", () => {
  const tools = createToolDefinitions(new KvStore());
  const roots: Record<string, unknown> = {
    ...zodExports(toolsModule as unknown as Record<string, unknown>, "tools.ts#"),
    ...Object.fromEntries(tools.map((tool) => [`tool:${tool.name}`, tool.schema])),
  };
  const current = collectSchemaBaseline(z, roots, { includeRequired: false });
  const golden = loadOrUpdateGolden<BaselineGolden>(SCHEMA_GOLDEN, current, {
    zodVersion,
    note: "Omitted-key behaviour of every KV demo MCP tool input schema captured before the zod 4 migration (absent entry = required).",
  }).data;

  it("keeps every field's omitted-key behaviour, object policy and root results", () => {
    expect(diffFieldBehaviour(golden.fields, current.fields)).toEqual([]);
    expect(current.objects).toEqual(golden.objects);
    expect(current.roots).toEqual(golden.roots);
    expect(current.defaultsUnderOptional.filter((fieldPath) => current.fields[fieldPath] !== "omitted")).toEqual([]);
  });

  it("only uses defaults, prefaults and partials inside exported consts", () => {
    expect(findUnexportedSchemaDefaults(fs.readFileSync(path.join(here, "tools.ts"), "utf8"))).toEqual([]);
  });
});
