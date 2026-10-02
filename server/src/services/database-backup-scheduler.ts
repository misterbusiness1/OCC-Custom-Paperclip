import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type TimerHandle = ReturnType<typeof setTimeout>;

export type DatabaseBackupSchedulerOptions = {
  backupDir: string;
  intervalMs: number;
  runBackup: () => Promise<unknown>;
  filenamePrefix?: string;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onError?: (error: unknown) => void;
};

/**
 * Return the newest artifact completed by runDatabaseBackup's atomic rename.
 * The backup writer uses `<prefix>-*.sql.gz.partial` while a dump is in
 * progress, so accepting only the final name also prevents a restart from
 * treating an interrupted write as a successful backup.
 */
export function findLatestCompletedDatabaseBackupMtimeMs(
  backupDir: string,
  filenamePrefix = "paperclip",
): number | null {
  try {
    let latest: number | null = null;
    const completedPrefix = `${filenamePrefix}-`;

    for (const name of readdirSync(backupDir)) {
      if (!name.startsWith(completedPrefix) || !name.endsWith(".sql.gz")) continue;
      const stat = statSync(join(backupDir, name));
      if (!stat.isFile()) continue;
      if (latest === null || stat.mtimeMs > latest) latest = stat.mtimeMs;
    }

    return latest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function createDatabaseBackupScheduler(options: DatabaseBackupSchedulerOptions) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const intervalMs = Math.max(1, options.intervalMs);
  const filenamePrefix = options.filenamePrefix ?? "paperclip";
  let timer: TimerHandle | null = null;
  let started = false;
  let stopped = false;
  let tickInFlight: Promise<void> | null = null;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, Math.max(0, delayMs));
  };

  const tick = (): Promise<void> => {
    if (tickInFlight) return tickInFlight;

    const inFlight = (async () => {
      try {
        const latestMtimeMs = findLatestCompletedDatabaseBackupMtimeMs(
          options.backupDir,
          filenamePrefix,
        );
        const ageMs = latestMtimeMs === null ? intervalMs : Math.max(0, now() - latestMtimeMs);

        if (latestMtimeMs === null || ageMs >= intervalMs) {
          await options.runBackup();
          schedule(intervalMs);
        } else {
          schedule(intervalMs - ageMs);
        }
      } catch (error) {
        options.onError?.(error);
        schedule(intervalMs);
      }
    })();
    tickInFlight = inFlight;
    const clearInFlight = () => {
      if (tickInFlight === inFlight) tickInFlight = null;
    };
    void inFlight.then(clearInFlight, clearInFlight);

    return inFlight;
  };

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    tick,
  };
}
