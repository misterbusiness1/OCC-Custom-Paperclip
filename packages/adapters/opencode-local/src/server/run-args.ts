import { asStringArray } from "@paperclipai/adapter-utils/server-utils";

// OpenCode 1.19.0 packages/opencode/src/cli/cmd/run.ts declares -c/-s
// for continue/session and these value-consuming aliases. Yargs permits
// bundled short flags; a value alias consumes the rest (e.g. -mcustom/model).
const ROUTING_SHORT_ALIASES = new Set(["c", "s"]);
const VALUE_SHORT_ALIASES = new Set(["m", "f", "p", "u"]);
const ROUTING_LONG_OPTION = /^--(?:no-)?(?:dir|session|continue|fork|attach)(?:=|$)/;

export function resolveOpenCodeExtraArgs(config: Record<string, unknown>): string[] {
  const configured = asStringArray(config.extraArgs);
  const args = configured.length > 0 ? configured : asStringArray(config.args);
  for (const arg of args) {
    let overridesRouting = ROUTING_LONG_OPTION.test(arg);
    if (/^-[^-]/.test(arg)) {
      for (const flag of arg.slice(1)) {
        if (ROUTING_SHORT_ALIASES.has(flag)) { overridesRouting = true; break; }
        if (VALUE_SHORT_ALIASES.has(flag) || flag === "=") break;
      }
    }
    if (overridesRouting) {
      throw new Error("OpenCode extraArgs/args must not override Paperclip workspace or session routing (--dir, --session/-s, --continue/-c, --fork, --attach).");
    }
  }
  return args;
}
