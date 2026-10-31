import type { Company } from "@paperclipai/shared";
import { apiPath, resolveCommandContext, type BaseClientOptions } from "./common.js";

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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Resolve the environment the paperclip-board skill expects
 * (PAPERCLIP_API_URL and PAPERCLIP_COMPANY_ID) from the CLI context.
 *
 * The company comes from --company-id / PAPERCLIP_COMPANY_ID / the context
 * profile; otherwise, when the board can see exactly one company, that one is
 * used. Board API keys are never printed.
 */
export async function runBoardSetup(opts: BoardSetupOptions): Promise<BoardSetupResult> {
  const ctx = resolveCommandContext(opts);
  const apiBase = ctx.api.apiBase;

  if (ctx.companyId) {
    const company = await ctx.api.get<Company>(apiPath`/api/companies/${ctx.companyId}`);
    if (!company) throw new Error(`Company ${ctx.companyId} was not found.`);
    return { apiBase, companyId: company.id, companyName: company.name, companies: [] };
  }

  const companies = (await ctx.api.get<Company[]>("/api/companies")) ?? [];
  if (companies.length === 1) {
    const [only] = companies;
    return { apiBase, companyId: only!.id, companyName: only!.name, companies: [] };
  }
  return {
    apiBase,
    companyId: null,
    companyName: null,
    companies: companies.map((company) => ({ id: company.id, name: company.name })),
  };
}

export function formatBoardSetupExports(result: BoardSetupResult): string {
  const lines = [`export PAPERCLIP_API_URL=${shellQuote(result.apiBase)}`];
  if (result.companyId) {
    lines.push(`export PAPERCLIP_COMPANY_ID=${shellQuote(result.companyId)}`);
  } else if (result.companies.length === 0) {
    lines.push("# No companies exist yet. Create one, then re-run `paperclipai board setup`.");
    lines.push("export PAPERCLIP_COMPANY_ID=''");
  } else {
    lines.push("# Several companies are available. Re-run with --company-id <id>:");
    for (const company of result.companies) {
      lines.push(`#   ${company.id}  ${company.name.replace(/[\r\n]+/g, " ")}`);
    }
  }
  return lines.join("\n");
}
