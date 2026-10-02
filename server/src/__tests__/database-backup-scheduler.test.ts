import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseBackupScheduler } from "../services/database-backup-scheduler.js";

const HOUR_MS = 60 * 60 * 1000;

describe("database backup scheduler", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function backupDir() {
    const root = mkdtempSync(join(tmpdir(), "paperclip-backup-scheduler-"));
    tempDirs.push(root);
    const dir = join(root, "backups");
    mkdirSync(dir);
    return dir;
  }

  function completedBackup(dir: string, mtimeMs: number, name = "paperclip-20261002-120000.sql.gz") {
    const path = join(dir, name);
    writeFileSync(path, "completed");
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  }

  it("runs exactly one immediate catch-up when no completed backup exists across duplicate starts", async () => {
    vi.useFakeTimers();
    const runBackup = vi.fn().mockResolvedValue(undefined);
    const scheduler = createDatabaseBackupScheduler({
      backupDir: backupDir(),
      intervalMs: 24 * HOUR_MS,
      runBackup,
    });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runBackup).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("runs one immediate catch-up when the newest completed backup is stale", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-02T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const dir = backupDir();
    completedBackup(dir, now - 25 * HOUR_MS);
    const runBackup = vi.fn().mockResolvedValue(undefined);

    createDatabaseBackupScheduler({ backupDir: dir, intervalMs: 24 * HOUR_MS, runBackup }).start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it("schedules a fresh backup for only the remaining interval", async () => {
    const now = new Date("2026-10-02T12:00:00Z").getTime();
    let currentNow = now;
    const dir = backupDir();
    completedBackup(dir, now - 2 * HOUR_MS);
    const runBackup = vi.fn().mockResolvedValue(undefined);
    let scheduledCallback: (() => void) | null = null;
    const setTimer = vi.fn((callback: () => void) => {
      scheduledCallback = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });

    createDatabaseBackupScheduler({
      backupDir: dir,
      intervalMs: 24 * HOUR_MS,
      runBackup,
      now: () => currentNow,
      setTimer,
    }).start();
    await Promise.resolve();

    expect(runBackup).not.toHaveBeenCalled();
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 22 * HOUR_MS);

    currentNow += 22 * HOUR_MS;
    scheduledCallback?.();
    await Promise.resolve();
    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it("ignores partial and non-contract artifacts when deciding whether catch-up is due", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-02T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const dir = backupDir();
    completedBackup(dir, now, "paperclip-20261002-120000.sql.gz.partial");
    completedBackup(dir, now, "paperclip-legacy.sql.gz");
    completedBackup(dir, now, "another-service-20261002-120000.sql.gz");
    writeFileSync(join(dir, "paperclip-20261002-120000.sql.partial"), "in-flight");
    const runBackup = vi.fn().mockResolvedValue(undefined);

    createDatabaseBackupScheduler({ backupDir: dir, intervalMs: 24 * HOUR_MS, runBackup }).start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it("escapes a configurable prefix when matching current-format completed artifacts", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-02T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const dir = backupDir();
    completedBackup(dir, now, "paper.clip+prod-20261002-120000.sql.gz");
    const runBackup = vi.fn().mockResolvedValue(undefined);

    createDatabaseBackupScheduler({
      backupDir: dir,
      intervalMs: 24 * HOUR_MS,
      filenamePrefix: "paper.clip+prod",
      runBackup,
    }).start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runBackup).not.toHaveBeenCalled();
  });

  it("serializes overlapping ticks and schedules once after the backup settles", async () => {
    vi.useFakeTimers();
    let resolveBackup!: () => void;
    const backupPending = new Promise<void>((resolve) => {
      resolveBackup = resolve;
    });
    const runBackup = vi.fn(() => backupPending);
    const scheduler = createDatabaseBackupScheduler({
      backupDir: backupDir(),
      intervalMs: HOUR_MS,
      runBackup,
    });

    scheduler.start();
    const overlappingTick = scheduler.tick();
    expect(runBackup).toHaveBeenCalledTimes(1);

    resolveBackup();
    await overlappingTick;
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    expect(runBackup).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runBackup).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
