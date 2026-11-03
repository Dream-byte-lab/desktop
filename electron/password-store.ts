import { isLibsecretInstalled } from "./libsecret.js";
import { isSecretServiceAvailable } from "./secret-service.js";

// Pins Chromium's password store on Linux so logins survive switching
// desktops (upstream PR #302; issue #349 is one field report of the
// logout this prevents).
//
// The failure: Electron's safeStorage encrypts the auth session files
// with a key from whichever keyring backend Chromium selects based on
// XDG_CURRENT_DESKTOP — kwallet5/6 on KDE, gnome-libsecret on
// GNOME/XFCE/Cinnamon, basic_text elsewhere. Each backend holds a
// different key, so a session written under one desktop cannot be
// decrypted under another: AuthSessionStore.read() logs "stored
// session is unreadable" and returns null, and the user is signed
// out. Worse, the next login re-encrypts with the new desktop's key,
// breaking the first desktop in turn.
//
// The pin: when libsecret is installed AND a Secret Service provider
// is reachable, force --password-store=gnome-libsecret so every
// desktop encrypts through the same Secret Service store. The pin is
// deliberately conservative — it never downgrades anyone:
// - non-Linux: Chromium's own store selection is fine there.
// - no libsecret or no Secret Service: pinning would point Chromium
//   at a keyring that cannot answer, so the default stays.
// - the user passed their own --password-store: their choice wins.
//
// Honest limits (from the PR, unchanged here):
// - Sessions must use the SAME Secret Service provider across
//   desktops. KWallet on KDE and gnome-keyring on GNOME are two
//   different stores with two different keys; hopping between those
//   still signs the user out.
// - KDE users who were on the KWallet backend are signed out ONCE
//   after this lands (their stored session was encrypted with the
//   KWallet key); from then on the pinned store is stable.
// - No Secret Service at all: behaviour is unchanged — and in this
//   build that is not a login blocker, because AuthSessionStore
//   persists a plaintext envelope when safeStorage reports no
//   encryption available.

export type LinuxPasswordStore = "gnome-libsecret";

export interface LinuxPasswordStoreInput {
  platform: string;
  libsecretInstalled: boolean;
  secretServiceAvailable: boolean;
  argv: readonly string[];
}

function hasUserPasswordStore(argv: readonly string[]): boolean {
  return argv.some(
    (arg) => arg === "--password-store" || arg.startsWith("--password-store="),
  );
}

/** Pure decision: the store to pin, or null to keep Chromium's default. */
export function decideLinuxPasswordStore(
  input: LinuxPasswordStoreInput,
): LinuxPasswordStore | null {
  if (input.platform !== "linux") return null;
  if (!input.libsecretInstalled) return null;
  if (!input.secretServiceAvailable) return null;
  if (hasUserPasswordStore(input.argv)) return null;
  return "gnome-libsecret";
}

export interface LinuxPasswordStoreDeps {
  platform?: string;
  argv?: readonly string[];
  libsecretInstalled?: () => boolean;
  secretServiceAvailable?: () => boolean;
}

/**
 * Performs the real checks synchronously (the dbus probe must finish
 * before app.ready so the switch can be appended in time). Linux
 * only; every failure resolves to null and this never throws.
 */
export function resolveLinuxPasswordStoreSync(
  deps: LinuxPasswordStoreDeps = {},
): LinuxPasswordStore | null {
  try {
    const platform = deps.platform ?? process.platform;
    if (platform !== "linux") return null;
    const libsecretInstalled = (
      deps.libsecretInstalled ?? isLibsecretInstalled
    )();
    if (!libsecretInstalled) return null;
    const secretServiceAvailable = (
      deps.secretServiceAvailable ?? isSecretServiceAvailable
    )();
    return decideLinuxPasswordStore({
      platform,
      libsecretInstalled,
      secretServiceAvailable,
      argv: deps.argv ?? process.argv,
    });
  } catch {
    return null;
  }
}
