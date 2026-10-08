import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvals, companies, createDb, issueApprovals, issues } from "@paperclipai/db";
import { issueApprovalService } from "../services/issue-approvals.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The batch read behind the linked-task chips of the approvals queue, against a
// real database: the company boundary is in the query itself.
describeEmbeddedPostgres("linked issues of several approvals in one read", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-linked-issues-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([companyId, otherCompanyId].map((id) => ({
      id,
      name: "Paperclip",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    })));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApproval(company = companyId) {
    const [row] = await db
      .insert(approvals)
      .values({ companyId: company, type: "request_board_approval", payload: { title: "A request" } })
      .returning();
    return row!.id;
  }

  async function createIssue(title: string, identifier: string | null, company = companyId) {
    const [row] = await db
      .insert(issues)
      .values({
        companyId: company,
        title,
        description: "A long description the chips never need.",
        status: "in_review",
        priority: "medium",
        identifier,
      })
      .returning();
    return row!.id;
  }

  async function link(approvalId: string, issueId: string, createdAt: Date, company = companyId) {
    await db.insert(issueApprovals).values({ companyId: company, approvalId, issueId, createdAt });
  }

  it("returns slim rows per approval, latest link first, as the per-approval read orders them", async () => {
    const svc = issueApprovalService(db);
    const first = await createApproval();
    const second = await createApproval();
    const unlinked = await createApproval();
    const suffix = randomUUID().slice(0, 8);
    const older = await createIssue("Pick a hosting provider", `OPS-${suffix}-1`);
    const newer = await createIssue("Renew the domain", null);
    await link(first, older, new Date("2026-10-01T00:00:00.000Z"));
    await link(first, newer, new Date("2026-10-02T00:00:00.000Z"));
    await link(second, older, new Date("2026-10-03T00:00:00.000Z"));

    const result = await svc.listLinkedIssuesForApprovals(companyId, [first, second, unlinked, randomUUID()]);

    expect(result).toEqual({
      [first]: [
        { id: newer, identifier: null, title: "Renew the domain", status: "in_review" },
        { id: older, identifier: `OPS-${suffix}-1`, title: "Pick a hosting provider", status: "in_review" },
      ],
      [second]: [
        { id: older, identifier: `OPS-${suffix}-1`, title: "Pick a hosting provider", status: "in_review" },
      ],
    });
    // The same tasks, in the same order, as the per-approval read.
    const whole = await svc.listIssuesForApproval(first);
    expect(result[first]!.map((issue) => issue.id)).toEqual(whole.map((issue) => issue.id));
  });

  it("returns nothing for an approval of another company", async () => {
    const svc = issueApprovalService(db);
    const mine = await createApproval();
    const myIssue = await createIssue("Mine", null);
    await link(mine, myIssue, new Date("2026-10-01T00:00:00.000Z"));
    const theirs = await createApproval(otherCompanyId);
    const theirIssue = await createIssue("Their secret task", null, otherCompanyId);
    await link(theirs, theirIssue, new Date("2026-10-01T00:00:00.000Z"), otherCompanyId);

    expect(await svc.listLinkedIssuesForApprovals(companyId, [mine, theirs])).toEqual({
      [mine]: [{ id: myIssue, identifier: null, title: "Mine", status: "in_review" }],
    });
    expect(await svc.listLinkedIssuesForApprovals(otherCompanyId, [mine])).toEqual({});
  });

  it("leaves out a task of another company, should a link ever cross the boundary", async () => {
    const svc = issueApprovalService(db);
    const mine = await createApproval();
    const theirIssue = await createIssue("Their secret task", null, otherCompanyId);
    await link(mine, theirIssue, new Date("2026-10-01T00:00:00.000Z"));

    expect(await svc.listLinkedIssuesForApprovals(companyId, [mine])).toEqual({});
  });

  it("reads nothing for an empty list", async () => {
    expect(await issueApprovalService(db).listLinkedIssuesForApprovals(companyId, [])).toEqual({});
  });
});
