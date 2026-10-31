import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatBoardSetupExports, runBoardSetup } from "../commands/client/board-setup.js";

const ORIGINAL_ENV = { ...process.env };
const COMPANY_A = { id: "22222222-2222-4222-8222-222222222222", name: "Acme" };
const COMPANY_B = { id: "33333333-3333-4333-8333-333333333333", name: "Beta 'Labs'" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("board setup", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_COMPANY_ID;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the explicit company after confirming it exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(COMPANY_A));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBoardSetup({
      apiBase: "http://localhost:3100/",
      apiKey: "board-key",
      companyId: COMPANY_A.id,
    });

    expect(result).toEqual({ apiBase: "http://localhost:3100", companyId: COMPANY_A.id, companyName: "Acme", companies: [] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`http://localhost:3100/api/companies/${COMPANY_A.id}`);
  });

  it("selects the only visible company when none is configured", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([COMPANY_A])));

    const result = await runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "board-key" });

    expect(result.companyId).toBe(COMPANY_A.id);
    expect(formatBoardSetupExports(result)).toBe(
      [
        "export PAPERCLIP_API_URL='http://localhost:3100'",
        `export PAPERCLIP_COMPANY_ID='${COMPANY_A.id}'`,
      ].join("\n"),
    );
  });

  it("lists companies as comments instead of guessing when several are visible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([COMPANY_A, COMPANY_B])));

    const result = await runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "board-key" });
    const output = formatBoardSetupExports(result);

    expect(result.companyId).toBeNull();
    expect(output).not.toContain("PAPERCLIP_COMPANY_ID=");
    expect(output).toContain(`#   ${COMPANY_B.id}  Beta 'Labs'`);
  });

  it("exports an empty company id when no companies exist yet", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([])));

    const output = formatBoardSetupExports(
      await runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "board-key" }),
    );

    expect(output).toContain("export PAPERCLIP_COMPANY_ID=''");
  });

  it("never prints the board API key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([COMPANY_A])));

    const output = formatBoardSetupExports(
      await runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "secret-board-key" }),
    );

    expect(output).not.toContain("secret-board-key");
  });

  it("produces exports that a POSIX shell evaluates to the exact values", () => {
    const output = formatBoardSetupExports({
      apiBase: "http://host/it's",
      companyId: COMPANY_A.id,
      companyName: "Acme",
      companies: [],
    });

    const evaluated = execFileSync("sh", ["-c", `${output}\nprintf '%s|%s' "$PAPERCLIP_API_URL" "$PAPERCLIP_COMPANY_ID"`], {
      encoding: "utf8",
      env: {},
    });
    expect(evaluated).toBe(`http://host/it's|${COMPANY_A.id}`);
  });
});
