// state.ts — the fresh DJ mode store (design §3.9).
//
// zustand, split by lifetime:
// - `intent` — the user's standing "DJ on" wish — is PERSISTED to
//   localStorage under "linerave_dj_intent_v2" (read at init,
//   written on every change; storage failures are swallowed — a
//   private-mode browser loses persistence, never the store).
//   Stored as the plain string "true" / "false".
// - Everything else (active, blending, proOpen, controlLevel) is
//   session-ephemeral and resets with the app.

import { create } from "zustand";

export const DJ_INTENT_STORAGE_KEY = "linerave_dj_intent_v2";

export type DjControlLevel = "autonomous" | "assisted" | "manual";
/** Alias matching the session's vocabulary for the same union. */
export type ControlLevel = DjControlLevel;

export const DJ_CONTROL_LEVELS: readonly DjControlLevel[] = [
  "autonomous",
  "assisted",
  "manual",
];

export interface DjState {
  /** Persisted: the user's standing DJ-on intent. */
  intent: boolean;
  /** A session is running right now. */
  active: boolean;
  /** A join is being performed right now. */
  blending: boolean;
  /** The pro (booth) surface is open. */
  proOpen: boolean;
  controlLevel: DjControlLevel;
  setIntent(intent: boolean): void;
  setActive(active: boolean): void;
  setBlending(blending: boolean): void;
  setProOpen(proOpen: boolean): void;
  setControlLevel(controlLevel: DjControlLevel): void;
}

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Reads the persisted intent. Accepts the plain "true"/"false" this
 * module writes (and, defensively, a JSON boolean or an object with
 * a boolean `intent`). Anything else — including absence and any
 * storage error — is false.
 */
export function readPersistedDjIntent(): boolean {
  try {
    const raw = storageOrNull()?.getItem(DJ_INTENT_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false" || raw === null || raw === undefined) return false;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "boolean") return parsed;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { intent?: unknown }).intent === "boolean"
    ) {
      return (parsed as { intent: boolean }).intent;
    }
    return false;
  } catch {
    return false;
  }
}

function writePersistedDjIntent(intent: boolean): void {
  try {
    storageOrNull()?.setItem(DJ_INTENT_STORAGE_KEY, intent ? "true" : "false");
  } catch {
    // Persistence is best-effort; the in-memory store is the truth
    // for this run.
  }
}

export const useDjState = create<DjState>()((set) => ({
  intent: readPersistedDjIntent(),
  active: false,
  blending: false,
  proOpen: false,
  controlLevel: "autonomous",
  setIntent: (intent) => set({ intent: Boolean(intent) }),
  setActive: (active) => set({ active: Boolean(active) }),
  setBlending: (blending) => set({ blending: Boolean(blending) }),
  setProOpen: (proOpen) => set({ proOpen: Boolean(proOpen) }),
  setControlLevel: (controlLevel) =>
    set({
      controlLevel: DJ_CONTROL_LEVELS.includes(controlLevel)
        ? controlLevel
        : "autonomous",
    }),
}));

// Persist intent on ANY change, including direct setState calls
// from wiring code — the setter is not the only door.
useDjState.subscribe((state, prevState) => {
  if (state.intent !== prevState.intent) {
    writePersistedDjIntent(state.intent);
  }
});
