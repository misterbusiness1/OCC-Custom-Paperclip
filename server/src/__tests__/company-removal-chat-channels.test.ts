// Fork: company removal must not be blocked by the v2026.916.1 chat-channel and
// managed-agent-profile rows that reference the company's issues, comments,
// agents and secrets with RESTRICT / NO ACTION foreign keys. Rows are inserted
// with FK triggers disabled (session_replication_role = replica) so the fixture
// stays schema-agnostic; the DELETEs in companyService.remove() run with the
// normal FK checks and therefore prove the removal order.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const TABLES = [
  "company_secrets",
  "managed_agent_profiles",
  "chat_endpoints",
  "chat_conversations",
  "chat_publications",
  "chat_message_links",
  "chat_teams_file_transfers",
];

d("company removal with chat rows", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-chat-removal-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function rows(q: string): Promise<any[]> {
    const r: any = await db.execute(sql.raw(q));
    return Array.isArray(r) ? r : r.rows;
  }

  it("removes a company whose issues/comments/agents/secrets are referenced by chat rows", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    const secretId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Chat Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Bot", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "t", status: "todo", priority: "medium",
      assigneeAgentId: agentId, createdByUserId: "user-1",
    });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorAgentId: agentId, body: "c" });

    const overrides: Record<string, string> = {
      company_id: `'${companyId}'`,
      issue_id: `'${issueId}'`,
      comment_id: `'${commentId}'`,
      assigned_agent_id: `'${agentId}'`,
      api_key_secret_id: `'${secretId}'`,
    };
    for (const table of TABLES) {
      for (const c of await rows(
        `select conname from pg_constraint where conrelid = 'public.${table}'::regclass and contype = 'c'`,
      )) {
        await db.execute(sql.raw(`alter table "${table}" drop constraint "${c.conname}"`));
      }
      const cols = await rows(
        `select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='${table}'`,
      );
      const names: string[] = [];
      const values: string[] = [];
      for (const col of cols) {
        const name = col.column_name as string;
        let v: string | null = null;
        if (overrides[name] && !(table === "company_secrets" && name !== "company_id")) v = overrides[name];
        else if (table === "company_secrets" && name === "id") v = `'${secretId}'`;
        else if (col.is_nullable === "NO" && col.column_default == null) {
          const t = col.data_type as string;
          v = t === "uuid" ? "gen_random_uuid()"
            : t === "integer" || t === "bigint" || t === "smallint" || t === "numeric" ? "1"
            : t === "boolean" ? "false"
            : t === "jsonb" || t === "json" ? `'{}'`
            : t.startsWith("timestamp") ? "now()"
            : t === "ARRAY" ? `'{}'`
            : `'x-${randomUUID()}'`;
        }
        if (v !== null) { names.push(`"${name}"`); values.push(v); }
      }
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local session_replication_role = replica`));
        await tx.execute(sql.raw(`insert into "${table}" (${names.join(",")}) values (${values.join(",")})`));
      });
    }

    const removed = await companyService(db).remove(companyId);
    expect(removed?.id).toBe(companyId);
    for (const table of TABLES) {
      const left = await rows(`select count(*)::int as n from "${table}" where company_id = '${companyId}'`);
      expect(left[0].n, table).toBe(0);
    }
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
  });
});
