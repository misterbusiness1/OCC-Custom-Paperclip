// Package root. Paperclip's external-adapter plugin loader imports this module
// (package.json exports["."]) and requires createServerAdapter(). Constants
// live in the leaf ./constants.js so the module-init graph stays acyclic
// (server/* import constants, never this index).
export * from "./constants.js";
export { createServerAdapter, getConfigSchema } from "./server/index.js";
