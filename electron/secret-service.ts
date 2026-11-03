import { execFileSync } from "node:child_process";

// Whether a Secret Service provider (gnome-keyring, KWallet's secret
// service bridge, KeePassXC, …) is reachable on the session bus.
//
// Chromium's "gnome-libsecret" password store is only useful when
// something actually implements org.freedesktop.secrets; pinning to
// it with no provider running would leave safeStorage without a
// working keyring. So password-store.ts pins only when this check
// passes. "Activatable" counts: a provider that is installed but not
// yet running is started by the bus on first use, which is exactly
// what Chromium's first encrypt/decrypt would do.
//
// The check is SYNCHRONOUS on purpose: the consumer must decide the
// --password-store switch before app.ready, and Chromium reads the
// switch at startup. The bus round-trips are capped at 1s so a wedged
// bus can never hang the launch; any error, timeout, or missing
// dbus-send binary simply means "not available".

export const SECRET_SERVICE_NAME = "org.freedesktop.secrets";
export const SECRET_SERVICE_TIMEOUT_MS = 1_000;

/** Runs dbus-send with the given arguments and returns its stdout. */
export type DbusRunner = (args: readonly string[]) => string;

const defaultRunner: DbusRunner = (args) =>
  execFileSync("dbus-send", [...args], {
    timeout: SECRET_SERVICE_TIMEOUT_MS,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

function dbusCallArgs(method: string): string[] {
  return [
    "--session",
    "--print-reply",
    "--dest=org.freedesktop.DBus",
    "/org/freedesktop/DBus",
    `org.freedesktop.DBus.${method}`,
  ];
}

function listsName(run: DbusRunner, method: string): boolean {
  try {
    return run(dbusCallArgs(method)).includes(SECRET_SERVICE_NAME);
  } catch {
    return false;
  }
}

/**
 * True when org.freedesktop.secrets is running on the session bus or
 * can be activated on demand. Never throws.
 */
export function isSecretServiceAvailable(
  run: DbusRunner = defaultRunner,
): boolean {
  if (listsName(run, "ListNames")) return true;
  return listsName(run, "ListActivatableNames");
}
