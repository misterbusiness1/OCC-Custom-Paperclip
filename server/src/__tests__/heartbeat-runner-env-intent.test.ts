import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as agentServices from "../services/agents.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("heartbeat legacy provider normalization env intent", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-env-intent-");
    db = createDb(database.connectionString);
  }, 20_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await database?.cleanup(); });

  it("keeps concurrent env changes while upgrading only the legacy provider", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic provider intent", issuePrefix: `I${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Paused synthetic worker", status: "paused",
      adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "codex", env: { REMOVE_ME: "old", KEEP_ME: "old" } },
    });
    const nativeFactory = agentServices.agentService;
    let interleaved = false;
    vi.spyOn(agentServices, "agentService").mockImplementation((...args) => {
      const native = nativeFactory(...args);
      return { ...native, update: async (...updateArgs: Parameters<typeof native.update>) => {
        if (!interleaved && updateArgs[2]?.recordRevision?.source === "normalize_runner_provider") {
          interleaved = true;
          await nativeFactory(db).update(agentId, { adapterConfig: { provider: "codex", env: { KEEP_ME: "new", ADDED: "new" } } },
            { envUpdate: { removals: ["REMOVE_ME"] } });
        }
        return native.update(...updateArgs);
      } };
    });
    // A paused worker exercises admission/config normalization without starting a provider.
    await expect(heartbeatService(db).wakeup(agentId, { source: "on_demand", reason: "synthetic_env_intent", requestedByActorType: "system", requestedByActorId: "test" })).rejects.toMatchObject({ status: 409, message: "Agent is not invokable in its current state" });
    expect(interleaved).toBe(true);
    const [persisted] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(persisted!.adapterConfig).toMatchObject({ provider: "codex", codexPermissionMode: "never", env: { KEEP_ME: { type: "plain", value: "new" }, ADDED: { type: "plain", value: "new" } } });
    expect(persisted!.adapterConfig.env).not.toHaveProperty("REMOVE_ME");
    expect(persisted!.adapterConfig).not.toHaveProperty("acpxAgent");
  });
});
