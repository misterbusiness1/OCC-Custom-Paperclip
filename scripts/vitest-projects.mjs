// Shared project registration for Vitest and the complete stable test runner.
// Add projects here so a new Vitest project cannot be omitted from the test lanes.
export const vitestProjects = Object.freeze([
  {
    "path": "packages/shared",
    "name": "@paperclipai/shared"
  },
  {
    "path": "packages/skills-catalog",
    "name": "@paperclipai/skills-catalog"
  },
  {
    "path": "packages/db",
    "name": "@paperclipai/db"
  },
  {
    "path": "packages/adapter-utils",
    "name": "@paperclipai/adapter-utils"
  },
  {
    "path": "packages/adapters/claude-local",
    "name": "@paperclipai/adapter-claude-local"
  },
  {
    "path": "packages/adapters/codex-local",
    "name": "@paperclipai/adapter-codex-local"
  },
  {
    "path": "packages/adapters/cursor-cloud",
    "name": "@paperclipai/adapter-cursor-cloud"
  },
  {
    "path": "packages/adapters/cursor-local",
    "name": "@paperclipai/adapter-cursor-local"
  },
  {
    "path": "packages/adapters/gemini-local",
    "name": "@paperclipai/adapter-gemini-local"
  },
  {
    "path": "packages/adapters/grok-local",
    "name": "@paperclipai/adapter-grok-local"
  },
  {
    "path": "packages/adapters/kimi-local",
    "name": "@paperclipai/adapter-kimi-local"
  },
  {
    "path": "packages/adapters/openclaw-gateway",
    "name": "@paperclipai/adapter-openclaw-gateway"
  },
  {
    "path": "packages/adapters/opencode-local",
    "name": "@paperclipai/adapter-opencode-local"
  },
  {
    "path": "packages/adapters/pi-local",
    "name": "@paperclipai/adapter-pi-local"
  },
  {
    "path": "packages/plugins/sdk",
    "name": "@paperclipai/plugin-sdk"
  },
  {
    "path": "packages/plugins/create-paperclip-plugin",
    "name": "@paperclipai/create-paperclip-plugin"
  },
  {
    "path": "packages/plugins/sandbox-providers/daytona",
    "name": "@paperclipai/plugin-daytona"
  },
  {
    "path": "server",
    "name": "@paperclipai/server"
  },
  {
    "path": "ui",
    "name": "@paperclipai/ui"
  },
  {
    "path": "cli",
    "name": "paperclipai"
  }
]);

export const vitestProjectPaths = vitestProjects.map((project) => project.path);
