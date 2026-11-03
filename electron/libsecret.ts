import fs from "node:fs";
import path from "node:path";

// Locates libsecret, the client library Chromium's "gnome-libsecret"
// password store talks to the desktop Secret Service through.
//
// Why this exists: Electron's safeStorage encrypts the auth session
// files (auth/session.json, auth/youtube-session.json) with a key held
// by whichever keyring backend Chromium picks from the current desktop
// (kwallet5/6 on KDE, gnome-libsecret on GNOME/XFCE/Cinnamon,
// basic_text elsewhere). Each backend is a different key, so a session
// written under one desktop fails to decrypt under another and the
// user is signed out (see password-store.ts, which pins the backend
// when this library is present). There is no API to ask Chromium
// whether libsecret is loadable, so presence is judged by finding the
// shared object on disk, the same places the dynamic loader looks.

export const LIBSECRET_SONAME = "libsecret-1.so.0";

// Standard library directories, in search order: the multiarch dirs
// first (Debian/Ubuntu/Fedora layouts), then the generic fallbacks.
export const LIBSECRET_SYSTEM_DIRS: readonly string[] = [
  "/usr/lib/x86_64-linux-gnu",
  "/usr/lib/aarch64-linux-gnu",
  "/usr/lib64",
  "/usr/lib",
  "/lib/x86_64-linux-gnu",
  "/lib/aarch64-linux-gnu",
  "/lib",
];

export interface LibsecretSearchDeps {
  /** Existence check for a candidate path. Defaults to fs.existsSync. */
  exists?: (candidate: string) => boolean;
  /** Environment to read LD_LIBRARY_PATH from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Full path of libsecret-1.so.0, or null when it is not installed.
 * LD_LIBRARY_PATH entries are searched first, in order (the loader
 * honours them ahead of the system dirs, so a user-installed
 * libsecret wins), then the standard system directories.
 */
export function findLibsecret(deps: LibsecretSearchDeps = {}): string | null {
  const exists =
    deps.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const env = deps.env ?? process.env;

  const dirs: string[] = [];
  for (const entry of (env.LD_LIBRARY_PATH ?? "").split(":")) {
    // Empty entries mean "current directory" to the loader; a keyring
    // library is never legitimately picked up from there.
    if (entry) dirs.push(entry);
  }
  dirs.push(...LIBSECRET_SYSTEM_DIRS);

  for (const dir of dirs) {
    const candidate = path.join(dir, LIBSECRET_SONAME);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function isLibsecretInstalled(deps: LibsecretSearchDeps = {}): boolean {
  return findLibsecret(deps) !== null;
}
