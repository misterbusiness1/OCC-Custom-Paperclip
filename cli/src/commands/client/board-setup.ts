import type { Company } from "@paperclipai/shared";
import { ApiRequestError } from "../../client/http.js";
import { apiPath, resolveCommandContext, type BaseClientOptions, type ResolvedClientContext } from "./common.js";

export interface BoardSetupOptions extends BaseClientOptions {
  companyId?: string;
}

export interface BoardSetupResult {
  apiBase: string;
  companyId: string | null;
  companyName: string | null;
  /** Companies visible to the board when no single company could be chosen. */
  companies: Array<{ id: string; name: string }>;
}

export interface BoardSetupIo {
  /** Receives human-facing notes. The command sends them to stderr, never to the eval'd stdout. */
  warn?: (message: string) => void;
}

// Company ids are Postgres UUIDs. The exact string that will be printed is
// tested (shared `isUuidLike` trims its input, so an id ending in "\n" would
// pass it), because stdout is meant for `eval`.
const SAFE_COMPANY_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function assertSafeCompanyId(id: unknown): string {
  if (typeof id === "string" && SAFE_COMPANY_ID_RE.test(id)) return id;
  throw new Error(`Refusing to print company id ${quoteForDisplay(id)} returned by the server: it is not a UUID.`);
}

/** JSON-quoted for error messages; JSON leaves C1 controls and U+2028/U+2029 unescaped. */
function quoteForDisplay(value: unknown): string {
  return toDisplayText(JSON.stringify(value) ?? String(value));
}

/** Server-controlled text as a single line with no control characters. */
function toDisplayText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
}

function describeCompanyIdSource(opts: BoardSetupOptions): string {
  if (opts.companyId?.trim()) return "Check the id passed to --company-id.";
  if (process.env.PAPERCLIP_COMPANY_ID?.trim()) {
    return "PAPERCLIP_COMPANY_ID may be stale: run `unset PAPERCLIP_COMPANY_ID` and re-run board setup, or pass --company-id <id>.";
  }
  return "It comes from the context profile: pass --company-id <id>, or update it with `paperclipai context set --company-id <id>`.";
}

/** Board login stored by `paperclipai auth login` (or obtained interactively), which is not exported. */
function usesUnexportedBoardLogin(ctx: ResolvedClientContext): boolean {
  return ctx.authSource === "stored_board" || (ctx.authSource === "none" && Boolean(ctx.api.apiKey));
}

function withBoardAuthHint(err: unknown, ctx: ResolvedClientContext): unknown {
  if (!(err instanceof ApiRequestError)) return err;
  if (ctx.authSource !== "none" && ctx.authSource !== "stored_board") return err;
  const boardAuthRequired =
    err.status === 401 || (err.status === 403 && err.message.includes("Board access required"));
  if (!boardAuthRequired) return err;
  const reason =
    ctx.authSource === "stored_board"
      ? "the board login stored by `paperclipai auth login` was rejected"
      : "no API key is configured";
  return new Error(
    `${ctx.api.apiBase} requires board authentication and ${reason} (API error ${err.status}: ${toDisplayText(err.message)}). ` +
      "Run `paperclipai auth login` to sign this CLI in, or set a board API key with " +
      "`export PAPERCLIP_API_KEY=<board API key>` (the paperclip-board skill needs the key for its own API calls; " +
      "create one with `paperclipai token board create`), then re-run board setup.",
  );
}

async function resolveBoardCompany(
  ctx: ResolvedClientContext,
  opts: BoardSetupOptions,
): Promise<Omit<BoardSetupResult, "apiBase">> {
  if (ctx.companyId) {
    const company = await ctx.api.get<Company>(apiPath`/api/companies/${ctx.companyId}`, { ignoreNotFound: true });
    if (!company) {
      throw new Error(
        `Company ${quoteForDisplay(ctx.companyId)} was not found on ${ctx.api.apiBase}. ${describeCompanyIdSource(opts)}`,
      );
    }
    return { companyId: assertSafeCompanyId(company.id), companyName: company.name, companies: [] };
  }

  // Archived companies are hidden in the UI and must not be auto-selected.
  const companies = ((await ctx.api.get<Company[]>("/api/companies")) ?? [])
    .filter((company) => company.status !== "archived")
    .map((company) => ({ id: assertSafeCompanyId(company.id), name: company.name }));
  if (companies.length === 1) {
    const [only] = companies;
    return { companyId: only!.id, companyName: only!.name, companies: [] };
  }
  return { companyId: null, companyName: null, companies };
}

/**
 * Resolve the environment the paperclip-board skill expects
 * (PAPERCLIP_API_URL and PAPERCLIP_COMPANY_ID) from the CLI context.
 *
 * The company comes from --company-id / PAPERCLIP_COMPANY_ID / the context
 * profile; otherwise, when the board can see exactly one unarchived company,
 * that one is used. Every company id is checked to be a UUID before it can
 * reach the output. Board API keys are never printed.
 */
export async function runBoardSetup(opts: BoardSetupOptions, io: BoardSetupIo = {}): Promise<BoardSetupResult> {
  const ctx = resolveCommandContext(opts);
  let resolved: Omit<BoardSetupResult, "apiBase">;
  try {
    resolved = await resolveBoardCompany(ctx, opts);
  } catch (err) {
    throw withBoardAuthHint(err, ctx);
  }
  if (usesUnexportedBoardLogin(ctx)) {
    io.warn?.(
      "Note: board setup used the board login stored by `paperclipai auth login`, which it does not export. " +
        "If this server requires authentication, also run `export PAPERCLIP_API_KEY=<board API key>` " +
        "(create one with `paperclipai token board create`) so tools that call the API directly, " +
        "such as the paperclip-board skill, are authenticated.",
    );
  }
  return { apiBase: ctx.api.apiBase, ...resolved };
}

/** Shell exports for stdout. Only the user-supplied API base and UUID-checked ids appear here. */
export function formatBoardSetupExports(result: BoardSetupResult): string {
  const lines = [`export PAPERCLIP_API_URL=${shellQuote(result.apiBase)}`];
  if (result.companyId) {
    lines.push(`export PAPERCLIP_COMPANY_ID=${shellQuote(assertSafeCompanyId(result.companyId))}`);
  } else if (result.companies.length === 0) {
    lines.push("export PAPERCLIP_COMPANY_ID=''");
  }
  return lines.join("\n");
}

/**
 * Human-facing guidance for stderr, so it stays visible under
 * `eval "$(paperclipai board setup)"` and server-controlled names never reach
 * the evaluated text.
 */
export function formatBoardSetupNotice(result: BoardSetupResult): string | null {
  if (result.companyId) return null;
  if (result.companies.length === 0) {
    return "No companies are available yet (archived companies are skipped). Create one, then re-run `paperclipai board setup`.";
  }
  return [
    "Several companies are available, so PAPERCLIP_COMPANY_ID was not set. Re-run with --company-id <id>:",
    ...result.companies.map((company) => `  ${assertSafeCompanyId(company.id)}  ${toDisplayText(company.name)}`),
  ].join("\n");
}
