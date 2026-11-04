import { describe, expect, it } from "vitest";
import {
  ADVENTUROUS_PROFILE,
  CONSERVATIVE_PROFILE,
  DECISION_PROFILE_VERSION,
  JOIN_FAMILIES,
  STANDARD_PROFILE,
  resolveProfile,
  stretchCeilingFor,
  withinStretchCeilings,
  type DecisionProfile,
} from "./decisionProfile";

// The decision profile is where the brain's judgement lives as data.
// These tests pin the two promises the slice makes about it: the
// standard profile IS the S5-2 author's shipped judgement (moved, not
// changed), and the three temperaments differ in the directions
// their names claim.

describe("decisionProfile — the standard profile is the shipped judgement", () => {
  it("carries the retired AUTHOR_BOUNDS values field for field", () => {
    // The S5-2 author's bounds, as shipped in transitionPlanner.ts.
    // If a future curriculum changes a value, it changes it HERE,
    // deliberately, and this test is the receipt.
    expect(STANDARD_PROFILE.maxBeatmatchStretch).toBe(0.06);
    // 0.12 since Note 27 (C2): recalibrated to the analyser's
    // centred-autocorrelation confidence scale (analysis v3),
    // where a real recording measures 0.17 and white noise 0.00.
    // The 0.2 this replaces was set on the old uncentred scale.
    expect(STANDARD_PROFILE.minTempoConfidence).toBe(0.12);
    expect(STANDARD_PROFILE.minGridConfidence).toBe(0.15);
    expect(STANDARD_PROFILE.vocalClashIntegral).toBe(0.4);
    expect(STANDARD_PROFILE.vocalTrustConfidence).toBe(0.35);
    expect(STANDARD_PROFILE.distantKeyMaxBlendBeats).toBe(8);
    expect(STANDARD_PROFILE.minDropCutStrength).toBe(1.5);
    expect(STANDARD_PROFILE.minLeadBeats).toBe(8);
    expect(STANDARD_PROFILE.standardBlendBeats).toBe(16);
    expect(STANDARD_PROFILE.longBlendBeats).toBe(24);
    expect(STANDARD_PROFILE.minBlendBeats).toBe(4);
    expect(STANDARD_PROFILE.minRateReturnBeats).toBe(4);
    expect(STANDARD_PROFILE.maxRateReturnBeats).toBe(32);
    expect(STANDARD_PROFILE.defaultRateReturnBeats).toBe(8);
  });

  it("resolveProfile defaults a missing profile to the standard one", () => {
    expect(resolveProfile(undefined)).toBe(STANDARD_PROFILE);
    expect(resolveProfile(null)).toBe(STANDARD_PROFILE);
    expect(resolveProfile(CONSERVATIVE_PROFILE)).toBe(CONSERVATIVE_PROFILE);
  });
});

describe("decisionProfile — every profile is complete and coherent", () => {
  const profiles: DecisionProfile[] = [
    STANDARD_PROFILE,
    CONSERVATIVE_PROFILE,
    ADVENTUROUS_PROFILE,
  ];

  it("each profile prices every join family", () => {
    for (const profile of profiles) {
      for (const family of JOIN_FAMILIES) {
        expect(
          typeof profile.familyCosts[family],
          `${profile.id} is missing a cost for ${family}`,
        ).toBe("number");
      }
    }
  });

  it("each profile's scoring weights sum to 1", () => {
    for (const profile of profiles) {
      const w = profile.weights;
      const sum =
        w.keyFit +
        w.vocalClarity +
        w.stretchFit +
        w.structureFit +
        w.loopValue +
        w.arcFit;
      expect(sum, `${profile.id} weights`).toBeCloseTo(1, 9);
    }
  });

  it("each profile is stamped with the current profile version", () => {
    for (const profile of profiles) {
      expect(profile.version).toBe(DECISION_PROFILE_VERSION);
    }
  });

  it("spinback and vinyl-stop are priced as habits everywhere", () => {
    for (const profile of profiles) {
      expect(profile.familyCosts.spinback).toBeGreaterThanOrEqual(0.3);
      expect(profile.familyCosts["vinyl-stop"]).toBeGreaterThanOrEqual(0.3);
    }
  });
});

describe("decisionProfile — the rendition ceilings are the evidence-set caps", () => {
  it("carries the caps the S5-5 meters set, per profile, as landed", () => {
    expect(CONSERVATIVE_PROFILE.maxStretchUp).toBe(0.08);
    expect(CONSERVATIVE_PROFILE.maxStretchDown).toBe(0.06);
    expect(STANDARD_PROFILE.maxStretchUp).toBe(0.12);
    expect(STANDARD_PROFILE.maxStretchDown).toBe(0.06);
    expect(ADVENTUROUS_PROFILE.maxStretchUp).toBe(0.15);
    expect(ADVENTUROUS_PROFILE.maxStretchDown).toBe(0.09);
  });

  it("stretchCeilingFor reads the rate's direction", () => {
    expect(stretchCeilingFor(STANDARD_PROFILE, 1.1)).toBe(0.12);
    expect(stretchCeilingFor(STANDARD_PROFILE, 0.95)).toBe(0.06);
    expect(stretchCeilingFor(ADVENTUROUS_PROFILE, 0.92)).toBe(0.09);
    expect(stretchCeilingFor(CONSERVATIVE_PROFILE, 1.05)).toBe(0.08);
  });

  it("withinStretchCeilings honours each direction's ceiling, boundary included", () => {
    expect(withinStretchCeilings(STANDARD_PROFILE, 1.12)).toBe(true);
    expect(withinStretchCeilings(STANDARD_PROFILE, 1.13)).toBe(false);
    expect(withinStretchCeilings(STANDARD_PROFILE, 0.94)).toBe(true);
    expect(withinStretchCeilings(STANDARD_PROFILE, 0.93)).toBe(false);
    expect(withinStretchCeilings(CONSERVATIVE_PROFILE, 1.08)).toBe(true);
    expect(withinStretchCeilings(CONSERVATIVE_PROFILE, 1.09)).toBe(false);
    expect(withinStretchCeilings(ADVENTUROUS_PROFILE, 1.15)).toBe(true);
    expect(withinStretchCeilings(ADVENTUROUS_PROFILE, 0.91)).toBe(true);
    expect(withinStretchCeilings(ADVENTUROUS_PROFILE, 0.9)).toBe(false);
  });
});

describe("decisionProfile — the temperaments differ as named", () => {
  it("trust gates tighten conservative → standard → adventurous loosens", () => {
    expect(CONSERVATIVE_PROFILE.maxBeatmatchStretch).toBeLessThan(
      STANDARD_PROFILE.maxBeatmatchStretch,
    );
    expect(ADVENTUROUS_PROFILE.maxBeatmatchStretch).toBeGreaterThan(
      STANDARD_PROFILE.maxBeatmatchStretch,
    );
    expect(CONSERVATIVE_PROFILE.minTempoConfidence).toBeGreaterThan(
      STANDARD_PROFILE.minTempoConfidence,
    );
    expect(CONSERVATIVE_PROFILE.vocalClashIntegral).toBeLessThan(
      STANDARD_PROFILE.vocalClashIntegral,
    );
    expect(CONSERVATIVE_PROFILE.minDropCutStrength).toBeGreaterThan(
      STANDARD_PROFILE.minDropCutStrength,
    );
  });

  it("even the adventurous stretch cap stays inside the §3.7 policy floor", () => {
    // A few percent, until the time-stretch spike rules otherwise:
    // no shipped temperament may author a daycore-class stretch.
    for (const profile of [
      STANDARD_PROFILE,
      CONSERVATIVE_PROFILE,
      ADVENTUROUS_PROFILE,
    ]) {
      expect(profile.maxBeatmatchStretch).toBeLessThanOrEqual(0.1);
    }
  });

  it("the adventurous band is widest and its repetition costs are hardest", () => {
    expect(ADVENTUROUS_PROFILE.nearEqualBand).toBeGreaterThan(
      STANDARD_PROFILE.nearEqualBand,
    );
    expect(STANDARD_PROFILE.nearEqualBand).toBeGreaterThan(
      CONSERVATIVE_PROFILE.nearEqualBand,
    );
    expect(ADVENTUROUS_PROFILE.antiRepetition.familyRepeatCost).toBeGreaterThan(
      STANDARD_PROFILE.antiRepetition.familyRepeatCost,
    );
    expect(STANDARD_PROFILE.antiRepetition.familyRepeatCost).toBeGreaterThan(
      CONSERVATIVE_PROFILE.antiRepetition.familyRepeatCost,
    );
  });

  it("rendition ceilings widen conservative → standard → adventurous, up side first", () => {
    expect(CONSERVATIVE_PROFILE.maxStretchUp).toBeLessThan(
      STANDARD_PROFILE.maxStretchUp,
    );
    expect(ADVENTUROUS_PROFILE.maxStretchUp).toBeGreaterThan(
      STANDARD_PROFILE.maxStretchUp,
    );
    expect(CONSERVATIVE_PROFILE.maxStretchDown).toBeLessThanOrEqual(
      STANDARD_PROFILE.maxStretchDown,
    );
    expect(ADVENTUROUS_PROFILE.maxStretchDown).toBeGreaterThan(
      STANDARD_PROFILE.maxStretchDown,
    );
    // The meters' asymmetry, in every temperament: slowing down
    // degrades first, so the down ceiling never exceeds the up one,
    // and every ceiling reaches past its own rate cap (a ceiling at
    // or below the cap would be dead data).
    for (const profile of [
      STANDARD_PROFILE,
      CONSERVATIVE_PROFILE,
      ADVENTUROUS_PROFILE,
    ]) {
      expect(profile.maxStretchDown).toBeLessThanOrEqual(profile.maxStretchUp);
      expect(profile.maxStretchUp).toBeGreaterThan(profile.maxBeatmatchStretch);
      expect(profile.maxStretchDown).toBeGreaterThanOrEqual(
        profile.maxBeatmatchStretch,
      );
    }
  });

  it("conservative prices restraint lowest and theatre highest", () => {
    expect(CONSERVATIVE_PROFILE.familyCosts["let-it-play"]).toBeLessThan(
      ADVENTUROUS_PROFILE.familyCosts["let-it-play"],
    );
    expect(CONSERVATIVE_PROFILE.familyCosts["echo-out"]).toBeGreaterThan(
      STANDARD_PROFILE.familyCosts["echo-out"],
    );
    expect(CONSERVATIVE_PROFILE.standardBlendBeats).toBeLessThan(
      STANDARD_PROFILE.standardBlendBeats,
    );
    expect(ADVENTUROUS_PROFILE.longBlendBeats).toBeGreaterThan(
      STANDARD_PROFILE.longBlendBeats,
    );
  });
});
