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
import type { GoogleSheetsMcpConfig } from "./config.js";
import type { GoogleSheetsClient } from "./google-client.js";
import { createGoogleSheetsMcpServer } from "./index.js";
import * as configModule from "./config.js";
import * as toolsModule from "./tools.js";

/**
 * zod 3 -> zod 4 baselines for the Google Sheets MCP server, captured on
 * zod 3.25.76: the `tools/list` result and the omitted-key behaviour of every
 * tool input schema and config schema. Differences after the migration must be
 * listed in TOOLS_LIST_DIFFERENCES with a reason, never re-recorded.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const zodVersion = readZodVersion(require.resolve("zod/package.json"));
const TOOLS_LIST_GOLDEN = path.join(here, "__fixtures__", "zod3-tools-list.json");
const SCHEMA_GOLDEN = path.join(here, "__fixtures__", "zod3-schema-baseline.json");

/** `${toolName}` -> reason the tools/list entry intentionally differs from the zod 3 golden. */
const TOOLS_LIST_DIFFERENCES: Record<string, string> = {};

const config: GoogleSheetsMcpConfig = {
  serviceAccount: { client_email: "service@example.test", private_key: "fake-key" },
  allowedSpreadsheetIds: ["sheet-1"],
  secretRedactions: [],
};

// The tools are only listed, never executed, so the client is never called.
const client = {} as GoogleSheetsClient;

async function listTools() {
  const { server } = createGoogleSheetsMcpServer(config, { client });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "zod-baseline", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  try {
    return (await mcpClient.listTools()).tools;
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

describe("MCP tools/list baseline (google sheets)", () => {
  it("keeps every tool's name, description, annotations and input JSON Schema", async () => {
    const tools = await listTools();
    const golden = loadOrUpdateGolden(TOOLS_LIST_GOLDEN, tools, {
      zodVersion,
      note: "tools/list result of the Google Sheets MCP server captured before the zod 4 migration. Do not regenerate on zod 4.",
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

describe("zod schema behaviour baseline (google sheets MCP tools)", () => {
  const { tools } = createGoogleSheetsMcpServer(config, { client });
  const roots: Record<string, unknown> = {
    ...zodExports(configModule as unknown as Record<string, unknown>, "config.ts#"),
    ...zodExports(toolsModule as unknown as Record<string, unknown>, "tools.ts#"),
    ...Object.fromEntries(tools.map((tool) => [`tool:${tool.name}`, tool.schema])),
  };
  const current = collectSchemaBaseline(z, roots, { includeRequired: false });
  const golden = loadOrUpdateGolden<BaselineGolden>(SCHEMA_GOLDEN, current, {
    zodVersion,
    note: "Omitted-key behaviour of every Google Sheets MCP tool input schema captured before the zod 4 migration (absent entry = required).",
  }).data;

  it("keeps every field's omitted-key behaviour, object policy and root results", () => {
    expect(diffFieldBehaviour(golden.fields, current.fields)).toEqual([]);
    expect(current.objects).toEqual(golden.objects);
    expect(current.roots).toEqual(golden.roots);
    expect(current.defaultsUnderOptional.filter((fieldPath) => current.fields[fieldPath] !== "omitted")).toEqual([]);
  });

  it("only uses defaults, prefaults and partials inside exported consts", () => {
    for (const file of ["tools.ts", "config.ts"]) {
      expect(findUnexportedSchemaDefaults(fs.readFileSync(path.join(here, file), "utf8"))).toEqual([]);
    }
  });
});
