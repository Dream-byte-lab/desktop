import { create } from "zustand";
import {
  DEFAULT_SLIDERS,
  PERSONALITY_IDS,
  SLIDER_IDS,
  type PersonalityId,
  type SliderId,
  type SliderSettings,
} from "../engine/personality";

// The listener's DJ temperament (revamp slice R4): which
// personality is standing, and how each personality's eight
// sliders have been bent. Like DJ intent, this is a standing
// setting — it persists across restarts (linerave_personality_v1,
// the app's localStorage idiom) and a session ending never touches
// it.
//
// On disk the shape is sparse: { personalityId, sliders:
// { [personalityId]: partial SliderSettings } } — only the sliders
// a listener actually bent away from neutral are written, per
// personality. In memory every personality is always present with
// a full SliderSettings, DEFAULT_SLIDERS merged under whatever was
// persisted, so readers never have to know about the sparsity.

export const PERSONALITY_KEY = "linerave_personality_v1";

export interface PersistedPersonalityState {
  personalityId: PersonalityId;
  slidersByPersonality: Record<PersonalityId, SliderSettings>;
}

function clampSlider(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function defaultSlidersByPersonality(): Record<PersonalityId, SliderSettings> {
  const result = {} as Record<PersonalityId, SliderSettings>;
  for (const id of PERSONALITY_IDS) {
    result[id] = { ...DEFAULT_SLIDERS };
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the persisted temperament, validating as it goes: an
 * unknown personality falls back to "autonomous", each slider
 * value must be a finite number (clamped to 0..1), and unknown
 * keys — personalities or sliders — are ignored. Corrupt or
 * missing storage reads as the defaults, never a throw.
 */
export function readPersistedPersonalityState(): PersistedPersonalityState {
  const slidersByPersonality = defaultSlidersByPersonality();
  let personalityId: PersonalityId = "autonomous";
  try {
    const raw = localStorage.getItem(PERSONALITY_KEY);
    if (!raw) return { personalityId, slidersByPersonality };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { personalityId, slidersByPersonality };
    if (
      typeof parsed.personalityId === "string" &&
      (PERSONALITY_IDS as readonly string[]).includes(parsed.personalityId)
    ) {
      personalityId = parsed.personalityId as PersonalityId;
    }
    if (isRecord(parsed.sliders)) {
      for (const id of PERSONALITY_IDS) {
        const partial = parsed.sliders[id];
        if (!isRecord(partial)) continue;
        for (const sliderId of SLIDER_IDS) {
          const value = partial[sliderId];
          if (typeof value === "number" && Number.isFinite(value)) {
            slidersByPersonality[id][sliderId] = clampSlider(value);
          }
        }
      }
    }
  } catch {
    return {
      personalityId: "autonomous",
      slidersByPersonality: defaultSlidersByPersonality(),
    };
  }
  return { personalityId, slidersByPersonality };
}

/** The sparse on-disk shape for a full in-memory state. */
function sparseSlidersOf(
  slidersByPersonality: Record<PersonalityId, SliderSettings>,
): Record<string, Partial<SliderSettings>> {
  const sparse: Record<string, Partial<SliderSettings>> = {};
  for (const id of PERSONALITY_IDS) {
    const partial: Partial<SliderSettings> = {};
    for (const sliderId of SLIDER_IDS) {
      const value = slidersByPersonality[id][sliderId];
      if (value !== DEFAULT_SLIDERS[sliderId]) partial[sliderId] = value;
    }
    if (Object.keys(partial).length > 0) sparse[id] = partial;
  }
  return sparse;
}

function persistPersonalityState(
  personalityId: PersonalityId,
  slidersByPersonality: Record<PersonalityId, SliderSettings>,
): void {
  try {
    localStorage.setItem(
      PERSONALITY_KEY,
      JSON.stringify({
        personalityId,
        sliders: sparseSlidersOf(slidersByPersonality),
      }),
    );
  } catch {}
}

/** The active personality's sliders, from any state-shaped value. */
export function activeSlidersOf(state: {
  personalityId: PersonalityId;
  slidersByPersonality: Record<PersonalityId, SliderSettings>;
}): SliderSettings {
  return state.slidersByPersonality[state.personalityId] ?? DEFAULT_SLIDERS;
}

interface PersonalityState extends PersistedPersonalityState {
  /** Makes `id` the standing personality, keeping every bend. */
  setPersonality: (id: PersonalityId) => void;
  /** Bends one slider of the ACTIVE personality (clamped 0..1). */
  setSlider: (sliderId: SliderId, value: number) => void;
  /** Returns the ACTIVE personality's sliders to neutral. */
  resetSliders: () => void;
}

export const usePersonalityStore = create<PersonalityState>((set, get) => ({
  ...readPersistedPersonalityState(),
  setPersonality: (id) => {
    if (!(PERSONALITY_IDS as readonly string[]).includes(id)) return;
    const { slidersByPersonality } = get();
    persistPersonalityState(id, slidersByPersonality);
    set({ personalityId: id });
  },
  setSlider: (sliderId, value) => {
    if (!Number.isFinite(value)) return;
    if (!(SLIDER_IDS as readonly string[]).includes(sliderId)) return;
    const { personalityId, slidersByPersonality } = get();
    const next: Record<PersonalityId, SliderSettings> = {
      ...slidersByPersonality,
      [personalityId]: {
        ...slidersByPersonality[personalityId],
        [sliderId]: clampSlider(value),
      },
    };
    persistPersonalityState(personalityId, next);
    set({ slidersByPersonality: next });
  },
  resetSliders: () => {
    const { personalityId, slidersByPersonality } = get();
    const next: Record<PersonalityId, SliderSettings> = {
      ...slidersByPersonality,
      [personalityId]: { ...DEFAULT_SLIDERS },
    };
    persistPersonalityState(personalityId, next);
    set({ slidersByPersonality: next });
  },
}));
