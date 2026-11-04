import fs from "node:fs/promises";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { firstNonEmptyString, readAdapterEnvString } from "./util.js";

export interface ResolvedCredential {
  key: string;
  // "company" — supplied by the tenant's adapter config (a resolved secret_ref).
  // "host"    — the operator's shared process.env credential.
  source: "company" | "host";
}

export type CredentialResolution =
  | { ok: true; credential: ResolvedCredential }
  | { ok: false; reason: string };

// Resolve the MiniMax API key used for the Authorization header. Single source
// of truth for both execute() and the environment probe so the pre-run gate
// and the real run never disagree on the chosen credential.
//
// Security: a tenant may supply a key value (env.MINIMAX_API_KEY, typically a
// resolved secret_ref) but may NOT point at an arbitrary host file. Key FILES
// are operator-only (process.env.MINIMAX_API_KEY_FILE); honoring a
// tenant-supplied file path was an arbitrary-host-file-read + exfiltration
// vector, so config.env.MINIMAX_API_KEY_FILE is intentionally ignored.
export async function resolveMiniMaxCredential(
  config: Record<string, unknown>,
): Promise<CredentialResolution> {
  const env = parseObject(config.env);

  const company = readAdapterEnvString(env.MINIMAX_API_KEY);
  if (company) return { ok: true, credential: { key: company, source: "company" } };

  const hostKey = firstNonEmptyString(process.env.MINIMAX_API_KEY);
  if (hostKey) return { ok: true, credential: { key: hostKey, source: "host" } };

  const hostKeyFile = firstNonEmptyString(process.env.MINIMAX_API_KEY_FILE);
  if (hostKeyFile) {
    try {
      const raw = await fs.readFile(hostKeyFile, "utf8");
      const key = raw.trim();
      if (key) return { ok: true, credential: { key, source: "host" } };
    } catch {
      // fall through to the missing-key error
    }
  }

  return {
    ok: false,
    reason:
      "MiniMax API key is missing. Set env.MINIMAX_API_KEY on the agent (recommended, e.g. a secret reference) " +
      "or configure the operator MINIMAX_API_KEY / MINIMAX_API_KEY_FILE on the Paperclip host.",
  };
}
