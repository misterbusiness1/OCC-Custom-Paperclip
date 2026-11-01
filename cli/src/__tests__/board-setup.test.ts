import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoredBoardCredential } from "../client/board-auth.js";
import { formatBoardSetupExports, formatBoardSetupNotice, runBoardSetup } from "../commands/client/board-setup.js";
import { registerPromptCommands } from "../commands/client/prompt.js";

const ORIGINAL_ENV = { ...process.env };
const COMPANY_A = { id: "22222222-2222-4222-8222-222222222222", name: "Acme", status: "active" };
const COMPANY_B = { id: "33333333-3333-4333-8333-333333333333", name: "Beta 'Labs'", status: "active" };
const ARCHIVED = { id: "44444444-4444-4444-8444-444444444444", name: "Old Co", status: "archived" };
// Any C0/C1 control character, or a Unicode line/paragraph separator.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** Runs `paperclipai board setup <args>` in-process and captures stdout/stderr separately. */
async function runBoardSetupCommand(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);

  const program = new Command();
  program.exitOverride();
  registerPromptCommands(program);
  let exitCode = 0;
  try {
    await program.parseAsync(["node", "paperclipai", "board", "setup", ...args]);
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
    exitCode = err.code ?? 0;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
}

describe("board setup", () => {
  let tmpDir: string;
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalStdinIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_COMPANY_ID;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_AUTH_STORE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-board-setup-"));
    // Isolate context profiles and stored board logins from the real home.
    process.env.PAPERCLIP_HOME = path.join(tmpDir, "home");
    // Context discovery searches ancestor .paperclip directories before HOME.
    // Pin the context too so a developer's profile cannot select a real company.
    process.env.PAPERCLIP_CONTEXT = path.join(tmpDir, "context.json");
    // Same as `eval "$(...)"`: stdout is captured, so no interactive login.
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it("lists candidates on stderr, not in the eval'd stdout, when several are visible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([COMPANY_A, COMPANY_B])));

    const { stdout, stderr, exitCode } = await runBoardSetupCommand([
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "board-key",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("export PAPERCLIP_API_URL='http://localhost:3100'");
    expect(stderr).toContain("--company-id <id>");
    expect(stderr).toContain(`  ${COMPANY_A.id}  Acme`);
    expect(stderr).toContain(`  ${COMPANY_B.id}  Beta 'Labs'`);
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

  describe("server-controlled output", () => {
    it("does not let a company id from the server run shell code under eval", async () => {
      const marker = path.join(tmpDir, "pwned");
      const evil = { id: `x\ntouch ${marker}\n#`, name: "Evil", status: "active" };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([COMPANY_A, evil])));

      const { stdout, stderr, exitCode } = await runBoardSetupCommand([
        "--api-base",
        "http://localhost:3100",
        "--api-key",
        "board-key",
      ]);
      execFileSync("sh", ["-c", stdout], { cwd: tmpDir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });

      expect(fs.existsSync(marker)).toBe(false);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("not a UUID");
    });

    it("refuses a selected company whose id is not a UUID", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(json({ id: "x'; touch pwned; '", name: "Evil", status: "active" })),
      );
      await expect(
        runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "board-key", companyId: COMPANY_A.id }),
      ).rejects.toThrow(/not a UUID/);

      // A trailing newline must not slip past the check.
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([{ ...COMPANY_A, id: `${COMPANY_A.id}\n` }])));
      await expect(runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "board-key" })).rejects.toThrow(
        /not a UUID/,
      );

      // The refusal itself (shown on stderr) carries no control characters either.
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([{ ...COMPANY_A, id: "x\u009b2J\u2028\u001b[2Jy" }])));
      const error = await runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "board-key" }).catch((err) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("not a UUID");
      expect((error as Error).message).not.toMatch(CONTROL_CHARS);
    });

    it("strips control characters from company names in the candidate list", () => {
      const notice = formatBoardSetupNotice({
        apiBase: "http://localhost:3100",
        companyId: null,
        companyName: null,
        companies: [
          { id: COMPANY_A.id, name: "Evil\u001b]0;pwned\u0007\r\ntouch pwned\t\u0085\u2028#" },
          { id: COMPANY_B.id, name: COMPANY_B.name },
        ],
      });

      const lines = notice?.split("\n") ?? [];
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(line).not.toMatch(CONTROL_CHARS);
      expect(lines[1]).toBe(`  ${COMPANY_A.id}  Evil ]0;pwned touch pwned #`);
    });
  });

  describe("archived companies", () => {
    it("are not candidates for the automatic choice", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([ARCHIVED, COMPANY_B])));

      const result = await runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "board-key" });

      expect(result).toMatchObject({ companyId: COMPANY_B.id, companies: [] });
    });

    it("are not auto-selected when they are the only company", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([ARCHIVED])));

      const result = await runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "board-key" });

      expect(result).toMatchObject({ companyId: null, companies: [] });
      expect(formatBoardSetupExports(result)).toContain("export PAPERCLIP_COMPANY_ID=''");
    });
  });

  describe("authentication", () => {
    it("explains how to authenticate when the server requires it and no key is configured", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Unauthorized" }, 401)));

      const { stdout, stderr, exitCode } = await runBoardSetupCommand(["--api-base", "http://localhost:3100"]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("requires board authentication");
      expect(stderr).toContain("export PAPERCLIP_API_KEY=<board API key>");
      expect(stderr).toContain("paperclipai auth login");
    });

    it("warns on stderr that a stored board login is not exported", async () => {
      setStoredBoardCredential({ apiBase: "http://localhost:3100", token: "stored-board-token" });
      const fetchMock = vi.fn().mockResolvedValue(json([COMPANY_A]));
      vi.stubGlobal("fetch", fetchMock);

      const { stdout, stderr, exitCode } = await runBoardSetupCommand(["--api-base", "http://localhost:3100"]);

      expect(exitCode).toBe(0);
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer stored-board-token" });
      expect(stdout).toBe(
        [
          "export PAPERCLIP_API_URL='http://localhost:3100'",
          `export PAPERCLIP_COMPANY_ID='${COMPANY_A.id}'`,
        ].join("\n"),
      );
      expect(stderr).toContain("export PAPERCLIP_API_KEY=<board API key>");
      expect(`${stdout}\n${stderr}`).not.toContain("stored-board-token");
    });

    it("does not warn when PAPERCLIP_API_KEY is configured", async () => {
      process.env.PAPERCLIP_API_KEY = "env-board-key";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([COMPANY_A])));

      const { stderr, exitCode } = await runBoardSetupCommand(["--api-base", "http://localhost:3100"]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    });
  });

  describe("unknown explicit company", () => {
    it("points at a stale PAPERCLIP_COMPANY_ID", async () => {
      process.env.PAPERCLIP_COMPANY_ID = COMPANY_A.id;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Company not found" }, 404)));

      await expect(runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "board-key" })).rejects.toThrow(
        /was not found on http:\/\/localhost:3100\. PAPERCLIP_COMPANY_ID may be stale: run `unset PAPERCLIP_COMPANY_ID`/,
      );
    });

    it("points at --company-id when the flag was used", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Company not found" }, 404)));

      await expect(
        runBoardSetup({ apiBase: "http://localhost:3100", apiKey: "board-key", companyId: COMPANY_B.id }),
      ).rejects.toThrow(/Check the id passed to --company-id/);
    });
  });
});
