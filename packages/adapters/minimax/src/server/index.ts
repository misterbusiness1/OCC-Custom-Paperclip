import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, models, type } from "../constants.js";
import { getConfigSchema } from "./config-schema.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export { getConfigSchema } from "./config-schema.js";
export { execute, TOOL_MARKUP_PATTERN } from "./execute.js";
export { testEnvironment } from "./test.js";

// The plugin loader calls this from the package root and registers the result.
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models,
    agentConfigurationDoc,
    getConfigSchema,
    // The heartbeat only mints a per-run agent JWT (ctx.authToken, surfaced to
    // the bash tool as PAPERCLIP_API_KEY) when the adapter opts in here.
    // Without it every Paperclip API call a tool-enabled agent makes is 401.
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    // Stateless single-turn adapter: no sessionCodec.
  };
}
