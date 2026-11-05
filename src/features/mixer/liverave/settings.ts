// settings.ts — the fresh DJ settings store (design §3.9, §8.3).
//
// zustand, persisted to localStorage under
// "linerave_dj_settings_v1" as one JSON document
// { personalityId, sliders, serverMixingEnabled, serverBaseUrl }.
// Read at init (each field validated, bad fields fall back to
// their defaults individually), written on every change; storage
// failures are swallowed — the in-memory store stays the truth.
//
// The store resolves to a Shaping through shaping.ts:
// resolveCurrentShaping(state) is the pure read, and
// subscribeShaping(listener) pushes the resolved Shaping whenever
// — and only whenever — the resolved shaping actually changes
// (personality or slider edits; server edits do not re-push). It
// does NOT call the listener on subscribe: callers that need the
// current shaping immediately read resolveCurrentShaping once.

import { create } from "zustand";
import {
  NEUTRAL_SLIDERS,
  PERSONALITY_IDS,
  SLIDER_IDS,
  resolveShaping,
  type PersonalityId,
  type Shaping,
  type SliderId,
} from "./shaping";

export const DJ_SETTINGS_STORAGE_KEY = "linerave_dj_settings_v1";

export interface DjSettings {
  personalityId: PersonalityId;
  sliders: Record<SliderId, number>;
  /** §8.3 kill switch: default OFF until hosting exists. */
  serverMixingEnabled: boolean;
  serverBaseUrl: string;
}

export interface DjSettingsState extends DjSettings {
  setPersonality(personalityId: PersonalityId): void;
  setSlider(sliderId: SliderId, value: number): void;
  setSliders(sliders: Record<SliderId, number>): void;
  /** Sets the kill switch; optionally also the server base URL. */
  setServerMixing(enabled: boolean, baseUrl?: string): void;
  setServerBaseUrl(serverBaseUrl: string): void;
  reset(): void;
}

export const DEFAULT_DJ_SETTINGS: DjSettings = {
  personalityId: "autonomous",
  sliders: { ...NEUTRAL_SLIDERS },
  serverMixingEnabled: false,
  serverBaseUrl: "",
};

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function cleanSliderValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

function cleanSettings(raw: unknown): DjSettings {
  const out: DjSettings = {
    personalityId: DEFAULT_DJ_SETTINGS.personalityId,
    sliders: { ...NEUTRAL_SLIDERS },
    serverMixingEnabled: false,
    serverBaseUrl: "",
  };
  if (typeof raw !== "object" || raw === null) return out;
  const doc = raw as Partial<Record<keyof DjSettings, unknown>>;
  if (
    typeof doc.personalityId === "string" &&
    (PERSONALITY_IDS as readonly string[]).includes(doc.personalityId)
  ) {
    out.personalityId = doc.personalityId as PersonalityId;
  }
  if (typeof doc.sliders === "object" && doc.sliders !== null) {
    const stored = doc.sliders as Record<string, unknown>;
    for (const id of SLIDER_IDS) {
      const value = cleanSliderValue(stored[id]);
      if (value !== null) out.sliders[id] = value;
    }
  }
  if (typeof doc.serverMixingEnabled === "boolean") {
    out.serverMixingEnabled = doc.serverMixingEnabled;
  }
  if (typeof doc.serverBaseUrl === "string") {
    out.serverBaseUrl = doc.serverBaseUrl;
  }
  return out;
}

function readPersistedSettings(): DjSettings {
  try {
    const raw = storageOrNull()?.getItem(DJ_SETTINGS_STORAGE_KEY);
    if (!raw)
      return { ...DEFAULT_DJ_SETTINGS, sliders: { ...NEUTRAL_SLIDERS } };
    return cleanSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DJ_SETTINGS, sliders: { ...NEUTRAL_SLIDERS } };
  }
}

function writePersistedSettings(state: DjSettings): void {
  try {
    storageOrNull()?.setItem(
      DJ_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        personalityId: state.personalityId,
        sliders: state.sliders,
        serverMixingEnabled: state.serverMixingEnabled,
        serverBaseUrl: state.serverBaseUrl,
      }),
    );
  } catch {
    // Best-effort persistence (see state.ts).
  }
}

const initial = readPersistedSettings();

export const useDjSettings = create<DjSettingsState>()((set) => ({
  ...initial,
  sliders: { ...initial.sliders },
  setPersonality: (personalityId) =>
    set({
      personalityId: (PERSONALITY_IDS as readonly string[]).includes(
        personalityId,
      )
        ? personalityId
        : "autonomous",
    }),
  setSlider: (sliderId, value) =>
    set((state) => {
      const cleaned = cleanSliderValue(value);
      if (cleaned === null || !SLIDER_IDS.includes(sliderId)) return state;
      if (state.sliders[sliderId] === cleaned) return state;
      return { sliders: { ...state.sliders, [sliderId]: cleaned } };
    }),
  setSliders: (sliders) =>
    set((state) => {
      const next = { ...state.sliders };
      for (const id of SLIDER_IDS) {
        const value = cleanSliderValue(sliders?.[id]);
        if (value !== null) next[id] = value;
      }
      return { sliders: next };
    }),
  setServerMixing: (enabled, baseUrl) =>
    set({
      serverMixingEnabled: Boolean(enabled),
      ...(typeof baseUrl === "string" ? { serverBaseUrl: baseUrl } : {}),
    }),
  setServerBaseUrl: (serverBaseUrl) =>
    set({
      serverBaseUrl: typeof serverBaseUrl === "string" ? serverBaseUrl : "",
    }),
  reset: () =>
    set({
      personalityId: DEFAULT_DJ_SETTINGS.personalityId,
      sliders: { ...NEUTRAL_SLIDERS },
      serverMixingEnabled: false,
      serverBaseUrl: "",
    }),
}));

// Persist on ANY change to a persisted field, including direct
// setState calls from wiring code.
useDjSettings.subscribe((state, prevState) => {
  if (
    state.personalityId !== prevState.personalityId ||
    state.sliders !== prevState.sliders ||
    state.serverMixingEnabled !== prevState.serverMixingEnabled ||
    state.serverBaseUrl !== prevState.serverBaseUrl
  ) {
    writePersistedSettings(state);
  }
});

/** Resolves a settings-shaped value to its Shaping (pure). */
export function resolveCurrentShaping(
  state: Pick<DjSettings, "personalityId" | "sliders">,
): Shaping {
  return resolveShaping(state.personalityId, state.sliders);
}

function shapingSignature(shaping: Shaping): string {
  return JSON.stringify({
    personalityId: shaping.personalityId,
    affinities: shaping.affinities,
    bends: shaping.bends,
  });
}

/**
 * Pushes the resolved Shaping to `listener` whenever it changes.
 * Returns the unsubscribe function. Not called on subscribe.
 */
export function subscribeShaping(
  listener: (shaping: Shaping) => void,
): () => void {
  let lastSignature = shapingSignature(
    resolveCurrentShaping(useDjSettings.getState()),
  );
  return useDjSettings.subscribe((state) => {
    const shaping = resolveCurrentShaping(state);
    const signature = shapingSignature(shaping);
    if (signature === lastSignature) return;
    lastSignature = signature;
    listener(shaping);
  });
}
