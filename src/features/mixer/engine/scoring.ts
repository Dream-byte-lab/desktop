// Scoring (Step 5, slice S5-3): judgement over the candidate set.
//
// Generation proposed (candidates.ts); this module disposes. It is
// the blueprint §3.3 teeth table turned into a ranking: measurements
// the v1 decider computed and discarded — tempo comfort, tempo
// confidence, key fit, drop strength — are spent here as vetoes and
// weights, and the winner must be able to say WHY it won: every
// score is a sum of named components, each carrying its own note, so
// the pick can be audited line by line (and the ear-test pattern log
// has something real to read).
//
// The order of operations is the charter in miniature:
//
// 1. VETOES first — a candidate built on guesses is refused before
//    it can be ranked: a beatmatch past the profile's stretch cap, a
//    beatmatch on low-confidence tempo evidence ("don't beatmatch
//    on a guess"), a long blend into a distant key, a trusted vocal
//    clash. A vetoed candidate stays in the result, marked, with its
//    reasons — refusal is also evidence.
// 2. WEIGHED EVIDENCE for the survivors: key fit, vocal clarity,
//    stretch fit, structure fit (entry AND exit — drop strength is
//    spent here at last, not earliness), loop value, and fit to the
//    set's energy arc where the session supplies one.
// 3. COSTS subtracted: the family's base cost under the profile, and
//    the history cost from joinHistory's anti-repetition read — the
//    only place the past is allowed to speak.
// 4. SELECTION from the near-equal band: everyone within the
//    profile's band of the best score is a defensible winner, and
//    within the band the LOWEST history cost picks — so between two
//    joins the evidence cannot separate, the one the listener has
//    not just heard wins. Deterministic throughout: no randomness
//    anywhere in this module; variety comes from evidence and
//    history, never from dice.

import type { Candidate } from "./candidates";
import { STANDARD_PROFILE, type DecisionProfile } from "./decisionProfile";
import { repetitionCost, type JoinRecord } from "./joinHistory";

export interface ScoreContext {
  /** Joins actually performed, oldest first (joinHistory's log). */
  history?: readonly JoinRecord[];
  /**
   * Where this join sits in the set, 0..1 — carried for the trail
   * and for future arc terms; today's arc term is the energy target.
   */
  arcPosition?: number;
  /**
   * The energy the set wants the incoming's entry to land at, 0..1
   * (same normalised scale as CandidateEvidence.entryEnergy). Absent
   * = the arc abstains and arcFit is neutral for every candidate.
   */
  arcTargetEnergy?: number;
}

export interface ScoreComponent {
  name:
    | "keyFit"
    | "vocalClarity"
    | "stretchFit"
    | "structureFit"
    | "loopValue"
    | "arcFit"
    | "familyCost"
    | "history";
  /** The component's own reading, 0..1 for weighed evidence; the raw cost for cost components. */
  value: number;
  /** The profile weight applied (1 for the cost components). */
  weight: number;
  /** What this component added to (or subtracted from) the score. */
  contribution: number;
  /** Why — the auditable sentence. */
  note: string;
}

export interface ScoredCandidate {
  candidate: Candidate;
  vetoed: boolean;
  vetoReasons: string[];
  /** Every component that made the score, in weighing order. Their contributions sum to `score`. */
  components: ScoreComponent[];
  /** The anti-repetition charge inside the score (also broken out for band selection). */
  historyCost: number;
  historyNotes: string[];
  score: number;
}

export interface ScoringResult {
  /** Survivors by score, best first; then the vetoed, in enumeration order. */
  ranked: ScoredCandidate[];
  /** The near-equal band around the best survivor — the defensible winners. */
  band: ScoredCandidate[];
  /** The chosen candidate: the band's least-repetitive member. Null when nothing survived. */
  pick: ScoredCandidate | null;
}

const BLEND_FAMILIES: ReadonlySet<string> = new Set([
  "long-blend",
  "standard-blend",
  "short-blend",
  "loop-extended-blend",
]);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function vetoesFor(candidate: Candidate, profile: DecisionProfile): string[] {
  const e = candidate.evidence;
  const reasons: string[] = [];

  if (candidate.family === "spinback" || candidate.family === "vinyl-stop") {
    reasons.push(
      `${candidate.family} is not performable by the decks yet — a candidate that cannot be performed cannot win`,
    );
  }
  if (e.beatmatched && e.stretch > profile.maxBeatmatchStretch) {
    reasons.push(
      `beatmatched stretch ${(e.stretch * 100).toFixed(1)}% exceeds the ${profile.id} cap of ${(profile.maxBeatmatchStretch * 100).toFixed(1)}% — too-stretched pairs change family, they don't stretch further`,
    );
  }
  if (e.beatmatched && e.tempoConfidence < profile.minTempoConfidence) {
    reasons.push(
      `tempo confidence ${e.tempoConfidence.toFixed(2)} is below the ${profile.id} floor of ${profile.minTempoConfidence.toFixed(2)} — never beatmatch on a guess`,
    );
  }
  if (
    e.beatmatched &&
    e.gridConfidence !== null &&
    e.gridConfidence < profile.minGridConfidence
  ) {
    reasons.push(
      `grid confidence ${e.gridConfidence.toFixed(2)} is below the ${profile.id} floor of ${profile.minGridConfidence.toFixed(2)} — the beat grid itself is not trusted`,
    );
  }
  if (
    BLEND_FAMILIES.has(candidate.family) &&
    e.keyRelation === "distant" &&
    e.blendBeats > profile.distantKeyMaxBlendBeats
  ) {
    reasons.push(
      `a distant key caps blends at ${profile.distantKeyMaxBlendBeats} beats under the ${profile.id} profile; this one runs ${e.blendBeats.toFixed(1)}`,
    );
  }
  if (
    e.vocalEvidence === "trusted" &&
    e.vocalOverlap > profile.vocalClashIntegral
  ) {
    reasons.push(
      `trusted vocal overlap ${e.vocalOverlap.toFixed(2)} exceeds the clash bound ${profile.vocalClashIntegral.toFixed(2)} — two lead voices at once`,
    );
  }
  return reasons;
}

function entryQuality(candidate: Candidate): { value: number; note: string } {
  const e = candidate.evidence;
  switch (e.entryKind) {
    case "drop": {
      const strength = e.entryDropStrength ?? 1.5;
      return {
        value: 0.75 + 0.25 * Math.min(1, strength / 3),
        note: `entry lands on a drop of strength ${strength.toFixed(2)} — strength, not earliness`,
      };
    }
    case "section":
      return { value: 0.8, note: "entry lands on a section start" };
    case "intro-end":
      return { value: 0.7, note: "entry lands at the intro's end" };
    case "track-start":
      return { value: 0.5, note: "entry is the incoming's first beat" };
    case "phrase":
      return { value: 0.35, note: "entry is a bare phrase boundary" };
  }
}

function exitQuality(candidate: Candidate): { value: number; note: string } {
  switch (candidate.evidence.exitKind) {
    case "outro-start":
      return { value: 1, note: "exit begins at the outro's first beat" };
    case "section-boundary":
      return { value: 0.85, note: "exit begins on a section boundary" };
    case "track-end":
      return { value: 0.7, note: "exit is the track's natural end" };
    case "phrase":
      return { value: 0.4, note: "exit is a bare phrase boundary" };
  }
}

function scoreOne(
  candidate: Candidate,
  context: ScoreContext,
  profile: DecisionProfile,
  loopRedundant: boolean,
): ScoredCandidate {
  const e = candidate.evidence;
  const w = profile.weights;
  const components: ScoreComponent[] = [];
  const add = (
    name: ScoreComponent["name"],
    value: number,
    weight: number,
    note: string,
  ): void => {
    components.push({
      name,
      value,
      weight,
      contribution: value * weight,
      note,
    });
  };

  // --- weighed evidence -------------------------------------------

  add(
    "keyFit",
    e.keyScore ?? 0.5,
    w.keyFit,
    e.keyScore === null
      ? "key unknown on at least one side — neutral, never a guess spent as knowledge"
      : `key relation ${e.keyRelation}, fit ${e.keyScore.toFixed(2)}`,
  );

  add(
    "vocalClarity",
    e.vocalEvidence === "trusted"
      ? 1 - e.vocalOverlap
      : 1 - 0.5 * e.vocalOverlap,
    w.vocalClarity,
    e.vocalEvidence === "trusted"
      ? `trusted vocal overlap ${e.vocalOverlap.toFixed(2)} over the window`
      : `vocal overlap ${e.vocalOverlap.toFixed(2)} on uncertain evidence — charged at half weight, never trusted into a veto`,
  );

  add(
    "stretchFit",
    e.beatmatched
      ? clamp01(1 - e.stretch / Math.max(0.01, profile.maxBeatmatchStretch))
      : 1,
    w.stretchFit,
    e.beatmatched
      ? `stretch ${(e.stretch * 100).toFixed(1)}% of the ${(profile.maxBeatmatchStretch * 100).toFixed(1)}% cap`
      : "rate 1 — no stretch spent",
  );

  const entry = entryQuality(candidate);
  const exit = exitQuality(candidate);
  add(
    "structureFit",
    0.5 * entry.value + 0.5 * exit.value,
    w.structureFit,
    `${entry.note}; ${exit.note}`,
  );

  add(
    "loopValue",
    e.loopBeats > 0 && !loopRedundant
      ? 0.75 + 0.25 * Math.min(1, e.blendBeats / 24)
      : 0.5,
    w.loopValue,
    e.loopBeats === 0
      ? "no loop — neutral"
      : loopRedundant
        ? `a ${e.loopBeats}-beat loop extension, but a plain join in this set reaches the same length — the loop buys nothing here`
        : `a ${e.loopBeats}-beat loop extension buys the blend its full length`,
  );

  add(
    "arcFit",
    context.arcTargetEnergy === undefined || e.entryEnergy === null
      ? 0.5
      : clamp01(1 - Math.abs(e.entryEnergy - context.arcTargetEnergy)),
    w.arcFit,
    context.arcTargetEnergy === undefined
      ? "the session supplied no arc target — neutral"
      : e.entryEnergy === null
        ? "the incoming's entry energy is unmeasured — neutral"
        : `entry energy ${e.entryEnergy.toFixed(2)} against the arc's target ${context.arcTargetEnergy.toFixed(2)}`,
  );

  // --- costs --------------------------------------------------------

  const familyCost = profile.familyCosts[candidate.family];
  components.push({
    name: "familyCost",
    value: familyCost,
    weight: 1,
    contribution: -familyCost,
    note: `the ${candidate.family} family's base cost under the ${profile.id} profile`,
  });

  const history = repetitionCost(
    context.history ?? [],
    {
      family: candidate.family,
      pairShape: e.pairShape,
      blendBeats: e.blendBeats,
      heardLengthSec: e.heardLengthSec,
      aAudioHash: candidate.recipe.fingerprints.aAudioHash,
      bAudioHash: candidate.recipe.fingerprints.bAudioHash,
    },
    profile,
  );
  components.push({
    name: "history",
    value: history.cost,
    weight: 1,
    contribution: -history.cost,
    note:
      history.notes.length > 0
        ? history.notes.join("; ")
        : "nothing in the remembered window repeats this",
  });

  const vetoReasons = vetoesFor(candidate, profile);
  return {
    candidate,
    vetoed: vetoReasons.length > 0,
    vetoReasons,
    components,
    historyCost: history.cost,
    historyNotes: history.notes,
    score: components.reduce((sum, c) => sum + c.contribution, 0),
  };
}

/**
 * Score a candidate set under a profile. Returns the ranking, the
 * near-equal band, and the pick — the band's least-repetitive
 * member, ties broken by score, then by enumeration order. Pure and
 * deterministic: the same set, context and profile always choose
 * the same winner.
 */
export function scoreCandidates(
  candidates: readonly Candidate[],
  context: ScoreContext = {},
  profile: DecisionProfile = STANDARD_PROFILE,
): ScoringResult {
  // A loop earns its value only when it buys length no plain join in
  // the set reaches — otherwise looping is decoration, scored neutral.
  const loopRedundant = candidates.map(
    (candidate) =>
      candidate.evidence.loopBeats > 0 &&
      candidates.some(
        (other) =>
          other !== candidate &&
          other.evidence.loopBeats === 0 &&
          other.evidence.blendBeats >= candidate.evidence.blendBeats,
      ),
  );
  const scored = candidates.map((candidate, index) => ({
    index,
    result: scoreOne(candidate, context, profile, loopRedundant[index]),
  }));

  const survivors = scored
    .filter((s) => !s.result.vetoed)
    .sort((a, b) => b.result.score - a.result.score || a.index - b.index);
  const vetoed = scored
    .filter((s) => s.result.vetoed)
    .sort((a, b) => a.index - b.index);

  const ranked = [...survivors, ...vetoed].map((s) => s.result);
  if (survivors.length === 0) return { ranked, band: [], pick: null };

  const best = survivors[0].result.score;
  const band = survivors
    .filter((s) => best - s.result.score <= profile.nearEqualBand)
    .map((s) => s.result);

  const pick = [...survivors]
    .filter((s) => best - s.result.score <= profile.nearEqualBand)
    .sort(
      (a, b) =>
        a.result.historyCost - b.result.historyCost ||
        b.result.score - a.result.score ||
        a.index - b.index,
    )[0].result;

  return { ranked, band, pick };
}
