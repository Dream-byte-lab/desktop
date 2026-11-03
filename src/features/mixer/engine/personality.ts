// Personalities and sliders (revamp slice R4): the DJ brain's
// decision preferences, named and bent by the listener.
//
// A personality is decision preferences only — never visuals. It
// says how a DJ judges: how long blends run, what a theatrical
// family must earn its way past, which evidence the scorer trusts,
// how wide the near-equal band sits, how hard repetition is priced.
// It never says what the interface looks like, and it never names
// a track, an artist, or a basic genre: like the profiles in
// decisionProfile.ts, it encodes how a DJ judges, not what a DJ
// plays.
//
// The resolver below is the single pure function from
// (personality, sliders) to everything the engine spends: a
// resolved DecisionProfile, the curation bends assembleSet spends,
// and an arc-shape lean. Nothing else in the engine reads a
// personality or a slider directly — they all spend what the
// resolver resolved.
//
// Autonomous at neutral sliders IS the pre-R4 engine, by identity:
// the resolver returns STANDARD_PROFILE itself, not a copy of it,
// so every code path that ran before R4 runs byte-for-byte the
// same judgement until the listener actually chooses otherwise.
// Every slider bend is the identity at its neutral point (0.5),
// so a non-autonomous personality at default sliders is exactly
// its anchor plus its stated overrides — no hidden drift.

import type { ArcShapeName } from "./curatedSet";
import {
  ADVENTUROUS_PROFILE,
  CONSERVATIVE_PROFILE,
  DECISION_PROFILE_VERSION,
  STANDARD_PROFILE,
  type DecisionProfile,
  type JoinFamily,
} from "./decisionProfile";

export type PersonalityId =
  | "autonomous"
  | "club"
  | "battle"
  | "house"
  | "open-format"
  | "experimental"
  | "radio";

export const PERSONALITY_IDS: readonly PersonalityId[] = [
  "autonomous",
  "club",
  "battle",
  "house",
  "open-format",
  "experimental",
  "radio",
];

export type SliderId =
  | "intensity"
  | "creativity"
  | "scratching"
  | "effects"
  | "transition-complexity"
  | "genre-flexibility"
  | "energy-progression"
  | "track-selection-freedom";

export const SLIDER_IDS: readonly SliderId[] = [
  "intensity",
  "creativity",
  "scratching",
  "effects",
  "transition-complexity",
  "genre-flexibility",
  "energy-progression",
  "track-selection-freedom",
];

export type SliderSettings = Record<SliderId, number>;

/** Every slider at its neutral point: every bend is identity here. */
export const DEFAULT_SLIDERS: SliderSettings = {
  intensity: 0.5,
  creativity: 0.5,
  scratching: 0.5,
  effects: 0.5,
  "transition-complexity": 0.5,
  "genre-flexibility": 0.5,
  "energy-progression": 0.5,
  "track-selection-freedom": 0.5,
};

/**
 * The curation bends: the judgement assembleSet spends when it
 * orders a set, resolved alongside the profile so curation and
 * joining share one temperament. The defaults are exactly the
 * constants assembleSet ships with today.
 */
export interface CurationBends {
  /** Score distance within which candidates count as near-equals. */
  nearEqualEpsilon: number;
  /** Credit for continuing the owner's shared Playlist Genre label. */
  sharedLabelCredit: number;
  /** Penalty the pure-score leader's rivals must overcome. */
  incumbencyPenalty: number;
}

export const DEFAULT_CURATION_BENDS: CurationBends = {
  nearEqualEpsilon: 0.05,
  sharedLabelCredit: 0.6,
  incumbencyPenalty: 0.1,
};

export interface ResolvedDecisionSettings {
  profile: DecisionProfile;
  curation: CurationBends;
  arcShapeLean: ArcShapeName | null;
}

type WeightKey = keyof DecisionProfile["weights"];

/**
 * Scalar author-bound fields a personality may override. Nested
 * judgements (familyCosts, weights, antiRepetition) have their own
 * override channels on the spec, so they are not repeated here.
 */
type FieldOverrides = Partial<
  Pick<
    DecisionProfile,
    | "maxBeatmatchStretch"
    | "maxStretchUp"
    | "maxStretchDown"
    | "minTempoConfidence"
    | "minGridConfidence"
    | "vocalClashIntegral"
    | "vocalTrustConfidence"
    | "distantKeyMaxBlendBeats"
    | "minDropCutStrength"
    | "minLeadBeats"
    | "standardBlendBeats"
    | "longBlendBeats"
    | "minBlendBeats"
    | "minRateReturnBeats"
    | "maxRateReturnBeats"
    | "defaultRateReturnBeats"
  >
>;

export interface PersonalitySpec {
  id: PersonalityId;
  label: string;
  /** The shipped profile this temperament starts from; null = identity. */
  anchor: DecisionProfile | null;
  fieldOverrides: FieldOverrides;
  costOverrides: Partial<Record<JoinFamily, number>>;
  weightMultipliers: Partial<Record<WeightKey, number>>;
  nearEqualBandOverride?: number;
  antiRepetitionScale?: number;
  curationOverrides?: Partial<CurationBends>;
  arcShapeLean: ArcShapeName | null;
}

export const PERSONALITIES: Record<PersonalityId, PersonalitySpec> = {
  autonomous: {
    id: "autonomous",
    label: "Autonomous",
    anchor: null,
    fieldOverrides: {},
    costOverrides: {},
    weightMultipliers: {},
    arcShapeLean: null,
  },
  club: {
    id: "club",
    label: "Club",
    anchor: STANDARD_PROFILE,
    fieldOverrides: {
      standardBlendBeats: 20,
      longBlendBeats: 32,
      minDropCutStrength: 1.2,
    },
    costOverrides: {
      fx: 0.3,
      "drop-cut": 0.02,
      "echo-out": 0.04,
      "let-it-play": 0.05,
    },
    weightMultipliers: {
      arcFit: 1.3,
      structureFit: 1.1,
    },
    arcShapeLean: null,
  },
  battle: {
    id: "battle",
    label: "Battle",
    anchor: ADVENTUROUS_PROFILE,
    fieldOverrides: {
      standardBlendBeats: 12,
      minLeadBeats: 6,
    },
    costOverrides: {
      scratch: 0.18,
      spinback: 0.2,
      "vinyl-stop": 0.2,
      "drop-cut": 0.01,
      "early-cut": 0.01,
      "short-blend": 0.01,
      "long-blend": 0.03,
      "let-it-play": 0.1,
    },
    weightMultipliers: {
      structureFit: 1.15,
      loopValue: 1.2,
    },
    arcShapeLean: null,
  },
  house: {
    id: "house",
    label: "House",
    anchor: STANDARD_PROFILE,
    fieldOverrides: {
      standardBlendBeats: 24,
      longBlendBeats: 32,
      minBlendBeats: 8,
      vocalClashIntegral: 0.35,
    },
    costOverrides: {
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
    weightMultipliers: {
      arcFit: 1.25,
      structureFit: 1.15,
      loopValue: 1.2,
    },
    arcShapeLean: "slow-burn",
  },
  "open-format": {
    id: "open-format",
    label: "Open Format",
    anchor: STANDARD_PROFILE,
    fieldOverrides: {
      distantKeyMaxBlendBeats: 12,
      maxStretchUp: 0.13,
      maxStretchDown: 0.07,
    },
    costOverrides: {
      "section-swap": 0.02,
      "drop-cut": 0.03,
    },
    weightMultipliers: {
      keyFit: 0.7,
      arcFit: 1.15,
      structureFit: 1.1,
    },
    nearEqualBandOverride: 0.07,
    curationOverrides: {
      sharedLabelCredit: 0.25,
    },
    arcShapeLean: null,
  },
  experimental: {
    id: "experimental",
    label: "Experimental",
    anchor: ADVENTUROUS_PROFILE,
    fieldOverrides: {},
    costOverrides: {
      fx: 0.18,
      scratch: 0.25,
      "loop-extended-blend": 0,
      "section-swap": 0.01,
      "filter-fade": 0.02,
      spinback: 0.22,
      "vinyl-stop": 0.22,
      "let-it-play": 0.12,
    },
    weightMultipliers: {
      loopValue: 1.3,
      structureFit: 1.2,
      keyFit: 0.8,
    },
    nearEqualBandOverride: 0.11,
    antiRepetitionScale: 1.25,
    arcShapeLean: null,
  },
  radio: {
    id: "radio",
    label: "Radio",
    anchor: CONSERVATIVE_PROFILE,
    fieldOverrides: {
      standardBlendBeats: 14,
      minDropCutStrength: 2.2,
    },
    costOverrides: {
      "let-it-play": 0,
      "drop-cut": 0.12,
      "early-cut": 0.08,
    },
    weightMultipliers: {
      vocalClarity: 1.15,
      arcFit: 1.1,
    },
    arcShapeLean: null,
  },
};

/** True when every slider sits exactly at its neutral point (0.5). */
export function isNeutralSliders(sliders: SliderSettings): boolean {
  return SLIDER_IDS.every((id) => sliders[id] === 0.5);
}

/** Value equality over the eight sliders. */
export function sliderSettingsEqual(
  a: SliderSettings,
  b: SliderSettings,
): boolean {
  return SLIDER_IDS.every((id) => a[id] === b[id]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampCost(value: number): number {
  return clamp(value, 0, 0.9);
}

const COMPLEX_FAMILIES: readonly JoinFamily[] = [
  "loop-extended-blend",
  "section-swap",
  "filter-fade",
  "echo-out",
];

const SIMPLE_FAMILIES: readonly JoinFamily[] = ["let-it-play", "early-cut"];

/**
 * Resolves a personality and its slider settings into everything
 * the engine spends. Pure: the anchors and the inputs are never
 * mutated, and the same inputs always resolve to equal-by-value
 * settings.
 */
export function resolveDecisionSettings(
  personalityId: PersonalityId,
  sliders: SliderSettings,
): ResolvedDecisionSettings {
  // Fast path, a hard parity requirement: autonomous at neutral
  // sliders returns the shipped standard profile BY IDENTITY.
  if (personalityId === "autonomous" && isNeutralSliders(sliders)) {
    return {
      profile: STANDARD_PROFILE,
      curation: { ...DEFAULT_CURATION_BENDS },
      arcShapeLean: null,
    };
  }

  const spec = PERSONALITIES[personalityId];
  const anchor = spec.anchor ?? STANDARD_PROFILE;

  const profile: DecisionProfile = {
    ...anchor,
    id: personalityId === "autonomous" ? "standard" : personalityId,
    label: personalityId === "autonomous" ? "Standard" : spec.label,
    version: DECISION_PROFILE_VERSION,
    familyCosts: { ...anchor.familyCosts },
    weights: { ...anchor.weights },
    antiRepetition: { ...anchor.antiRepetition },
  };

  // Personality field overrides, then the near-equal band override.
  Object.assign(profile, spec.fieldOverrides);
  if (spec.nearEqualBandOverride !== undefined) {
    profile.nearEqualBand = spec.nearEqualBandOverride;
  }

  // Personality cost overrides: the resolved record still carries
  // every JoinFamily, because it started as a spread of the anchor's.
  for (const [family, cost] of Object.entries(spec.costOverrides)) {
    profile.familyCosts[family as JoinFamily] = cost as number;
  }

  const dIntensity = sliders.intensity - 0.5;
  const dCreativity = sliders.creativity - 0.5;
  const dScratching = sliders.scratching - 0.5;
  const dEffects = sliders.effects - 0.5;
  const dComplexity = sliders["transition-complexity"] - 0.5;
  const dGenre = sliders["genre-flexibility"] - 0.5;
  const dEnergy = sliders["energy-progression"] - 0.5;
  const dFreedom = sliders["track-selection-freedom"] - 0.5;

  // 1. Intensity: longer blends.
  profile.standardBlendBeats = Math.max(
    4,
    Math.round(profile.standardBlendBeats * (1 + 0.6 * dIntensity)),
  );
  profile.longBlendBeats = Math.max(
    4,
    Math.round(profile.longBlendBeats * (1 + 0.6 * dIntensity)),
  );

  // 2. Creativity: a wider near-equal band (its anti-repetition
  // bend is applied with the anti-repetition block below).
  profile.nearEqualBand = profile.nearEqualBand * (1 + 1.2 * dCreativity);

  // 3. Scratching: the theatre families get cheaper or dearer.
  profile.familyCosts.scratch = clampCost(
    profile.familyCosts.scratch - 0.3 * dScratching,
  );
  profile.familyCosts.spinback = clampCost(
    profile.familyCosts.spinback - 0.2 * dScratching,
  );
  profile.familyCosts["vinyl-stop"] = clampCost(
    profile.familyCosts["vinyl-stop"] - 0.2 * dScratching,
  );

  // 4. Effects.
  profile.familyCosts.fx = clampCost(profile.familyCosts.fx - 0.3 * dEffects);

  // 5. Transition complexity: complex families against simple ones.
  for (const family of COMPLEX_FAMILIES) {
    profile.familyCosts[family] = clampCost(
      profile.familyCosts[family] - 0.1 * dComplexity,
    );
  }
  for (const family of SIMPLE_FAMILIES) {
    profile.familyCosts[family] = clampCost(
      profile.familyCosts[family] + 0.1 * dComplexity,
    );
  }

  // 6. Genre flexibility: distant keys may blend a little longer.
  profile.distantKeyMaxBlendBeats = Math.max(
    2,
    profile.distantKeyMaxBlendBeats + Math.round(8 * dGenre),
  );

  // Weights: personality multipliers, bent by the sliders that
  // speak to a weight (intensity and energy-progression bend
  // arcFit, genre-flexibility bends keyFit), then normalised so
  // the six weights sum to 1, as every shipped profile promises.
  const weightMultipliers: Record<WeightKey, number> = {
    keyFit: (spec.weightMultipliers.keyFit ?? 1) * (1 - 0.6 * dGenre),
    vocalClarity: spec.weightMultipliers.vocalClarity ?? 1,
    stretchFit: spec.weightMultipliers.stretchFit ?? 1,
    structureFit: spec.weightMultipliers.structureFit ?? 1,
    loopValue: spec.weightMultipliers.loopValue ?? 1,
    arcFit:
      (spec.weightMultipliers.arcFit ?? 1) *
      (1 + 0.5 * dIntensity) *
      (1 + 0.8 * dEnergy),
  };
  const rawWeights: Record<WeightKey, number> = {
    keyFit: anchor.weights.keyFit * weightMultipliers.keyFit,
    vocalClarity: anchor.weights.vocalClarity * weightMultipliers.vocalClarity,
    stretchFit: anchor.weights.stretchFit * weightMultipliers.stretchFit,
    structureFit: anchor.weights.structureFit * weightMultipliers.structureFit,
    loopValue: anchor.weights.loopValue * weightMultipliers.loopValue,
    arcFit: anchor.weights.arcFit * weightMultipliers.arcFit,
  };
  const weightTotal =
    rawWeights.keyFit +
    rawWeights.vocalClarity +
    rawWeights.stretchFit +
    rawWeights.structureFit +
    rawWeights.loopValue +
    rawWeights.arcFit;
  profile.weights = {
    keyFit: rawWeights.keyFit / weightTotal,
    vocalClarity: rawWeights.vocalClarity / weightTotal,
    stretchFit: rawWeights.stretchFit / weightTotal,
    structureFit: rawWeights.structureFit / weightTotal,
    loopValue: rawWeights.loopValue / weightTotal,
    arcFit: rawWeights.arcFit / weightTotal,
  };

  // Anti-repetition: the personality's scale and the creativity
  // bend multiply the COST fields only; the window is untouched.
  const antiRepetitionFactor =
    (spec.antiRepetitionScale ?? 1) * (1 + 0.8 * dCreativity);
  profile.antiRepetition = {
    windowJoins: anchor.antiRepetition.windowJoins,
    familyRepeatCost: Math.max(
      0,
      anchor.antiRepetition.familyRepeatCost * antiRepetitionFactor,
    ),
    familyRepeatCostOtherShape: Math.max(
      0,
      anchor.antiRepetition.familyRepeatCostOtherShape * antiRepetitionFactor,
    ),
    geometryRepeatCost: Math.max(
      0,
      anchor.antiRepetition.geometryRepeatCost * antiRepetitionFactor,
    ),
    samePairCost: Math.max(
      0,
      anchor.antiRepetition.samePairCost * antiRepetitionFactor,
    ),
    heardLengthRepeatCost: Math.max(
      0,
      anchor.antiRepetition.heardLengthRepeatCost * antiRepetitionFactor,
    ),
    maxCost: clamp(
      anchor.antiRepetition.maxCost * antiRepetitionFactor,
      0,
      0.9,
    ),
  };

  // Curation: the personality's overrides are the base the
  // genre-flexibility and track-selection-freedom bends move from.
  const sharedBase =
    spec.curationOverrides?.sharedLabelCredit ??
    DEFAULT_CURATION_BENDS.sharedLabelCredit;
  const epsilonBase =
    spec.curationOverrides?.nearEqualEpsilon ??
    DEFAULT_CURATION_BENDS.nearEqualEpsilon;
  const incumbencyBase =
    spec.curationOverrides?.incumbencyPenalty ??
    DEFAULT_CURATION_BENDS.incumbencyPenalty;
  const curation: CurationBends = {
    nearEqualEpsilon: epsilonBase * (1 + 1.6 * dFreedom),
    sharedLabelCredit: clamp(sharedBase - 0.7 * dGenre, 0, 1.2),
    incumbencyPenalty: clamp(incumbencyBase * (1 - 1.2 * dFreedom), 0, 0.2),
  };

  return { profile, curation, arcShapeLean: spec.arcShapeLean };
}
