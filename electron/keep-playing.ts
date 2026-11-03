import type { PowerSaveBlocker } from "electron";

type Blocker = Pick<PowerSaveBlocker, "start" | "stop">;

export interface KeepPlayingState {
  /** Player transport status, as synced from the renderer. */
  status: string;
  /**
   * True while a DJ session is running. A session counts as playing for
   * this purpose even when the plain player reports "paused": during a
   * set the decks own the audio, and a hosted party runs on the session.
   * The session being alive IS the playback.
   */
  djSessionActive: boolean;
  /** The user's "Keep playing when the screen turns off" setting. */
  keepPlayingEnabled: boolean;
}

// The same "audio is sounding or about to sound" status set the display
// blocker in sleep-blocker.ts uses, so both blockers agree on what
// "playing" means.
const PLAYING_STATUSES = new Set(["playing", "buffering", "loading"]);

// Keep-playing: while music is actually playing (or a DJ session is
// running), hold Electron's "prevent-app-suspension" powerSaveBlocker so
// the system does not suspend the app when the display turns off or the
// machine goes idle mid-song. The display itself is free to sleep —
// this is NOT the display blocker in sleep-blocker.ts (that one keeps
// the screen, and HDMI audio, awake; the two coexist, each guaranteeing
// a different half of "the music keeps playing").
//
// What this cannot do — limits of the OS, not of this code:
// - It cannot override a sleep the user starts themselves (Start menu,
//   power button) or a lid-close Windows is configured to sleep on.
//   That policy belongs to Windows' own power settings.
// - On Modern Standby machines (e.g. Surface), the OS may still
//   throttle background work in its deepest standby phases. The blocker
//   is the strongest request an app can make; the on-hardware verdict
//   belongs to a real-device test.
//
// Battery honesty: the blocker exists only while the merged state says
// something is playing. It is never held for an idle or paused app,
// never held just because the app is open, and never held at all when
// the user turns the setting off.
export function createKeepPlayingController(blocker: Blocker) {
  let id: number | null = null;
  const state: KeepPlayingState = {
    status: "idle",
    djSessionActive: false,
    // Matches the settings default (on). The renderer's first state
    // sync carries the persisted value, so a user who turned the
    // setting off corrects this before anything can be playing.
    keepPlayingEnabled: true,
  };

  const shouldHold = () =>
    state.keepPlayingEnabled &&
    (PLAYING_STATUSES.has(state.status) || state.djSessionActive);

  const reconcile = () => {
    if (shouldHold() && id === null) {
      id = blocker.start("prevent-app-suspension");
    } else if (!shouldHold() && id !== null) {
      blocker.stop(id);
      id = null;
    }
  };

  return {
    /** Merge a partial state sync from the renderer and reconcile. */
    update(patch: Partial<KeepPlayingState>) {
      Object.assign(state, patch);
      reconcile();
    },
    /** Drop the blocker unconditionally (app quit). Idempotent. */
    release() {
      if (id !== null) {
        blocker.stop(id);
        id = null;
      }
    },
    isHolding: () => id !== null,
  };
}
