// shaping.ts — personalities + sliders for the liveRave rebuild
// (Wave 1 foundation, design §3.4).
//
// Shaping tilts the brain's draw; it never gates it. Two inputs:
// - a personality: per-family affinity multipliers in a NARROW band
//   [0.6, 1.7] and a set of parameter-bend base values, following
//   PERSONALITY-TARGETS-2026-11-03.md (Club: longer blends, drops,
//   EQ, fx; Battle: scratch, cuts, stops; House: extended gradual
//   blends and groove, theatre down but present; Experimental:
//   unusual joins, fx chains, wide key/tempo tolerance; Radio:
//   smooth and consistent, theatre at the band floor but never zero;
//   Open Format: wide genre flexibility, balanced affinities).
// - eight sliders, each 0..1 with neutral 0.5 = no bend.
//
// Composition rules (all pinned by tests):
// - AUTONOMOUS + all sliders 0.5 is the IDENTITY: every affinity
//   exactly 1, every bend neutral — by construction (the personality
//   table gives autonomous 1s and neutral bases, and at 0.5 every
//   slider factor is exactly 1).
// - Slider affinity bends compose MULTIPLICATIVELY with personality
//   affinities. Each slider's per-family factor is
//     1 + SLIDER_AFFINITY_BEND (0.35) × weight × (2 × (slider − 0.5))
//   so at a slider extreme the most-targeted families bend by at
//   most ±0.35 (affinity-equivalent), and the factor is monotonic in
//   the slider for every family (increasing where weight > 0,
//   decreasing where weight < 0).
// - A FINAL global clamp [0.45, 2.2] is applied to every affinity
//   last, so no personality+slider combination can price a family
//   out of the draw (no affinity is ever 0 or infinite — §4 inv. 1).
// - Parameter bends derive from sliders monotonically: every bend is
//   base × Π (1 + k × (slider − 0.5)) with k > 0 for its driving
//   slider(s), clamped to [0.2, 3] (blendBeatsCentre clamps to
//   [4, 64] beats instead, being an absolute centre, not a ratio).
//
// Environment-pure: no DOM, no storage, no worker globals.

import type { JoinFamily } from "./recipe";

// ---------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------

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
  | "transitionComplexity"
  | "genreFlexibility"
  | "energyProgression"
  | "trackSelectionFreedom";

export const SLIDER_IDS: readonly SliderId[] = [
  "intensity",
  "creativity",
  "scratching",
  "effects",
  "transitionComplexity",
  "genreFlexibility",
  "energyProgression",
  "trackSelectionFreedom",
];

/** What an affinity can target: a join family, or fx dressings. */
export type AffinityTarget = JoinFamily | "fx";

export const AFFINITY_TARGETS: readonly AffinityTarget[] = [
  "blend",
  "loop-blend",
  "drop-cut",
  "filter-fade",
  "echo-out",
  "stop-exit",
  "scratch-in",
  "scratch-out",
  "fx",
];

// ---------------------------------------------------------------------
// Bands and clamps
// ---------------------------------------------------------------------

/** Personality affinities live inside this narrow band (design §3.4). */
export const PERSONALITY_AFFINITY_MIN = 0.6;
export const PERSONALITY_AFFINITY_MAX = 1.7;

/** Final global clamp applied to every resolved affinity, last. */
export const AFFINITY_GLOBAL_MIN = 0.45;
export const AFFINITY_GLOBAL_MAX = 2.2;

/** Max affinity-equivalent bend one slider applies at its extreme. */
export const SLIDER_AFFINITY_BEND = 0.35;

// ---------------------------------------------------------------------
// Shaping shape
// ---------------------------------------------------------------------

export interface ShapingBends {
  /** Centre of the blend-length distribution, in beats. */
  blendBeatsCentre: number;
  /** Multiplier on scratch-block density per join (1 = neutral). */
  scratchDensity: number;
  /** Multiplier on fx-dressing density per join (1 = neutral). */
  fxDensity: number;
  /** Multiplier on blocks-per-join centre (1 = neutral). */
  complexity: number;
  /** Multiplier on set energy-arc steepness (1 = neutral). */
  arcSteepness: number;
  /** Multiplier on key/tempo tolerance in track choice (1 = neutral). */
  keyTempoTolerance: number;
  /** Multiplier on next-track selection freedom (1 = neutral). */
  selectionFreedom: number;
}

export const NEUTRAL_BENDS: ShapingBends = {
  blendBeatsCentre: 16,
  scratchDensity: 1,
  fxDensity: 1,
  complexity: 1,
  arcSteepness: 1,
  keyTempoTolerance: 1,
  selectionFreedom: 1,
};

export interface Shaping {
  personalityId: PersonalityId;
  /** Resolved affinity per target, after clamp; all in [0.45, 2.2]. */
  affinities: Record<AffinityTarget, number>;
  bends: ShapingBends;
  /** The affinity for a family (or "fx"); the same value as the map. */
  affinity(target: AffinityTarget): number;
}

export const NEUTRAL_SLIDERS: Record<SliderId, number> = {
  intensity: 0.5,
  creativity: 0.5,
  scratching: 0.5,
  effects: 0.5,
  transitionComplexity: 0.5,
  genreFlexibility: 0.5,
  energyProgression: 0.5,
  trackSelectionFreedom: 0.5,
};

// ---------------------------------------------------------------------
// Personality definitions
// ---------------------------------------------------------------------

interface PersonalityDef {
  affinities: Record<AffinityTarget, number>;
  bends: {
    blendBeatsCentre: number;
    scratchDensity: number;
    fxDensity: number;
    complexity: number;
    arcSteepness: number;
    keyTempoTolerance: number;
    selectionFreedom: number;
  };
}

const PERSONALITIES: Record<PersonalityId, PersonalityDef> = {
  autonomous: {
    affinities: {
      blend: 1,
      "loop-blend": 1,
      "drop-cut": 1,
      "filter-fade": 1,
      "echo-out": 1,
      "stop-exit": 1,
      "scratch-in": 1,
      "scratch-out": 1,
      fx: 1,
    },
    bends: { ...NEUTRAL_BENDS },
  },
  club: {
    // Longer mixes, energetic transitions, drops, EQ and effects.
    affinities: {
      blend: 1.3,
      "loop-blend": 1.2,
      "drop-cut": 1.5,
      "filter-fade": 1.0,
      "echo-out": 1.2,
      "stop-exit": 0.9,
      "scratch-in": 1.1,
      "scratch-out": 1.1,
      fx: 1.5,
    },
    bends: {
      blendBeatsCentre: 24,
      scratchDensity: 1.1,
      fxDensity: 1.5,
      complexity: 1.2,
      arcSteepness: 1.3,
      keyTempoTolerance: 1.0,
      selectionFreedom: 1.1,
    },
  },
  battle: {
    // Scratching (all five techniques), cuts, stops, complex moves.
    affinities: {
      blend: 0.8,
      "loop-blend": 0.9,
      "drop-cut": 1.4,
      "filter-fade": 0.7,
      "echo-out": 0.9,
      "stop-exit": 1.6,
      "scratch-in": 1.7,
      "scratch-out": 1.7,
      fx: 1.1,
    },
    bends: {
      blendBeatsCentre: 8,
      scratchDensity: 1.8,
      fxDensity: 1.1,
      complexity: 1.5,
      arcSteepness: 1.2,
      keyTempoTolerance: 1.1,
      selectionFreedom: 1.1,
    },
  },
  house: {
    // Extended blends, gradual EQ, groove continuity; theatre down
    // (at the band floor) but present — never zero.
    affinities: {
      blend: 1.6,
      "loop-blend": 1.5,
      "drop-cut": 0.7,
      "filter-fade": 1.2,
      "echo-out": 1.0,
      "stop-exit": 0.6,
      "scratch-in": 0.6,
      "scratch-out": 0.6,
      fx: 1.0,
    },
    bends: {
      blendBeatsCentre: 32,
      scratchDensity: 0.7,
      fxDensity: 1.0,
      complexity: 0.9,
      arcSteepness: 0.9,
      keyTempoTolerance: 0.9,
      selectionFreedom: 0.9,
    },
  },
  "open-format": {
    // Wide genre flexibility, balanced affinities across the board.
    affinities: {
      blend: 1.1,
      "loop-blend": 1.0,
      "drop-cut": 1.2,
      "filter-fade": 1.1,
      "echo-out": 1.1,
      "stop-exit": 1.0,
      "scratch-in": 1.1,
      "scratch-out": 1.1,
      fx: 1.1,
    },
    bends: {
      blendBeatsCentre: 16,
      scratchDensity: 1.1,
      fxDensity: 1.1,
      complexity: 1.1,
      arcSteepness: 1.1,
      keyTempoTolerance: 1.6,
      selectionFreedom: 1.7,
    },
  },
  experimental: {
    // Unusual joins, creative fx chains, wide key/tempo tolerance.
    affinities: {
      blend: 0.9,
      "loop-blend": 1.3,
      "drop-cut": 1.2,
      "filter-fade": 1.4,
      "echo-out": 1.4,
      "stop-exit": 1.3,
      "scratch-in": 1.3,
      "scratch-out": 1.3,
      fx: 1.7,
    },
    bends: {
      blendBeatsCentre: 20,
      scratchDensity: 1.3,
      fxDensity: 1.8,
      complexity: 1.6,
      arcSteepness: 1.2,
      keyTempoTolerance: 1.7,
      selectionFreedom: 1.4,
    },
  },
  radio: {
    // Smooth, conservative, consistent; theatre affinities sit at
    // the band floor (0.6) — present and rare, never zero.
    affinities: {
      blend: 1.4,
      "loop-blend": 1.1,
      "drop-cut": 0.7,
      "filter-fade": 1.3,
      "echo-out": 1.1,
      "stop-exit": 0.6,
      "scratch-in": 0.6,
      "scratch-out": 0.6,
      fx: 0.6,
    },
    bends: {
      blendBeatsCentre: 12,
      scratchDensity: 0.6,
      fxDensity: 0.6,
      complexity: 0.7,
      arcSteepness: 0.8,
      keyTempoTolerance: 0.8,
      selectionFreedom: 0.7,
    },
  },
};

// ---------------------------------------------------------------------
// Slider -> affinity weights, in [-1, 1] per target (documented signs)
// ---------------------------------------------------------------------
//
// intensity: theatre and energy up (drops, stops, scratches, fx),
//   long smooth blends down a touch.
// creativity: constructed joins up (loops, filter/echo work, fx,
//   scratches), the plain blend down a touch.
// scratching: the scratch families, strongly; stops slightly; the
//   plain blend slightly down (time spent scratching is not blending).
// effects: fx dressings, echo-outs and filter work.
// transitionComplexity: layered joins up (loops, fx, scratches,
//   blends), instant joins (drop-cut, stop-exit) down.
// genreFlexibility / trackSelectionFreedom: no direct family weight —
//   they act through the bends (keyTempoTolerance / selectionFreedom).
// energyProgression: drop landings and energetic exits up.

const SLIDER_AFFINITY_WEIGHTS: Record<
  SliderId,
  Partial<Record<AffinityTarget, number>>
> = {
  intensity: {
    "drop-cut": 1,
    "stop-exit": 0.8,
    "scratch-in": 0.7,
    "scratch-out": 0.7,
    fx: 0.6,
    "echo-out": 0.2,
    blend: -0.3,
    "loop-blend": -0.2,
    "filter-fade": -0.3,
  },
  creativity: {
    "loop-blend": 0.9,
    fx: 0.9,
    "filter-fade": 0.8,
    "echo-out": 0.8,
    "scratch-in": 0.6,
    "scratch-out": 0.6,
    "drop-cut": 0.4,
    "stop-exit": 0.3,
    blend: -0.2,
  },
  scratching: {
    "scratch-in": 1,
    "scratch-out": 1,
    "stop-exit": 0.3,
    blend: -0.2,
  },
  effects: {
    fx: 1,
    "echo-out": 0.7,
    "filter-fade": 0.6,
  },
  transitionComplexity: {
    "loop-blend": 0.8,
    fx: 0.5,
    "scratch-in": 0.4,
    "scratch-out": 0.4,
    blend: 0.3,
    "filter-fade": 0.3,
    "echo-out": 0.4,
    "drop-cut": -0.3,
    "stop-exit": -0.2,
  },
  genreFlexibility: {},
  energyProgression: {
    "drop-cut": 0.6,
    "stop-exit": 0.3,
    blend: 0.2,
  },
  trackSelectionFreedom: {},
};

// ---------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cleanSlider(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(value, 0, 1)
    : 0.5;
}

/** One slider's multiplicative factor for one target (see header). */
function sliderFactor(slider: number, weight: number): number {
  return 1 + SLIDER_AFFINITY_BEND * weight * (2 * (slider - 0.5));
}

/** A bend's slider factor: monotonic in its driving slider. */
function bendFactor(slider: number, k: number): number {
  return 1 + k * (slider - 0.5);
}

function shapingAffinity(this: Shaping, target: AffinityTarget): number {
  return this.affinities[target] ?? 1;
}

function makeShaping(
  personalityId: PersonalityId,
  affinities: Record<AffinityTarget, number>,
  bends: ShapingBends,
): Shaping {
  return { personalityId, affinities, bends, affinity: shapingAffinity };
}

/**
 * Resolves a personality + slider set into a Shaping. Pure and
 * total: out-of-range or non-finite slider values are clamped /
 * treated as neutral, and an unknown personality id resolves as
 * autonomous.
 */
export function resolveShaping(
  personalityId: PersonalityId,
  sliders: Record<SliderId, number>,
): Shaping {
  const def = PERSONALITIES[personalityId] ?? PERSONALITIES.autonomous;
  const id: PersonalityId = PERSONALITIES[personalityId]
    ? personalityId
    : "autonomous";
  const s: Record<SliderId, number> = {
    intensity: cleanSlider(sliders?.intensity),
    creativity: cleanSlider(sliders?.creativity),
    scratching: cleanSlider(sliders?.scratching),
    effects: cleanSlider(sliders?.effects),
    transitionComplexity: cleanSlider(sliders?.transitionComplexity),
    genreFlexibility: cleanSlider(sliders?.genreFlexibility),
    energyProgression: cleanSlider(sliders?.energyProgression),
    trackSelectionFreedom: cleanSlider(sliders?.trackSelectionFreedom),
  };

  const affinities = {} as Record<AffinityTarget, number>;
  for (const target of AFFINITY_TARGETS) {
    let value = def.affinities[target];
    for (const sliderId of SLIDER_IDS) {
      const weight = SLIDER_AFFINITY_WEIGHTS[sliderId][target] ?? 0;
      if (weight !== 0) value *= sliderFactor(s[sliderId], weight);
    }
    // The global clamp is applied LAST, after every composition.
    affinities[target] = clamp(value, AFFINITY_GLOBAL_MIN, AFFINITY_GLOBAL_MAX);
  }

  const base = def.bends;
  const bends: ShapingBends = {
    blendBeatsCentre: clamp(
      base.blendBeatsCentre *
        bendFactor(s.transitionComplexity, 0.5) *
        bendFactor(s.intensity, 0.3),
      4,
      64,
    ),
    scratchDensity: clamp(
      base.scratchDensity *
        bendFactor(s.scratching, 0.8) *
        bendFactor(s.intensity, 0.3),
      0.2,
      3,
    ),
    fxDensity: clamp(
      base.fxDensity *
        bendFactor(s.effects, 0.8) *
        bendFactor(s.creativity, 0.3),
      0.2,
      3,
    ),
    complexity: clamp(
      base.complexity *
        bendFactor(s.transitionComplexity, 0.8) *
        bendFactor(s.creativity, 0.4),
      0.2,
      3,
    ),
    arcSteepness: clamp(
      base.arcSteepness * bendFactor(s.energyProgression, 0.8),
      0.2,
      3,
    ),
    keyTempoTolerance: clamp(
      base.keyTempoTolerance * bendFactor(s.genreFlexibility, 0.8),
      0.2,
      3,
    ),
    selectionFreedom: clamp(
      base.selectionFreedom * bendFactor(s.trackSelectionFreedom, 0.8),
      0.2,
      3,
    ),
  };

  return makeShaping(id, affinities, bends);
}

/**
 * A personality's raw affinity table — its weight table as a
 * Hands module (wave item 6). resolveShaping composes this table
 * with the slider bends; the Hands layer reads the table directly
 * so the personality module owns its weights by name.
 */
export function personalityAffinityTable(
  personalityId: PersonalityId,
): Record<AffinityTarget, number> {
  const def = PERSONALITIES[personalityId] ?? PERSONALITIES.autonomous;
  return { ...def.affinities };
}

/** The identity shaping: autonomous personality, all sliders neutral. */
export const NEUTRAL_SHAPING: Shaping = resolveShaping(
  "autonomous",
  NEUTRAL_SLIDERS,
);
