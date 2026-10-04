import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { applyPendingMigrations, closeRegisteredClients, companies, createDb, ensurePostgresDatabase,
  getEmbeddedPostgresTestSupport, instanceSettings, issueComments, issues, runDatabaseBackup, runDatabaseRestore,
  startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { patchInstanceSettingsSchema, patchInstanceGeneralSettingsSchema, patchInstanceExperimentalSettingsSchema } from "@paperclipai/shared";
import { assertCommentRequestRollbackSafe, issueCommentRequestService, raiseBoardCommentProtocolFloor } from "../services/issue-comment-requests.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;
suite("retained Board protocol migration and restore lineage", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let backupDir: string;
  const connections: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-comment-floor-");
    db = createDb(database.connectionString); connections.push(database.connectionString);
    backupDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-comment-floor-backups-"));
  }, 30_000);
  afterAll(async () => {
    for (const connection of connections) await closeRegisteredClients(connection);
    await database?.cleanup();
    if (backupDir) await rm(backupDir, { recursive: true, force: true });
  }, 30_000);
  const floor = async () => (await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")))[0].minimumBoardCommentRequestProtocolVersion;
  async function sibling() {
    const name = `restore_${randomUUID().replaceAll("-", "")}`;
    await ensurePostgresDatabase(database.connectionString, name);
    const url = new URL(database.connectionString); url.pathname = `/${name}`;
    connections.push(url.toString()); return url.toString();
  }
  it("upgrades a pre-feature database additively and permits a zero-floor code rollback", async () => {
    const migration = await readFile(new URL("../../../packages/db/src/migrations/9007_noisy_thunderball.sql", import.meta.url), "utf8");
    const hash = createHash("sha256").update(migration).digest("hex");
    await db.execute(sql`delete from drizzle.__drizzle_migrations where hash = ${hash}`);
    await db.execute(sql`drop table issue_comment_request_effects`);
    await db.execute(sql`drop table issue_comment_requests`);
    await db.execute(sql`drop index agent_wakeup_requests_issue_comment_request_uq`);
    await db.execute(sql`alter table instance_settings drop column minimum_board_comment_request_protocol_version`);
    await expect(assertCommentRequestRollbackSafe(db, 0)).resolves.toBeUndefined();
    await applyPendingMigrations(database.connectionString);
    expect(await floor()).toBe(0);
    await expect(assertCommentRequestRollbackSafe(db, 0)).resolves.toBeUndefined();
  });
  it("restores whole snapshots from before and after acceptance with their own protocol lineage", async () => {
    const before = await runDatabaseBackup({ connectionString: database.connectionString, backupDir,
      filenamePrefix: "before-acceptance", backupEngine: "javascript", retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 3 } });
    const companyId = randomUUID(); const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lineage fixture", issuePrefix: "LIN" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retained request" });
    const service = issueCommentRequestService(db, { controls: () => ({ admission: true, dispatch: false }), authorize: async () => true, handlers: {} });
    const input = { companyId, issueId, authorUserId: "fixture", clientRequestId: randomUUID(), body: "Accepted intent" };
    await service.admit(input, async (tx) => {
      const [comment] = await tx.insert(issueComments).values({ companyId, issueId, authorUserId: input.authorUserId,
        authorType: "user", clientRequestId: input.clientRequestId, body: input.body }).returning();
      return { commentId: comment.id, effects: [] };
    });
    const after = await runDatabaseBackup({ connectionString: database.connectionString, backupDir,
      filenamePrefix: "after-acceptance", backupEngine: "javascript", retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 3 } });
    const beforeTarget = await sibling(); const afterTarget = await sibling();
    await runDatabaseRestore({ connectionString: beforeTarget, backupFile: before.backupFile });
    await runDatabaseRestore({ connectionString: afterTarget, backupFile: after.backupFile });
    await expect(assertCommentRequestRollbackSafe(createDb(beforeTarget), 0)).resolves.toBeUndefined();
    await expect(assertCommentRequestRollbackSafe(createDb(afterTarget), 0)).rejects.toThrow("Rollback target");
    expect(await floor()).toBe(1);
  }, 60_000);
  it("preserves the maximum across partial merges, settings initialization races and ordinary patches", async () => {
    await Promise.all([
      db.transaction((tx) => raiseBoardCommentProtocolFloor(tx, 0)),
      db.transaction((tx) => raiseBoardCommentProtocolFloor(tx, 2)),
      instanceSettingsService(db).get(),
    ]);
    expect(await floor()).toBe(2);
    for (const schema of [patchInstanceSettingsSchema, patchInstanceGeneralSettingsSchema, patchInstanceExperimentalSettingsSchema]) {
      const parsed = schema.safeParse({ minimumBoardCommentRequestProtocolVersion: 0 });
      if (parsed.success) expect(parsed.data).not.toHaveProperty("minimumBoardCommentRequestProtocolVersion");
    }
    const settings = instanceSettingsService(db);
    await settings.update({ defaultEnvironmentId: null });
    await settings.updateGeneral({ censorUsernameInLogs: false });
    expect(await settings.get()).not.toHaveProperty("minimumBoardCommentRequestProtocolVersion");
    expect(await floor()).toBe(2);
    await expect(assertCommentRequestRollbackSafe(db, 1)).rejects.toThrow("Rollback target");
    await expect(assertCommentRequestRollbackSafe(db, 2)).resolves.toBeUndefined();
    await expect(db.transaction((tx) => raiseBoardCommentProtocolFloor(tx, -1))).rejects.toThrow("Invalid");
    await expect(db.execute(sql`update instance_settings set minimum_board_comment_request_protocol_version = -1`)).rejects.toThrow();
  });
});
