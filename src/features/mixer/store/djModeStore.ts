import { create } from "zustand";

// DJ mode is TWO facts, not one (Note 20):
//
// - `intent` is the USER's standing setting — DJ mode is on — and
//   it persists across restarts (liner_dj_intent_v1, the app's
//   localStorage idiom). The DJ switch shows THIS. A session that
//   ends on its own never turns the setting off underneath the
//   user; that conflation is what made the DJ "turn itself off"
//   after every set.
// - `active` mirrors whether a session is actually running, kept
//   in step through the session's running-change notice (wired in
//   djIntentWiring.ts). The party's lifecycle and the DJ views
//   read this one, exactly as they always have.

export const DJ_INTENT_KEY = "liner_dj_intent_v1";

export function readPersistedDjIntent(): boolean {
  try {
    return localStorage.getItem(DJ_INTENT_KEY) === "1";
  } catch {
    return false;
  }
}

function persistDjIntent(on: boolean): void {
  try {
    if (on) localStorage.setItem(DJ_INTENT_KEY, "1");
    else localStorage.removeItem(DJ_INTENT_KEY);
  } catch {}
}

interface DjModeState {
  /** The user's standing DJ setting; persists across restarts. */
  intent: boolean;
  /** True while a DJ session is actually running. */
  active: boolean;
  /** True while a blend between two tracks is actually sounding. */
  blending: boolean;
  /** Whether the Pro controls panel is open. */
  proOpen: boolean;
  setIntent: (intent: boolean) => void;
  setActive: (active: boolean) => void;
  setBlending: (blending: boolean) => void;
  setProOpen: (proOpen: boolean) => void;
}

export const useDjModeStore = create<DjModeState>((set) => ({
  intent: readPersistedDjIntent(),
  active: false,
  blending: false,
  proOpen: false,
  setIntent: (intent) => {
    persistDjIntent(intent);
    set({ intent });
  },
  setActive: (active) => set({ active }),
  setBlending: (blending) => set({ blending }),
  setProOpen: (proOpen) => set({ proOpen }),
}));
