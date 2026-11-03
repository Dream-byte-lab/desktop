// The decision profile (Step 5, slice S5-3): every judgement
// parameter the author and the scorer spend, in ONE versioned object
// — the blueprint's §3.6 socket.
//
// Until this slice, the author's bounds lived as a single exported
// constant (AUTHOR_BOUNDS) inside transitionPlanner.ts: one fixed
// judgement for every pair, forever. A profile makes the judgement
// explicit and variable: the same pair can be authored under a
// conservative, a standard, or an adventurous profile and produce
// honestly different recipes, and the scorer can weigh the candidates
// under the session's own profile. When the user's DJ reference sets
// are studied (the video curriculum), what changes is THIS file's
// values — with the reasoning recorded next to them — never code
// shape, and never a rule naming a specific track, artist, or genre:
// profiles encode how a DJ judges, not what a DJ plays.
//
// Three profiles ship. STANDARD carries exactly the bounds the S5-2
// author shipped with (the move changed their home, not their
// values — decisionProfile.test.ts pins the numbers). CONSERVATIVE
// tightens every trust gate and prefers the plain, safe join.
// ADVENTUROUS widens the near-equal band, pays more for structure and
// loops, penalises repetition harder, and dislikes doing nothing —
// but its stretch cap stays inside the §3.7 policy floor (a few
// percent, until the time-stretch spike rules otherwise): adventurous
// is a temperament, not a licence to daycore.

export const DECISION_PROFILE_VERSION = 1;

/**
 * The join families — the blueprint §3.3 vocabulary. Two of them are
 * "do less" (let-it-play, early-cut): a varied decider must be able
 * to choose restraint, not only technique. spinback / vinyl-stop are
 * in the vocabulary (and priced) but are NOT enumerated as candidates
 * yet: the S5-2 executor does not perform them, and a candidate the
 * decks cannot perform would be a lie in the set.
 */
export type JoinFamily =
  | "long-blend"
  | "standard-blend"
  | "short-blend"
  | "loop-extended-blend"
  | "drop-cut"
  | "section-swap"
  | "echo-out"
  | "filter-fade"
  | "spinback"
  | "vinyl-stop"
  | "let-it-play"
  | "early-cut";

export const JOIN_FAMILIES: readonly JoinFamily[] = [
  "long-blend",
  "standard-blend",
  "short-blend",
  "loop-extended-blend",
  "drop-cut",
  "section-swap",
  "echo-out",
  "filter-fade",
  "spinback",
  "vinyl-stop",
  "let-it-play",
  "early-cut",
];

export interface DecisionProfile {
  /** Stable identifier recorded on candidates and in the join log. */
  id: string;
  /** Human label for logs and (later) surfaces. */
  label: string;
  /** DECISION_PROFILE_VERSION this object was written against. */
  version: number;

  // ---- author bounds (the retired AUTHOR_BOUNDS, field for field) ----

  /** Largest |rate − 1| the author will beatmatch across. */
  maxBeatmatchStretch: number;
  /** Below this tempo-confidence, a tempo is a guess: no beatmatch. */
  minTempoConfidence: number;
  /** Below this whole-grid confidence, grid anchors are not trusted. */
  minGridConfidence: number;
  /** Graded vocal-overlap integral above which two voices are clashing. */
  vocalClashIntegral: number;
  /** Mean confidence below which vocal evidence is "uncertain". */
  vocalTrustConfidence: number;
  /** A distant key caps blends at this many beats. */
  distantKeyMaxBlendBeats: number;
  /** Minimum incoming drop strength for a drop-cut to be offered. */
  minDropCutStrength: number;
  /** The blend may not start sooner than this many beats from now. */
  minLeadBeats: number;
  /** The author's default blend length, in beats. */
  standardBlendBeats: number;
  /** The blend length a quiet, friendly pair earns, in beats. */
  longBlendBeats: number;
  /** The shortest honest blend, in beats. */
  minBlendBeats: number;
  /** Rate-return runway clamps, in incoming beats. */
  minRateReturnBeats: number;
  maxRateReturnBeats: number;
  defaultRateReturnBeats: number;

  // ---- scoring judgement ----

  /**
   * Base cost per family, subtracted from a candidate's weighted
   * evidence score: what this profile thinks a family must earn its
   * way past. Spinback and vinyl-stop are priced as habits to break,
   * per the blueprint — rare by design.
   */
  familyCosts: Record<JoinFamily, number>;
  /**
   * Weights of the scored evidence components. They sum to 1, so a
   * candidate's weighted evidence lives in 0..1 before costs.
   */
  weights: {
    keyFit: number;
    vocalClarity: number;
    stretchFit: number;
    structureFit: number;
    loopValue: number;
    arcFit: number;
  };
  /**
   * The near-equal band: candidates within this distance of the best
   * score are all treated as defensible winners, and history picks
   * among them (blueprint §3.3 selection rule).
   */
  nearEqualBand: number;

  // ---- anti-repetition (consumed by joinHistory's read) ----

  antiRepetition: {
    /** How many of the most recent joins the memory weighs. */
    windowJoins: number;
    /** Cost per recent use of the same family for a SIMILAR pair-shape. */
    familyRepeatCost: number;
    /** Cost per recent use of the same family for a different pair-shape. */
    familyRepeatCostOtherShape: number;
    /** Extra cost when the repeated family also repeats its geometry. */
    geometryRepeatCost: number;
    /** Cost when the exact pair (both fingerprints) was joined recently. */
    samePairCost: number;
    /** Cost when the heard-length pattern is about to repeat a third time. */
    heardLengthRepeatCost: number;
    /** No candidate's history cost may exceed this, however repetitive. */
    maxCost: number;
  };
}

/**
 * The standard profile: the S5-2 author's shipped judgement, moved
 * here field for field. Authoring under this profile must produce
 * byte-identical recipes to the pre-slice author — the profile
 * threading tests pin that.
 */
export const STANDARD_PROFILE: DecisionProfile = {
  id: "standard",
  label: "Standard",
  version: DECISION_PROFILE_VERSION,
  maxBeatmatchStretch: 0.06,
  minTempoConfidence: 0.2,
  minGridConfidence: 0.15,
  vocalClashIntegral: 0.4,
  vocalTrustConfidence: 0.35,
  distantKeyMaxBlendBeats: 8,
  minDropCutStrength: 1.5,
  minLeadBeats: 8,
  standardBlendBeats: 16,
  longBlendBeats: 24,
  minBlendBeats: 4,
  minRateReturnBeats: 4,
  maxRateReturnBeats: 32,
  defaultRateReturnBeats: 8,
  familyCosts: {
    "long-blend": 0,
    "standard-blend": 0,
    "short-blend": 0.02,
    "loop-extended-blend": 0.03,
    "drop-cut": 0.04,
    "section-swap": 0.04,
    "filter-fade": 0.05,
    "echo-out": 0.06,
    "early-cut": 0.05,
    "let-it-play": 0.03,
    spinback: 0.45,
    "vinyl-stop": 0.45,
  },
  weights: {
    keyFit: 0.22,
    vocalClarity: 0.24,
    stretchFit: 0.16,
    structureFit: 0.18,
    loopValue: 0.08,
    arcFit: 0.12,
  },
  nearEqualBand: 0.05,
  antiRepetition: {
    windowJoins: 12,
    familyRepeatCost: 0.1,
    familyRepeatCostOtherShape: 0.03,
    geometryRepeatCost: 0.06,
    samePairCost: 0.25,
    heardLengthRepeatCost: 0.08,
    maxCost: 0.5,
  },
};

/**
 * The conservative profile: every trust gate tightened, blends
 * shorter, drops must be stronger to earn a cut, theatrical families
 * priced up, restraint (let-it-play) priced down. Repetition bothers
 * it least — consistency is a virtue to this temperament.
 */
export const CONSERVATIVE_PROFILE: DecisionProfile = {
  id: "conservative",
  label: "Conservative",
  version: DECISION_PROFILE_VERSION,
  maxBeatmatchStretch: 0.04,
  minTempoConfidence: 0.35,
  minGridConfidence: 0.3,
  vocalClashIntegral: 0.3,
  vocalTrustConfidence: 0.5,
  distantKeyMaxBlendBeats: 4,
  minDropCutStrength: 2.0,
  minLeadBeats: 8,
  standardBlendBeats: 12,
  longBlendBeats: 16,
  minBlendBeats: 4,
  minRateReturnBeats: 4,
  maxRateReturnBeats: 32,
  defaultRateReturnBeats: 8,
  familyCosts: {
    "long-blend": 0.02,
    "standard-blend": 0,
    "short-blend": 0,
    "loop-extended-blend": 0.06,
    "drop-cut": 0.08,
    "section-swap": 0.06,
    "filter-fade": 0.08,
    "echo-out": 0.12,
    "early-cut": 0.12,
    "let-it-play": 0.01,
    spinback: 0.6,
    "vinyl-stop": 0.6,
  },
  weights: {
    keyFit: 0.25,
    vocalClarity: 0.3,
    stretchFit: 0.2,
    structureFit: 0.15,
    loopValue: 0.03,
    arcFit: 0.07,
  },
  nearEqualBand: 0.03,
  antiRepetition: {
    windowJoins: 12,
    familyRepeatCost: 0.06,
    familyRepeatCostOtherShape: 0.02,
    geometryRepeatCost: 0.04,
    samePairCost: 0.2,
    heardLengthRepeatCost: 0.05,
    maxCost: 0.4,
  },
};

/**
 * The adventurous profile: wider band, more weight on structure,
 * loops and the arc, repetition priced hardest, doing nothing priced
 * up. Its stretch cap (0.09) stays inside the §3.7 policy floor — the
 * scoring weights, not the cap, are what let a wider stretch win: it
 * must be carried by everything else being right.
 */
export const ADVENTUROUS_PROFILE: DecisionProfile = {
  id: "adventurous",
  label: "Adventurous",
  version: DECISION_PROFILE_VERSION,
  maxBeatmatchStretch: 0.09,
  minTempoConfidence: 0.15,
  minGridConfidence: 0.1,
  vocalClashIntegral: 0.45,
  vocalTrustConfidence: 0.3,
  distantKeyMaxBlendBeats: 8,
  minDropCutStrength: 1.2,
  minLeadBeats: 8,
  standardBlendBeats: 16,
  longBlendBeats: 32,
  minBlendBeats: 4,
  minRateReturnBeats: 4,
  maxRateReturnBeats: 32,
  defaultRateReturnBeats: 8,
  familyCosts: {
    "long-blend": 0,
    "standard-blend": 0.01,
    "short-blend": 0.02,
    "loop-extended-blend": 0.01,
    "drop-cut": 0.02,
    "section-swap": 0.02,
    "filter-fade": 0.04,
    "echo-out": 0.04,
    "early-cut": 0.02,
    "let-it-play": 0.08,
    spinback: 0.3,
    "vinyl-stop": 0.3,
  },
  weights: {
    keyFit: 0.16,
    vocalClarity: 0.18,
    stretchFit: 0.1,
    structureFit: 0.24,
    loopValue: 0.14,
    arcFit: 0.18,
  },
  nearEqualBand: 0.09,
  antiRepetition: {
    windowJoins: 16,
    familyRepeatCost: 0.16,
    familyRepeatCostOtherShape: 0.05,
    geometryRepeatCost: 0.1,
    samePairCost: 0.3,
    heardLengthRepeatCost: 0.12,
    maxCost: 0.6,
  },
};

/** The profiles the candidate enumerator offers by default. */
export const DEFAULT_CANDIDATE_PROFILES: readonly DecisionProfile[] = [
  STANDARD_PROFILE,
  CONSERVATIVE_PROFILE,
  ADVENTUROUS_PROFILE,
];

/** A missing profile means the standard one — the pre-slice behaviour. */
export function resolveProfile(
  profile: DecisionProfile | undefined | null,
): DecisionProfile {
  return profile ?? STANDARD_PROFILE;
}
