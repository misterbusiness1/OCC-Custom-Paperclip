import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

async function checked(response: Awaited<ReturnType<import("@playwright/test").APIRequestContext["get"]>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
  test(`email source and task navigation at ${viewport.width}x${viewport.height}`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const company = await checked(await request.post("/api/companies", { data: { name: `Mobile synthetic ${Date.now()}` } }));
    const prefix = `/${company.issuePrefix}`;
    const incoming = [
      "Please explain my synthetic order.",
      ...Array.from({ length: 10 }, (_, index) => `Synthetic detail line ${index + 1}.`),
      "<script>window.emailExecuted=true</script>",
    ].join("\n");
    const draft = "Here is the proposed outgoing response for review.";
    const approval = await checked(await request.post(`/api/companies/${company.id}/approvals`, { data: {
      type: "request_board_approval", payload: {
        title: "Synthetic email review", recipient: "synthetic@example.test", subject: "Synthetic order question", body: draft,
        recommendedAction: "Review the proposed response", reasoning: "The board can compare both messages", pros: ["Source is visible"], risks: ["This is a test fixture"],
        originalRequest: { text: incoming, source: { kind: "external", channel: "email", sender: "synthetic@example.test", reference: "synthetic-message-only" } },
      },
    } }));
    // Request page: the original email is shown whole, framed apart from the draft and above it (owner request 2026-10-28).
    await page.goto(`${prefix}/approvals/${approval.id}`);
    const source = page.locator('[data-approval-original-request="email"]').first();
    await expect(source).toBeVisible();
    await expect(source).toContainText("Original email");
    await expect(source.locator("pre")).toHaveText(incoming);
    await expect(source.locator("button")).toHaveCount(0);
    const draftText = page.getByText(draft, { exact: true }).first();
    await expect(draftText).toBeVisible();
    expect((await source.boundingBox())!.y).toBeLessThan((await draftText.boundingBox())!.y);
    expect(await page.evaluate(() => (window as unknown as { emailExecuted?: boolean }).emailExecuted)).toBeUndefined();
    await expect(page.getByRole("button", { name: /^Approve/ }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("email-source.png"), fullPage: true });

    // Queue card: a six-line preview with a Show more toggle that is a 44px touch target on phones.
    await page.goto(`${prefix}/approvals`);
    const preview = page.locator('[data-approval-original-request="email"]').first();
    await expect(preview).toBeVisible();
    const more = preview.getByRole("button", { name: /^Show more: Original email/ });
    await expect(more).toBeVisible();
    if (viewport.width < 640) expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(preview.locator("pre")).toHaveClass(/line-clamp-6/);
    await more.click();
    await expect(preview.locator("pre")).not.toHaveClass(/line-clamp/);
    await expect(preview.locator("pre")).toHaveText(incoming);
    await expect(preview.getByRole("button", { name: /^Show less: Original email/ })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { emailExecuted?: boolean }).emailExecuted)).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("email-source-queue.png"), fullPage: true });

    for (const [title, status] of [["Synthetic blocked work", "blocked"], ["Synthetic review work", "in_review"], ["Synthetic ordinary work", "backlog"]]) {
      await checked(await request.post(`/api/companies/${company.id}/issues`, { data: { title, status } }));
    }
    await page.goto(`${prefix}/issues`);
    await page.getByRole("button", { name: "Blocked", exact: true }).click();
    await expect(page.getByText("Synthetic blocked work", { exact: true })).toBeVisible();
    await expect(page.getByText("Synthetic ordinary work", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "In review", exact: true }).click();
    await expect(page.getByText("Synthetic review work", { exact: true })).toBeVisible();
    await expect(page.getByText("Synthetic blocked work", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "In review", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("task-views.png"), fullPage: true });
    expect((await checked(await request.get(`/api/approvals/${approval.id}`))).status).toBe("pending");
    const agent = await checked(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Synthetic mobile health agent", adapterType: "process",
      adapterConfig: { command: "node", args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    } }));
    await checked(await request.patch(`/api/agents/${agent.id}`, { data: { status: "error" } }));
    await page.goto(`${prefix}/agents/all`);
    const row = page.locator("a").filter({ has: page.getByText(agent.name, { exact: true }) }).first();
    await expect(row).toBeVisible();
    if (viewport.width < 640) {
      await expect(row.getByText("error", { exact: true }).filter({ visible: true })).toBeVisible();
      await expect(row.getByLabel("Last heartbeat")).toContainText("Never");
      await expect(row.getByLabel("Last heartbeat")).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("agent-health.png"), fullPage: true });
    const manifest = await checked(await request.get("/site.webmanifest"));
    expect(manifest.display).toBe("standalone");
  });
}

test.describe("exact-run retry fixture", () => {
  // Service-worker-owned requests bypass page.route. This test supplies a
  // synthetic failed run through routing; the real-API tests above keep SW enabled.
  test.use({ serviceWorkers: "block" });
  test("rapid retry taps send one exact-run request and retain an actionable error", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const company = await checked(await request.post("/api/companies", { data: { name: `Retry synthetic ${Date.now()}` } }));
    const agent = await checked(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Synthetic retry fixture", adapterType: "process", adapterConfig: { command: "node", args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    } }));
    const run = {
      id: "70000000-0000-4000-8000-000000000001", companyId: company.id, agentId: agent.id,
      status: "failed", invocationSource: "manual", triggerDetail: "manual", contextSnapshot: {},
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      error: "Synthetic failure", errorCode: "synthetic_failure", resultJson: null, usageJson: null, logRef: null,
    };
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === `/api/heartbeat-runs/${run.id}`) return route.fulfill({ json: run });
      if (url.pathname === `/api/heartbeat-runs/${run.id}/events`) return route.fulfill({ json: [] });
      if (url.pathname === `/api/companies/${company.id}/heartbeat-runs`) return route.fulfill({ json: [run] });
      return route.continue();
    });
    let calls = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/agents/${agent.id}/wakeup*`, async route => {
      calls += 1;
      expect(route.request().postDataJSON()).toMatchObject({ reason: "retry_failed_run", failedRunId: run.id });
      await barrier;
      await route.fulfill({ status: 409, json: { error: "Synthetic retry blocked: refresh the current run." } });
    });
    await page.goto(`/${company.issuePrefix}/agents/${agent.id}/runs/${run.id}`);
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    await retry.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect.poll(() => calls).toBe(1);
    await expect(page.getByRole("button", { name: "Retrying…", exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole("alert")).toContainText("Synthetic retry blocked");
    await expect(retry).toBeEnabled();
    expect(calls).toBe(1);
  });
});
