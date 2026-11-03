import { describe, expect, it } from "vitest";
import {
  ADVENTUROUS_PROFILE,
  JOIN_FAMILIES,
  STANDARD_PROFILE,
} from "./decisionProfile";
import {
  DEFAULT_CURATION_BENDS,
  DEFAULT_SLIDERS,
  PERSONALITIES,
  PERSONALITY_IDS,
  SLIDER_IDS,
  isNeutralSliders,
  resolveDecisionSettings,
  sliderSettingsEqual,
  type PersonalityId,
  type SliderId,
  type SliderSettings,
} from "./personality";
import type { ArcShapeName } from "./curatedSet";

// R4: personalities are decision preferences only, resolved by one
// pure function. These tests pin the three promises the slice
// makes: autonomous at neutral sliders IS the pre-R4 engine by
// identity; every personality at default sliders is exactly its
// anchor plus its stated overrides; and every slider bend is the
// identity at 0.5 and moves its judgement in the named direction.

function withSlider(id: SliderId, value: number): SliderSettings {
  return { ...DEFAULT_SLIDERS, [id]: value };
}

function allSliders(value: number): SliderSettings {
  return {
    intensity: value,
    creativity: value,
    scratching: value,
    effects: value,
    "transition-complexity": value,
    "genre-flexibility": value,
    "energy-progression": value,
    "track-selection-freedom": value,
  };
}

function weightSum(sliders: SliderSettings, id: PersonalityId): number {
  const w = resolveDecisionSettings(id, sliders).profile.weights;
  return (
    w.keyFit +
    w.vocalClarity +
    w.stretchFit +
    w.structureFit +
    w.loopValue +
    w.arcFit
  );
}

describe("personality — parity", () => {
  it("autonomous at neutral sliders returns STANDARD_PROFILE by identity", () => {
    const resolved = resolveDecisionSettings("autonomous", DEFAULT_SLIDERS);
    expect(resolved.profile).toBe(STANDARD_PROFILE);
    expect(resolved.curation).toEqual({
      nearEqualEpsilon: 0.05,
      sharedLabelCredit: 0.6,
      incumbencyPenalty: 0.1,
    });
    expect(resolved.curation).toEqual(DEFAULT_CURATION_BENDS);
    expect(resolved.arcShapeLean).toBeNull();
  });

  it("exposes the ids in the stated order and neutral helpers", () => {
    expect(PERSONALITY_IDS).toEqual([
      "autonomous",
      "club",
      "battle",
      "house",
      "open-format",
      "experimental",
      "radio",
    ]);
    expect(SLIDER_IDS).toEqual([
      "intensity",
      "creativity",
      "scratching",
      "effects",
      "transition-complexity",
      "genre-flexibility",
      "energy-progression",
      "track-selection-freedom",
    ]);
    expect(isNeutralSliders(DEFAULT_SLIDERS)).toBe(true);
    expect(isNeutralSliders(withSlider("intensity", 0.6))).toBe(false);
    expect(sliderSettingsEqual(DEFAULT_SLIDERS, { ...DEFAULT_SLIDERS })).toBe(
      true,
    );
    expect(sliderSettingsEqual(DEFAULT_SLIDERS, withSlider("effects", 0))).toBe(
      false,
    );
    for (const id of PERSONALITY_IDS) {
      expect(PERSONALITIES[id].id).toBe(id);
    }
  });
});

interface DefaultsExpectation {
  id: Exclude<PersonalityId, "autonomous">;
  label: string;
  standardBlendBeats: number;
  longBlendBeats: number;
  minBlendBeats?: number;
  minLeadBeats: number;
  minDropCutStrength: number;
  vocalClashIntegral: number;
  distantKeyMaxBlendBeats: number;
  maxStretchUp: number;
  maxStretchDown: number;
  nearEqualBand: number;
  arcShapeLean: ArcShapeName | null;
  sharedLabelCredit: number;
  costs: Partial<Record<string, number>>;
}

const DEFAULTS_TABLE: DefaultsExpectation[] = [
  {
    id: "club",
    label: "Club",
    standardBlendBeats: 20,
    longBlendBeats: 32,
    minLeadBeats: 8,
    minDropCutStrength: 1.2,
    vocalClashIntegral: 0.4,
    distantKeyMaxBlendBeats: 8,
    maxStretchUp: 0.12,
    maxStretchDown: 0.06,
    nearEqualBand: 0.05,
    arcShapeLean: null,
    sharedLabelCredit: 0.6,
    costs: { fx: 0.3, "drop-cut": 0.02, "echo-out": 0.04, "let-it-play": 0.05 },
  },
  {
    id: "battle",
    label: "Battle",
    standardBlendBeats: 12,
    longBlendBeats: 32,
    minLeadBeats: 6,
    minDropCutStrength: 1.2,
    vocalClashIntegral: 0.45,
    distantKeyMaxBlendBeats: 8,
    maxStretchUp: 0.15,
    maxStretchDown: 0.09,
    nearEqualBand: 0.09,
    arcShapeLean: null,
    sharedLabelCredit: 0.6,
    costs: {
      scratch: 0.18,
      spinback: 0.2,
      "vinyl-stop": 0.2,
      "drop-cut": 0.01,
      "early-cut": 0.01,
      "short-blend": 0.01,
      "long-blend": 0.03,
      "let-it-play": 0.1,
    },
  },
  {
    id: "house",
    label: "House",
    standardBlendBeats: 24,
    longBlendBeats: 32,
    minBlendBeats: 8,
    minLeadBeats: 8,
    minDropCutStrength: 1.5,
    vocalClashIntegral: 0.35,
    distantKeyMaxBlendBeats: 8,
    maxStretchUp: 0.12,
    maxStretchDown: 0.06,
    nearEqualBand: 0.05,
    arcShapeLean: "slow-burn",
    sharedLabelCredit: 0.6,
    costs: {
      "loop-extended-blend": 0.01,
      "long-blend": 0,
      scratch: 0.65,
      spinback: 0.6,
      "vinyl-stop": 0.6,
      fx: 0.35,
      "drop-cut": 0.06,
      "early-cut": 0.08,
      "let-it-play": 0.02,
    },
  },
  {
    id: "open-format",
    label: "Open Format",
    standardBlendBeats: 16,
    longBlendBeats: 24,
    minLeadBeats: 8,
    minDropCutStrength: 1.5,
    vocalClashIntegral: 0.4,
    distantKeyMaxBlendBeats: 12,
    maxStretchUp: 0.13,
    maxStretchDown: 0.07,
    nearEqualBand: 0.07,
    arcShapeLean: null,
    sharedLabelCredit: 0.25,
    costs: { "section-swap": 0.02, "drop-cut": 0.03 },
  },
  {
    id: "experimental",
    label: "Experimental",
    standardBlendBeats: 16,
    longBlendBeats: 32,
    minLeadBeats: 8,
    minDropCutStrength: 1.2,
    vocalClashIntegral: 0.45,
    distantKeyMaxBlendBeats: 8,
    maxStretchUp: 0.15,
    maxStretchDown: 0.09,
    nearEqualBand: 0.11,
    arcShapeLean: null,
    sharedLabelCredit: 0.6,
    costs: {
      fx: 0.18,
      scratch: 0.25,
      "loop-extended-blend": 0,
      "section-swap": 0.01,
      "filter-fade": 0.02,
      spinback: 0.22,
      "vinyl-stop": 0.22,
      "let-it-play": 0.12,
    },
  },
  {
    id: "radio",
    label: "Radio",
    standardBlendBeats: 14,
    longBlendBeats: 16,
    minLeadBeats: 8,
    minDropCutStrength: 2.2,
    vocalClashIntegral: 0.3,
    distantKeyMaxBlendBeats: 4,
    maxStretchUp: 0.08,
    maxStretchDown: 0.06,
    nearEqualBand: 0.03,
    arcShapeLean: null,
    sharedLabelCredit: 0.6,
    costs: { "let-it-play": 0, "drop-cut": 0.12, "early-cut": 0.08 },
  },
];

describe("personality — defaults tables", () => {
  for (const row of DEFAULTS_TABLE) {
    it(`${row.id} at default sliders is its anchor plus its overrides`, () => {
      const resolved = resolveDecisionSettings(row.id, DEFAULT_SLIDERS);
      const p = resolved.profile;
      expect(p.id).toBe(row.id);
      expect(p.label).toBe(row.label);
      expect(p.standardBlendBeats).toBe(row.standardBlendBeats);
      expect(p.longBlendBeats).toBe(row.longBlendBeats);
      if (row.minBlendBeats !== undefined) {
        expect(p.minBlendBeats).toBe(row.minBlendBeats);
      }
      expect(p.minLeadBeats).toBe(row.minLeadBeats);
      expect(p.minDropCutStrength).toBe(row.minDropCutStrength);
      expect(p.vocalClashIntegral).toBe(row.vocalClashIntegral);
      expect(p.distantKeyMaxBlendBeats).toBe(row.distantKeyMaxBlendBeats);
      expect(p.maxStretchUp).toBe(row.maxStretchUp);
      expect(p.maxStretchDown).toBe(row.maxStretchDown);
      expect(p.nearEqualBand).toBeCloseTo(row.nearEqualBand, 12);
      expect(resolved.arcShapeLean).toBe(row.arcShapeLean);
      expect(resolved.curation.sharedLabelCredit).toBe(row.sharedLabelCredit);
      expect(resolved.curation.nearEqualEpsilon).toBe(0.05);
      expect(resolved.curation.incumbencyPenalty).toBe(0.1);
      for (const [family, cost] of Object.entries(row.costs)) {
        expect(
          p.familyCosts[family as keyof typeof p.familyCosts],
          `${row.id} cost ${family}`,
        ).toBe(cost);
      }
      // The resolved record carries every join family.
      for (const family of JOIN_FAMILIES) {
        expect(typeof p.familyCosts[family]).toBe("number");
      }
    });
  }

  it("experimental scales anti-repetition by 1.25 at defaults", () => {
    const anti = resolveDecisionSettings("experimental", DEFAULT_SLIDERS)
      .profile.antiRepetition;
    expect(anti.familyRepeatCost).toBeCloseTo(0.2, 12);
    expect(anti.familyRepeatCostOtherShape).toBeCloseTo(0.0625, 12);
    expect(anti.geometryRepeatCost).toBeCloseTo(0.125, 12);
    expect(anti.samePairCost).toBeCloseTo(0.375, 12);
    expect(anti.heardLengthRepeatCost).toBeCloseTo(0.15, 12);
    expect(anti.maxCost).toBeCloseTo(0.75, 12);
    expect(anti.windowJoins).toBe(
      ADVENTUROUS_PROFILE.antiRepetition.windowJoins,
    );
  });

  it("pinned theatre price gates survive at defaults", () => {
    // STANDARD / ADVENTUROUS / CONSERVATIVE anchors, via the
    // personalities that anchor on them without overriding these.
    expect(
      resolveDecisionSettings("club", DEFAULT_SLIDERS).profile.familyCosts
        .spinback,
    ).toBe(0.45);
    expect(
      resolveDecisionSettings("open-format", DEFAULT_SLIDERS).profile
        .familyCosts.scratch,
    ).toBe(0.5);
    expect(
      resolveDecisionSettings("radio", DEFAULT_SLIDERS).profile.familyCosts
        .scratch,
    ).toBe(0.75);
    expect(
      resolveDecisionSettings("radio", DEFAULT_SLIDERS).profile.familyCosts.fx,
    ).toBe(0.7);
  });
});

describe("personality — weights invariant", () => {
  it("weights sum to 1 and stay positive for every personality", () => {
    const sliderSets: SliderSettings[] = [
      DEFAULT_SLIDERS,
      allSliders(0),
      allSliders(1),
      withSlider("intensity", 0),
      withSlider("intensity", 1),
      withSlider("genre-flexibility", 0),
      withSlider("genre-flexibility", 1),
      withSlider("energy-progression", 0),
      withSlider("energy-progression", 1),
    ];
    for (const id of PERSONALITY_IDS) {
      for (const sliders of sliderSets) {
        expect(Math.abs(weightSum(sliders, id) - 1)).toBeLessThan(1e-9);
        const w = resolveDecisionSettings(id, sliders).profile.weights;
        for (const value of Object.values(w)) {
          expect(value).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("personality — bend directions", () => {
  it("scratching bends scratch / spinback / vinyl-stop costs", () => {
    const low = resolveDecisionSettings(
      "autonomous",
      withSlider("scratching", 0),
    ).profile;
    const mid = resolveDecisionSettings(
      "autonomous",
      withSlider("scratching", 0.5),
    ).profile;
    const high = resolveDecisionSettings(
      "autonomous",
      withSlider("scratching", 1),
    ).profile;
    // Autonomous with bends keeps the standard identity.
    expect(mid.id).toBe("standard");
    expect(mid.label).toBe("Standard");
    expect(low.familyCosts.scratch).toBeGreaterThan(mid.familyCosts.scratch);
    expect(high.familyCosts.scratch).toBeLessThan(mid.familyCosts.scratch);
    expect(low.familyCosts.spinback).toBeGreaterThan(mid.familyCosts.spinback);
    expect(high.familyCosts.spinback).toBeLessThan(mid.familyCosts.spinback);
    expect(high.familyCosts["vinyl-stop"]).toBeLessThan(
      mid.familyCosts["vinyl-stop"],
    );
    expect(mid.familyCosts.scratch).toBeCloseTo(0.5, 12);
    expect(high.familyCosts.scratch).toBeCloseTo(0.35, 12);
    expect(low.familyCosts.scratch).toBeCloseTo(0.65, 12);
  });

  it("scratching at 1 brings house scratch back inside the 0.5 ceiling", () => {
    const resolved = resolveDecisionSettings(
      "house",
      withSlider("scratching", 1),
    );
    expect(resolved.profile.familyCosts.scratch).toBeLessThanOrEqual(0.5);
    expect(resolved.profile.familyCosts.scratch).toBeCloseTo(0.5, 12);
  });

  it("effects bends fx the same way", () => {
    const low = resolveDecisionSettings(
      "autonomous",
      withSlider("effects", 0),
    ).profile;
    const mid = resolveDecisionSettings(
      "autonomous",
      withSlider("effects", 0.5),
    ).profile;
    const high = resolveDecisionSettings(
      "autonomous",
      withSlider("effects", 1),
    ).profile;
    expect(low.familyCosts.fx).toBeGreaterThan(mid.familyCosts.fx);
    expect(high.familyCosts.fx).toBeLessThan(mid.familyCosts.fx);
    expect(high.familyCosts.fx).toBeCloseTo(0.3, 12);
    expect(low.familyCosts.fx).toBeCloseTo(0.6, 12);
  });

  it("genre-flexibility lowers keyFit share and widens distant blends", () => {
    const mid = resolveDecisionSettings("club", DEFAULT_SLIDERS);
    const high = resolveDecisionSettings(
      "club",
      withSlider("genre-flexibility", 1),
    );
    expect(high.profile.weights.keyFit).toBeLessThan(
      mid.profile.weights.keyFit,
    );
    expect(high.profile.distantKeyMaxBlendBeats).toBeGreaterThan(
      mid.profile.distantKeyMaxBlendBeats,
    );
    expect(high.profile.distantKeyMaxBlendBeats).toBe(
      mid.profile.distantKeyMaxBlendBeats + 4,
    );
    expect(high.curation.sharedLabelCredit).toBeLessThan(
      mid.curation.sharedLabelCredit,
    );
    // Open-format bends around its 0.25 override, not the 0.6 base.
    const openHigh = resolveDecisionSettings(
      "open-format",
      withSlider("genre-flexibility", 1),
    );
    expect(openHigh.curation.sharedLabelCredit).toBeCloseTo(0, 12);
    const openLow = resolveDecisionSettings(
      "open-format",
      withSlider("genre-flexibility", 0),
    );
    expect(openLow.curation.sharedLabelCredit).toBeCloseTo(0.6, 12);
  });

  it("creativity widens the band and raises anti-repetition costs", () => {
    const mid = resolveDecisionSettings("club", DEFAULT_SLIDERS).profile;
    const high = resolveDecisionSettings(
      "club",
      withSlider("creativity", 1),
    ).profile;
    expect(high.nearEqualBand).toBeGreaterThan(mid.nearEqualBand);
    expect(high.nearEqualBand).toBeCloseTo(0.08, 12);
    expect(high.antiRepetition.familyRepeatCost).toBeGreaterThan(
      mid.antiRepetition.familyRepeatCost,
    );
    expect(high.antiRepetition.samePairCost).toBeGreaterThan(
      mid.antiRepetition.samePairCost,
    );
    expect(high.antiRepetition.windowJoins).toBe(
      mid.antiRepetition.windowJoins,
    );
  });

  it("intensity lengthens blends", () => {
    const mid = resolveDecisionSettings("club", DEFAULT_SLIDERS).profile;
    const high = resolveDecisionSettings(
      "club",
      withSlider("intensity", 1),
    ).profile;
    expect(high.standardBlendBeats).toBeGreaterThan(mid.standardBlendBeats);
    expect(high.longBlendBeats).toBeGreaterThan(mid.longBlendBeats);
    expect(high.standardBlendBeats).toBe(26);
  });

  it("energy-progression raises arcFit's share of the weights", () => {
    const mid = resolveDecisionSettings("club", DEFAULT_SLIDERS).profile;
    const high = resolveDecisionSettings(
      "club",
      withSlider("energy-progression", 1),
    ).profile;
    expect(high.weights.arcFit).toBeGreaterThan(mid.weights.arcFit);
  });

  it("track-selection-freedom widens epsilon and shrinks incumbency", () => {
    const mid = resolveDecisionSettings("club", DEFAULT_SLIDERS).curation;
    const high = resolveDecisionSettings(
      "club",
      withSlider("track-selection-freedom", 1),
    ).curation;
    expect(high.nearEqualEpsilon).toBeGreaterThan(mid.nearEqualEpsilon);
    expect(high.nearEqualEpsilon).toBeCloseTo(0.09, 12);
    expect(high.incumbencyPenalty).toBeLessThan(mid.incumbencyPenalty);
    expect(high.incumbencyPenalty).toBeCloseTo(0.04, 12);
  });

  it("transition-complexity favours complex families over simple ones", () => {
    const mid = resolveDecisionSettings("club", DEFAULT_SLIDERS).profile;
    const high = resolveDecisionSettings(
      "club",
      withSlider("transition-complexity", 1),
    ).profile;
    expect(high.familyCosts["echo-out"]).toBeLessThan(
      mid.familyCosts["echo-out"],
    );
    expect(high.familyCosts["let-it-play"]).toBeGreaterThan(
      mid.familyCosts["let-it-play"],
    );
  });

  it("every slider at 0.5 under club equals club at defaults (identity)", () => {
    const baseline = resolveDecisionSettings("club", DEFAULT_SLIDERS);
    for (const id of SLIDER_IDS) {
      const resolved = resolveDecisionSettings("club", withSlider(id, 0.5));
      expect(resolved).toEqual(baseline);
    }
    expect(resolveDecisionSettings("club", { ...DEFAULT_SLIDERS })).toEqual(
      baseline,
    );
  });
});

describe("personality — extremes sanity", () => {
  it("keeps costs, blends and distant caps in bounds at 0 and at 1", () => {
    for (const id of PERSONALITY_IDS) {
      for (const sliders of [allSliders(0), allSliders(1)]) {
        const resolved = resolveDecisionSettings(id, sliders);
        for (const family of JOIN_FAMILIES) {
          const cost = resolved.profile.familyCosts[family];
          expect(cost, `${id} ${family}`).toBeGreaterThanOrEqual(0);
          expect(cost, `${id} ${family}`).toBeLessThanOrEqual(0.9);
        }
        expect(resolved.profile.standardBlendBeats).toBeGreaterThanOrEqual(4);
        expect(resolved.profile.longBlendBeats).toBeGreaterThanOrEqual(4);
        expect(resolved.profile.distantKeyMaxBlendBeats).toBeGreaterThanOrEqual(
          2,
        );
      }
      // Each slider individually at each extreme.
      for (const sliderId of SLIDER_IDS) {
        for (const value of [0, 1]) {
          const resolved = resolveDecisionSettings(
            id,
            withSlider(sliderId, value),
          );
          for (const family of JOIN_FAMILIES) {
            const cost = resolved.profile.familyCosts[family];
            expect(cost).toBeGreaterThanOrEqual(0);
            expect(cost).toBeLessThanOrEqual(0.9);
          }
        }
      }
    }
  });
});

describe("personality — purity", () => {
  it("resolving twice is equal by value and never mutates the anchors", () => {
    const sliders = withSlider("scratching", 1);
    const a = resolveDecisionSettings("battle", sliders);
    const b = resolveDecisionSettings("battle", sliders);
    expect(a).toEqual(b);
    expect(a.profile).not.toBe(b.profile);
    expect(a.profile.familyCosts).not.toBe(b.profile.familyCosts);
    expect(STANDARD_PROFILE.familyCosts.scratch).toBe(0.5);
    expect(ADVENTUROUS_PROFILE.familyCosts.scratch).toBe(0.35);
    expect(STANDARD_PROFILE.standardBlendBeats).toBe(16);
    // Resolving again after extremes still leaves anchors untouched.
    resolveDecisionSettings("house", allSliders(1));
    resolveDecisionSettings("radio", allSliders(0));
    expect(STANDARD_PROFILE.familyCosts.scratch).toBe(0.5);
    expect(STANDARD_PROFILE.familyCosts.fx).toBe(0.45);
  });
});
