import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SLIDERS, PERSONALITY_IDS } from "../engine/personality";
import {
  PERSONALITY_KEY,
  activeSlidersOf,
  readPersistedPersonalityState,
  usePersonalityStore,
} from "./personalityStore";

// The personality store: defaults, the sparse persistence
// round-trip, per-personality slider memory, clamping, and
// corrupt-storage recovery. localStorage is cleared and the store
// is re-read from storage in beforeEach, so each test starts from
// the same state a fresh app launch would see.

function resetStoreFromStorage(): void {
  usePersonalityStore.setState(readPersistedPersonalityState());
}

describe("personalityStore", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStoreFromStorage();
  });

  it("defaults when storage is empty: autonomous + DEFAULT_SLIDERS everywhere", () => {
    const state = usePersonalityStore.getState();
    expect(state.personalityId).toBe("autonomous");
    for (const id of PERSONALITY_IDS) {
      expect(state.slidersByPersonality[id]).toEqual(DEFAULT_SLIDERS);
    }
    expect(activeSlidersOf(state)).toEqual(DEFAULT_SLIDERS);

    const read = readPersistedPersonalityState();
    expect(read.personalityId).toBe("autonomous");
    for (const id of PERSONALITY_IDS) {
      expect(read.slidersByPersonality[id]).toEqual(DEFAULT_SLIDERS);
    }
  });

  it("persists sparsely and round-trips through a fresh read", () => {
    usePersonalityStore.getState().setPersonality("club");
    usePersonalityStore.getState().setSlider("intensity", 0.9);

    // On disk: only the bent slider, only for the bent personality.
    const raw = localStorage.getItem(PERSONALITY_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      personalityId: "club",
      sliders: { club: { intensity: 0.9 } },
    });

    const read = readPersistedPersonalityState();
    expect(read.personalityId).toBe("club");
    expect(read.slidersByPersonality.club).toEqual({
      ...DEFAULT_SLIDERS,
      intensity: 0.9,
    });
    // Every other personality is present in memory, at defaults.
    for (const id of PERSONALITY_IDS) {
      if (id === "club") continue;
      expect(read.slidersByPersonality[id]).toEqual(DEFAULT_SLIDERS);
    }
  });

  it("remembers each personality's sliders separately", () => {
    usePersonalityStore.getState().setPersonality("club");
    usePersonalityStore.getState().setSlider("scratching", 0.95);
    expect(activeSlidersOf(usePersonalityStore.getState()).scratching).toBe(
      0.95,
    );

    usePersonalityStore.getState().setPersonality("battle");
    // Battle has not been bent: its scratching is still neutral.
    expect(activeSlidersOf(usePersonalityStore.getState()).scratching).toBe(
      0.5,
    );
    usePersonalityStore.getState().setSlider("scratching", 0.1);

    usePersonalityStore.getState().setPersonality("club");
    // Club's bend survived the round trip through Battle.
    expect(activeSlidersOf(usePersonalityStore.getState()).scratching).toBe(
      0.95,
    );

    usePersonalityStore.getState().setPersonality("battle");
    expect(activeSlidersOf(usePersonalityStore.getState()).scratching).toBe(
      0.1,
    );

    const read = readPersistedPersonalityState();
    expect(read.slidersByPersonality.club.scratching).toBe(0.95);
    expect(read.slidersByPersonality.battle.scratching).toBe(0.1);
  });

  it("setSlider clamps to 0..1 and ignores non-finite values", () => {
    usePersonalityStore.getState().setSlider("intensity", 2);
    expect(activeSlidersOf(usePersonalityStore.getState()).intensity).toBe(1);
    usePersonalityStore.getState().setSlider("intensity", -1);
    expect(activeSlidersOf(usePersonalityStore.getState()).intensity).toBe(0);
    usePersonalityStore.getState().setSlider("intensity", Number.NaN);
    expect(activeSlidersOf(usePersonalityStore.getState()).intensity).toBe(0);
    usePersonalityStore
      .getState()
      .setSlider("intensity", Number.POSITIVE_INFINITY);
    expect(activeSlidersOf(usePersonalityStore.getState()).intensity).toBe(0);
  });

  it("the read path clamps persisted values and ignores unknown keys", () => {
    localStorage.setItem(
      PERSONALITY_KEY,
      JSON.stringify({
        personalityId: "house",
        sliders: {
          house: { intensity: 5, creativity: -3, bogus: 0.2 },
          "not-a-personality": { intensity: 0.1 },
        },
      }),
    );
    const read = readPersistedPersonalityState();
    expect(read.personalityId).toBe("house");
    expect(read.slidersByPersonality.house.intensity).toBe(1);
    expect(read.slidersByPersonality.house.creativity).toBe(0);
    expect(read.slidersByPersonality.house.scratching).toBe(0.5);
  });

  it("an unknown persisted personality falls back to autonomous", () => {
    localStorage.setItem(
      PERSONALITY_KEY,
      JSON.stringify({ personalityId: "nope", sliders: {} }),
    );
    expect(readPersistedPersonalityState().personalityId).toBe("autonomous");
  });

  it("corrupt JSON in storage reads as defaults, without throwing", () => {
    localStorage.setItem(PERSONALITY_KEY, "{not json");
    let read: ReturnType<typeof readPersistedPersonalityState> | undefined;
    expect(() => {
      read = readPersistedPersonalityState();
    }).not.toThrow();
    expect(read!.personalityId).toBe("autonomous");
    for (const id of PERSONALITY_IDS) {
      expect(read!.slidersByPersonality[id]).toEqual(DEFAULT_SLIDERS);
    }
  });

  it("resetSliders returns the active personality to neutral, and persists it", () => {
    usePersonalityStore.getState().setPersonality("club");
    usePersonalityStore.getState().setSlider("effects", 0.05);
    usePersonalityStore.getState().resetSliders();
    expect(activeSlidersOf(usePersonalityStore.getState())).toEqual(
      DEFAULT_SLIDERS,
    );
    const read = readPersistedPersonalityState();
    expect(read.personalityId).toBe("club");
    expect(read.slidersByPersonality.club).toEqual(DEFAULT_SLIDERS);
  });
});
