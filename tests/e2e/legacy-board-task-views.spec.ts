import { expect, test } from "@playwright/test";

// This suite uses the dedicated disposable Paperclip server from playwright.config.
// It must never point at a shared staging or production instance.
for (const streamlined of [false, true]) {
  test(`task-view board scope, direct URL and reload (streamlined=${streamlined})`, async ({ page, request }) => {
    const flags = await request.patch("/api/instance/settings/experimental", { data: { enableStreamlinedUi: streamlined } });
    expect(flags.ok(), await flags.text()).toBe(true);
    const result = await request.post("/api/companies", { data: { name: `Board scope ${Date.now()}` } });
    expect(result.ok(), await result.text()).toBe(true);
    const company = await result.json();
    for (const status of ["blocked", "in_review", "todo", "done"]) {
      const created = await request.post(`/api/companies/${company.id}/issues`, { data: { title: `Needle ${status}`, status } });
      expect(created.ok(), await created.text()).toBe(true);
    }
    const calls: URL[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      // Sidebar inbox requests share the endpoint but are a separate collection.
      if (url.pathname === `/api/companies/${company.id}/issues`
        && !url.searchParams.has("touchedByUserId") && !url.searchParams.has("inboxArchivedByUserId")) calls.push(url);
    });
    for (const [view, status] of [["blocked", "blocked"], ["review", "in_review"]]) {
      await page.goto(`/${company.issuePrefix}/issues?view=${view}&search=needle`);
      await page.getByRole("button", { name: "Board view", exact: true }).click();
      await expect(page.getByText(`Needle ${status}`, { exact: true })).toBeVisible();
      for (const forbidden of ["todo", "done", status === "blocked" ? "in_review" : "blocked"]) {
        await expect(page.getByText(`Needle ${forbidden}`, { exact: true })).toHaveCount(0);
      }
      await page.reload();
      await expect(page.getByText(`Needle ${status}`, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Board view", exact: true })).toHaveAttribute("aria-pressed", "true");
      const search = page.getByRole("textbox", { name: "Search tasks" });
      await search.fill("nothing matches");
      await expect(page.getByText(`Needle ${status}`, { exact: true })).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`${view}-${streamlined}-no-match.png`), fullPage: true });
      await search.fill("");
      await expect(page.getByText(`Needle ${status}`, { exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`${view}-${streamlined}.png`), fullPage: true });
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => ["blocked", "in_review"].includes(url.searchParams.get("status")!))).toBe(true);
  });
}
