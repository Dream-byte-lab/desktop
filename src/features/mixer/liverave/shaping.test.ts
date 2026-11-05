import { describe, expect, it } from "vitest";
import {
  AFFINITY_GLOBAL_MAX,
  AFFINITY_GLOBAL_MIN,
  AFFINITY_TARGETS,
  NEUTRAL_BENDS,
  NEUTRAL_SHAPING,
  NEUTRAL_SLIDERS,
  PERSONALITY_AFFINITY_MAX,
  PERSONALITY_AFFINITY_MIN,
  PERSONALITY_IDS,
  SLIDER_IDS,
  resolveShaping,
  type SliderId,
} from "./shaping";

function sliders(overrides: Partial<Record<SliderId, number>> = {}) {
  return { ...NEUTRAL_SLIDERS, ...overrides };
}

const EXTREME_SETS: Record<SliderId, number>[] = [
  sliders({
    intensity: 0,
    creativity: 0,
    scratching: 0,
    effects: 0,
    transitionComplexity: 0,
    genreFlexibility: 0,
    energyProgression: 0,
    trackSelectionFreedom: 0,
  }),
  sliders({
    intensity: 1,
    creativity: 1,
    scratching: 1,
    effects: 1,
    transitionComplexity: 1,
    genreFlexibility: 1,
    energyProgression: 1,
    trackSelectionFreedom: 1,
  }),
  sliders({
    intensity: 1,
    creativity: 0,
    scratching: 1,
    effects: 0,
    transitionComplexity: 1,
    genreFlexibility: 0,
    energyProgression: 1,
    trackSelectionFreedom: 0,
  }),
  sliders({
    intensity: 0,
    creativity: 1,
    scratching: 0,
    effects: 1,
    transitionComplexity: 0,
    genreFlexibility: 1,
    energyProgression: 0,
    trackSelectionFreedom: 1,
  }),
];

describe("resolveShaping — identity (design §4 invariant 4)", () => {
  it("autonomous + neutral sliders is exactly the neutral shaping", () => {
    const shaping = resolveShaping("autonomous", sliders());
    for (const target of AFFINITY_TARGETS) {
      expect(shaping.affinities[target]).toBe(1);
      expect(shaping.affinity(target)).toBe(1);
    }
    expect(shaping.bends).toEqual(NEUTRAL_BENDS);
    expect(shaping).toEqual(NEUTRAL_SHAPING);
  });

  it("NEUTRAL_SLIDERS is 0.5 on every slider", () => {
    for (const id of SLIDER_IDS) expect(NEUTRAL_SLIDERS[id]).toBe(0.5);
  });
});

describe("resolveShaping — personality band (design §4 invariant 1)", () => {
  it("every personality's affinities sit inside [0.6, 1.7] at neutral sliders", () => {
    for (const id of PERSONALITY_IDS) {
      const shaping = resolveShaping(id, sliders());
      for (const target of AFFINITY_TARGETS) {
        const value = shaping.affinity(target);
        expect(value, `${id}/${target}`).toBeGreaterThanOrEqual(
          PERSONALITY_AFFINITY_MIN,
        );
        expect(value, `${id}/${target}`).toBeLessThanOrEqual(
          PERSONALITY_AFFINITY_MAX,
        );
      }
    }
  });

  it("radio's theatre affinities sit at the band floor but above zero", () => {
    const radio = resolveShaping("radio", sliders());
    for (const target of [
      "stop-exit",
      "scratch-in",
      "scratch-out",
      "fx",
    ] as const) {
      expect(radio.affinity(target)).toBe(PERSONALITY_AFFINITY_MIN);
      expect(radio.affinity(target)).toBeGreaterThan(0);
    }
    // And its smooth families lean the other way.
    expect(radio.affinity("blend")).toBeGreaterThan(1);
  });

  it("battle favours scratches and stops; house favours long blends", () => {
    const battle = resolveShaping("battle", sliders());
    expect(battle.affinity("scratch-in")).toBe(1.7);
    expect(battle.affinity("stop-exit")).toBeGreaterThan(1);
    const house = resolveShaping("house", sliders());
    expect(house.affinity("blend")).toBeGreaterThan(1);
    expect(house.bends.blendBeatsCentre).toBeGreaterThan(
      resolveShaping("autonomous", sliders()).bends.blendBeatsCentre,
    );
    expect(house.affinity("scratch-in")).toBeGreaterThan(0);
  });
});

describe("resolveShaping — global clamp under extreme sliders", () => {
  it("no combination escapes [0.45, 2.2] or reaches 0", () => {
    for (const id of PERSONALITY_IDS) {
      for (const set of EXTREME_SETS) {
        const shaping = resolveShaping(id, set);
        for (const target of AFFINITY_TARGETS) {
          const value = shaping.affinity(target);
          expect(value, `${id}/${target}`).toBeGreaterThanOrEqual(
            AFFINITY_GLOBAL_MIN,
          );
          expect(value, `${id}/${target}`).toBeLessThanOrEqual(
            AFFINITY_GLOBAL_MAX,
          );
          expect(value).toBeGreaterThan(0);
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });

  it("the clamp actually bites: battle + max scratching pins at 2.2", () => {
    // 1.7 (battle) x 1.35 (scratching slider at max) = 2.295 -> clamp.
    const shaping = resolveShaping("battle", sliders({ scratching: 1 }));
    expect(shaping.affinity("scratch-in")).toBe(AFFINITY_GLOBAL_MAX);
  });

  it("a single slider's bend is bounded and exact at its extreme", () => {
    // Autonomous scratch-in: personality 1 x (1 + 0.35 x 1 x 1) = 1.35.
    const shaping = resolveShaping("autonomous", sliders({ scratching: 1 }));
    expect(shaping.affinity("scratch-in")).toBeCloseTo(1.35);
    const low = resolveShaping("autonomous", sliders({ scratching: 0 }));
    expect(low.affinity("scratch-in")).toBeCloseTo(0.65);
  });
});

describe("resolveShaping — bends derive monotonically from sliders", () => {
  it("scratchDensity rises with the scratching slider", () => {
    const low = resolveShaping("club", sliders({ scratching: 0 })).bends
      .scratchDensity;
    const mid = resolveShaping("club", sliders({ scratching: 0.5 })).bends
      .scratchDensity;
    const high = resolveShaping("club", sliders({ scratching: 1 })).bends
      .scratchDensity;
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("blendBeatsCentre rises with transitionComplexity; tolerances with their sliders", () => {
    const base = resolveShaping("autonomous", sliders()).bends;
    const bent = resolveShaping(
      "autonomous",
      sliders({
        transitionComplexity: 1,
        genreFlexibility: 1,
        trackSelectionFreedom: 1,
        energyProgression: 1,
        effects: 1,
      }),
    ).bends;
    expect(bent.blendBeatsCentre).toBeGreaterThan(base.blendBeatsCentre);
    expect(bent.keyTempoTolerance).toBeGreaterThan(base.keyTempoTolerance);
    expect(bent.selectionFreedom).toBeGreaterThan(base.selectionFreedom);
    expect(bent.arcSteepness).toBeGreaterThan(base.arcSteepness);
    expect(bent.fxDensity).toBeGreaterThan(base.fxDensity);
  });

  it("out-of-range and non-finite sliders are clamped / neutralised", () => {
    const shaping = resolveShaping(
      "autonomous",
      sliders({ scratching: 5, effects: Number.NaN }),
    );
    expect(shaping.affinity("scratch-in")).toBeCloseTo(1.35);
    expect(shaping.affinity("fx")).toBe(1);
  });
});
