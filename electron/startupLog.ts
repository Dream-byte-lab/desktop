// LINERAVE FLIGHT RECORDER (kept by decision — see the startup block in
// main.ts): a synchronous startup log so a launch that fails silently
// still leaves evidence behind. The log lands on the Desktop when
// possible, else in the app's data folder. Every write is a direct
// append: if the process dies a line later, everything up to that line
// is already on disk. (Originally added as a temporary diagnostic during
// the launch-failure investigation; retained deliberately as the flight
// recorder. SA-1 M-4 once recommended removal — that recommendation and
// this retention are both on record; the standing behaviour is: it
// stays.)
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

let logFile: string | null = null;

export function initStartupLog(): void {
  // Try each candidate home in order and keep the first one that
  // actually accepts a write — a path that merely resolves is not
  // enough (it may not exist, and a silent logger is no logger).
  const candidates: string[] = [];
  for (const name of ["desktop", "userData", "temp"] as const) {
    try {
      const dir = app.getPath(name);
      if (dir) candidates.push(dir);
    } catch {
      // Keep going: the next candidate may work.
    }
  }
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "linerave-startup.log");
      fs.appendFileSync(
        file,
        `\n===== Linerave launch ${new Date().toISOString()} =====\n`,
      );
      logFile = file;
      break;
    } catch {
      // Try the next candidate home.
    }
  }
  const versions = process.versions as Record<string, string | undefined>;
  slog(
    `main process started: pid=${process.pid} platform=${process.platform} ` +
      `arch=${process.arch} packaged=${app.isPackaged} ` +
      `electron=${versions.electron ?? "?"} chrome=${versions.chrome ?? "?"} ` +
      `node=${versions.node ?? "?"}`,
  );
}

export function slog(message: string): void {
  try {
    if (logFile) {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
    }
  } catch {
    // Logging must never break the app it is observing.
  }
}
