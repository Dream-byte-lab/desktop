// Candidates (Step 5, slice S5-3): generation without judgement.
//
// Given a pair of analyses and a position, produce the SET of honest
// joins the evidence supports — the same pair authored under several
// decision profiles and under the author's distinct families, plus
// the families the author itself never picks as its single answer
// (let-it-play, early-cut, section-swap: the charter's sixth
// requirement — more than four leaves, including deliberately doing
// less). Every candidate is a full TransitionRecipe plus the derived
// evidence scoring will weigh; nothing here ranks anything. Ranking
// is scoring.ts; performing is the executor's; this module only
// answers "what COULD join these two tracks, honestly, from here?"
//
// Two deliberate omissions, both honesty rules, not oversights:
//
// - Spinback / vinyl-stop are NOT enumerated. The S5-2 executor does
//   not perform them, so a candidate carrying one could win a scoring
//   it could never cash. Their family costs exist in the profiles so
//   the vocabulary is ready when the executor learns them.
//
// - A candidate whose recipe fails validateRecipe is dropped at the
//   door. The set contains only performable joins.
//
// Deduplication: candidates are keyed on the plan itself (preset,
// anchors, length, rate, loops, echo) — when two profiles author the
// same join, the set keeps the first telling of it.

import type { TrackAnalysis } from "./analyseTrack";
import { beatsAtTime, secondsPerBeat, timeAtBeat } from "./beatMap";
import {
  DEFAULT_CANDIDATE_PROFILES,
  STANDARD_PROFILE,
  type DecisionProfile,
  type JoinFamily,
} from "./decisionProfile";
import { pairShapeOf } from "./joinHistory";
import type { KeyRelation } from "./keyCompatibility";
import { keyCompatibility } from "./keyCompatibility";
import {
  flatCurve,
  OPEN_FILTER_HZ,
  validateRecipe,
  type AutomationCurve,
  type TransitionRecipe,
} from "./recipe";
import {
  authorBlendVariant,
  authorRateOneVariant,
  authorRecipe,
  chooseEntry,
  fingerprintsOf,
  vocalOverlapIntegral,
  type RecipeRequest,
} from "./transitionPlanner";

// ---------------------------------------------------------------------
// The candidate record
// ---------------------------------------------------------------------

export type EntryKind =
  "drop" | "section" | "intro-end" | "track-start" | "phrase";
export type ExitKind =
  "track-end" | "outro-start" | "section-boundary" | "phrase";

/**
 * The evidence scoring weighs, derived uniformly from the recipe and
 * the two analyses — the same derivation no matter who authored the
 * recipe, so rivals are always compared on one scale.
 */
export interface CandidateEvidence {
  /** The pair-shape (joinHistory's vocabulary) this candidate serves. */
  pairShape: string;
  /** The weaker side's tempo confidence — a guess on either side is a guess. */
  tempoConfidence: number;
  /** The weaker present grid confidence; null when neither grid exists. */
  gridConfidence: number | null;
  /** Key relation, or "unknown" (absent key, or a key read too weakly to spend). */
  keyRelation: KeyRelation | "unknown";
  /** Camelot fit 0..1 when both keys are known, else null. */
  keyScore: number | null;
  /** The weaker side's key confidence; null when either key is absent. */
  keyConfidence: number | null;
  /** Graded vocal-overlap integral stamped on the recipe, 0..1. */
  vocalOverlap: number;
  /** Whether that vocal reading carried real confidence. */
  vocalEvidence: "trusted" | "uncertain";
  /** |rateB − 1| of the recipe, 0 for rate-1 joins. */
  stretch: number;
  beatmatched: boolean;
  /** Overlap length in beats of the outgoing (0 for cuts). */
  blendBeats: number;
  entryKind: EntryKind;
  /** Strength of the drop the entry lands on, when it lands on one. */
  entryDropStrength: number | null;
  exitKind: ExitKind;
  /** Beats of loop extension the recipe carries (0 when none). */
  loopBeats: number;
  /** Seconds of the outgoing heard before the join; null for legacy anchors. */
  heardLengthSec: number | null;
  /**
   * The incoming's energy at the entry, normalised 0..1 against its
   * own loudest section — the arc evidence. Null without sections.
   */
  entryEnergy: number | null;
}

export interface Candidate {
  recipe: TransitionRecipe;
  family: JoinFamily;
  /** The profile this candidate was authored/scored under. */
  profileId: string;
  /** Where the candidate came from, for the audit trail. */
  origin: string;
  evidence: CandidateEvidence;
}

// ---------------------------------------------------------------------
// Family reading
// ---------------------------------------------------------------------

/** The family a recipe belongs to, read off the artefact itself. */
export function familyOfRecipe(recipe: TransitionRecipe): JoinFamily {
  for (const loop of recipe.loops) {
    if (loop.type === "spinback") return "spinback";
    if (loop.type === "vinyl-stop") return "vinyl-stop";
  }
  if (recipe.loops.some((l) => l.type === "loop")) {
    return "loop-extended-blend";
  }
  switch (recipe.preset) {
    case "beatmatched-fade": {
      const beats =
        (recipe.overlap.durationMs / 1000) * (recipe.overlap.bpmA / 60);
      if (beats > 16) return "long-blend";
      if (beats >= 8) return "standard-blend";
      return "short-blend";
    }
    case "beatmatched-cut":
      return "drop-cut";
    case "cut":
      return "drop-cut";
    case "fade":
      return recipe.fx.echo ? "echo-out" : "filter-fade";
  }
}

// ---------------------------------------------------------------------
// Evidence derivation
// ---------------------------------------------------------------------

/** Below this key confidence, a key is reported but never spent. */
const KEY_SPEND_CONFIDENCE = 0.3;

function tempoConfidenceOf(analysis: TrackAnalysis): number {
  return typeof analysis.tempoConfidence === "number"
    ? analysis.tempoConfidence
    : 1;
}

export function deriveCandidateEvidence(
  outgoing: TrackAnalysis,
  incoming: TrackAnalysis,
  recipe: TransitionRecipe,
  pairShape: string,
): CandidateEvidence {
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  const o = recipe.overlap;
  const durationSec = o.durationMs / 1000;

  // The entry is where B's overlap ENDS (the moment B owns the mix):
  // B's start advanced by the overlap at B's rate.
  const entrySecB = o.startBMs / 1000 + durationSec * o.rateB;
  const entryBeat = beatsAtTime(inMap, entrySecB);

  let entryKind: EntryKind = "phrase";
  let entryDropStrength: number | null = null;
  const drop = (incoming.drops ?? []).find(
    (d) => Math.abs(d.beat - entryBeat) <= 0.5,
  );
  if (drop) {
    entryKind = "drop";
    entryDropStrength = drop.strength;
  } else if (
    incoming.intro &&
    Math.abs(entryBeat - incoming.intro.endBeat) <= 0.5
  ) {
    entryKind = "intro-end";
  } else if (
    (incoming.sections ?? []).some(
      (s) => Math.abs(s.startBeat - entryBeat) <= 0.5,
    )
  ) {
    entryKind = "section";
  } else if (entryBeat <= 0.5) {
    entryKind = "track-start";
  }

  // The exit is where A starts leaving — except for near-instant
  // joins (a cut, a two-beat swap), whose meaningful anchor is where
  // the handover COMPLETES: a swap that ends on a boundary is a
  // boundary join, read at its end as well as its start.
  let exitKind: ExitKind = "phrase";
  let heardLengthSec: number | null = null;
  if (o.startAMs !== null) {
    heardLengthSec = o.startAMs / 1000;
    const exitBeat = beatsAtTime(outMap, heardLengthSec);
    const blendBeatsA = durationSec * (o.bpmA / 60);
    const anchors =
      blendBeatsA <= 2 ? [exitBeat, exitBeat + blendBeatsA] : [exitBeat];
    const near = (beat: number): boolean =>
      anchors.some((a) => Math.abs(a - beat) <= 1);
    if (outgoing.outro && near(outgoing.outro.startBeat)) {
      exitKind = "outro-start";
    } else if (
      Math.abs(heardLengthSec - outMap.durationSec) <=
      secondsPerBeat(outMap.bpm)
    ) {
      exitKind = "track-end";
    } else if (
      (outgoing.sections ?? []).some(
        (s) => near(s.startBeat) || near(s.endBeat),
      )
    ) {
      exitKind = "section-boundary";
    }
  }

  const fit = keyCompatibility(outgoing.key, incoming.key);
  const keyConfidence =
    outgoing.key && incoming.key
      ? Math.min(outgoing.key.confidence, incoming.key.confidence)
      : null;
  const keyRelation: KeyRelation | "unknown" =
    fit && keyConfidence !== null && keyConfidence >= KEY_SPEND_CONFIDENCE
      ? fit.relation
      : "unknown";

  const grids = [outMap.grid?.confidence, inMap.grid?.confidence].filter(
    (c): c is number => typeof c === "number",
  );

  let entryEnergy: number | null = null;
  const inSections = incoming.sections ?? [];
  if (inSections.length > 0) {
    const peak = Math.max(...inSections.map((s) => s.meanRms));
    const atEntry = inSections.find(
      (s) => entryBeat >= s.startBeat && entryBeat < s.endBeat,
    );
    if (atEntry && peak > 0) entryEnergy = atEntry.meanRms / peak;
  }

  return {
    pairShape,
    tempoConfidence: Math.min(
      tempoConfidenceOf(outgoing),
      tempoConfidenceOf(incoming),
    ),
    gridConfidence: grids.length > 0 ? Math.min(...grids) : null,
    keyRelation,
    keyScore: fit ? fit.score : null,
    keyConfidence,
    vocalOverlap: recipe.evidence.vocalOverlap,
    vocalEvidence: recipe.evidence.vocalEvidence,
    stretch: Math.abs(o.rateB - 1),
    beatmatched: o.beatmatched,
    blendBeats: durationSec * (o.bpmA / 60),
    entryKind,
    entryDropStrength,
    exitKind,
    loopBeats: recipe.loops
      .filter((l) => l.type === "loop")
      .reduce((sum, l) => sum + l.beats, 0),
    heardLengthSec,
    entryEnergy,
  };
}

// ---------------------------------------------------------------------
// The families the author never picks as its single answer
// ---------------------------------------------------------------------

function curve(
  kind: AutomationCurve["kind"],
  unit: AutomationCurve["unit"],
  points: [number, number][],
): AutomationCurve {
  return {
    kind,
    unit,
    points: points.map(([atMs, value]) => ({ atMs, value })),
  };
}

function flatEq(): AutomationCurve {
  return flatCurve("eq-gain", "decibels", 0);
}

function cutAutomation(): TransitionRecipe["automation"] {
  return {
    volumeOut: curve("linear-gain", "linear", [
      [0, 1],
      [0, 0],
    ]),
    volumeIn: curve("linear-gain", "linear", [
      [0, 0],
      [0, 1],
    ]),
    eqOut: { low: flatEq(), mid: flatEq(), high: flatEq() },
    eqIn: { low: flatEq(), mid: flatEq(), high: flatEq() },
    filterOut: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
    filterIn: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
    rateB: flatCurve("rate", "ratio", 1),
    echoSendOut: flatCurve("dry-wet", "percent", 0),
    echoSendIn: flatCurve("dry-wet", "percent", 0),
  };
}

const FALLBACK_NOTE =
  "If this recipe cannot be performed as written, cut plainly — never force the blend.";

interface OwnJoinSpec {
  preset: TransitionRecipe["preset"];
  startASec: number;
  startBSec: number;
  durationMs: number;
  automation: TransitionRecipe["automation"];
  entryReason: string;
  exitReason: string;
}

function ownJoin(request: RecipeRequest, spec: OwnJoinSpec): TransitionRecipe {
  const { outgoing, incoming } = request;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  const durationSec = spec.durationMs / 1000;

  // Vocal evidence over the join's own window, graded where the
  // analyses allow — the same instrument the referee reads.
  let vocalOverlap = 0;
  let vocalEvidence: "trusted" | "uncertain" = "trusted";
  if (durationSec > 0) {
    const reading = vocalOverlapIntegral(
      outgoing,
      spec.startASec,
      spec.startASec + durationSec,
      incoming,
      spec.startBSec,
      spec.startBSec + durationSec,
    );
    vocalOverlap = reading.integral;
    vocalEvidence =
      reading.graded && reading.trust >= STANDARD_PROFILE.vocalTrustConfidence
        ? "trusted"
        : "uncertain";
  }

  return {
    version: 1,
    preset: spec.preset,
    overlap: {
      startAMs: spec.startASec * 1000,
      startBMs: spec.startBSec * 1000,
      durationMs: spec.durationMs,
      durationBars:
        durationSec / (outMap.beatsPerBar * secondsPerBeat(outMap.bpm)),
      beatmatched: false,
      rateA: 1,
      rateB: 1,
      bpmA: outMap.bpm,
      bpmB: inMap.bpm,
    },
    leadInSec: Math.max(0, spec.startASec - request.outgoingPositionSec),
    automation: spec.automation,
    loops: [],
    fx: {},
    fingerprints: fingerprintsOf(outgoing, incoming),
    fallback: { kind: "cut", note: FALLBACK_NOTE },
    evidence: {
      entryReason: spec.entryReason,
      exitReason: spec.exitReason,
      vocalOverlap,
      vocalEvidence,
      tempoStretch: 0,
      keyScore: keyCompatibility(outgoing.key, incoming.key)?.score ?? null,
      refereeShortened: false,
    },
  };
}

/**
 * Let the outgoing play out to its very end, then start the incoming
 * from its start. The honest "no join" — a DJ's restraint is a real
 * choice, and a decider that cannot choose it will force joins the
 * music did not ask for.
 */
function authorLetItPlay(request: RecipeRequest): TransitionRecipe | null {
  const { outgoing, incoming } = request;
  const durationSec = outgoing.beatMap.durationSec;
  if (request.outgoingPositionSec >= durationSec - 0.25) return null;
  return ownJoin(request, {
    preset: "cut",
    startASec: durationSec,
    startBSec: timeAtBeat(incoming.beatMap, 0),
    durationMs: 0,
    automation: cutAutomation(),
    entryReason: "the incoming starts from its beginning — no join was forced",
    exitReason: outgoing.outro
      ? "the outgoing plays out through its outro to its end"
      : "the outgoing plays out to its end",
  });
}

/**
 * Leave the outgoing EARLY, at its last clean section boundary that
 * still leaves a real remainder unplayed, cutting to the incoming's
 * chosen entry. The mirror of let-it-play: sometimes the right join
 * is not waiting for the ending at all.
 */
function authorEarlyCut(request: RecipeRequest): TransitionRecipe | null {
  const { outgoing, incoming } = request;
  const profile = STANDARD_PROFILE;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  const nowBeat = beatsAtTime(outMap, request.outgoingPositionSec);
  const totalBeats = beatsAtTime(outMap, outMap.durationSec);

  const boundary = (outgoing.sections ?? [])
    .filter(
      (s) =>
        s.kind !== "intro" &&
        s.startBeat >= nowBeat + profile.minLeadBeats &&
        // Genuinely early: at least a standard blend's worth of the
        // outgoing goes deliberately unheard.
        s.startBeat <= totalBeats - profile.minLeadBeats &&
        (!outgoing.outro || s.startBeat < outgoing.outro.startBeat),
    )
    .pop();
  if (!boundary) return null;

  const entry = chooseEntry(incoming, profile);
  return ownJoin(request, {
    preset: "cut",
    startASec: timeAtBeat(outMap, boundary.startBeat),
    startBSec: timeAtBeat(inMap, entry.beat),
    durationMs: 0,
    automation: cutAutomation(),
    entryReason: entry.reason,
    exitReason: `an early cut at the ${boundary.kind} boundary — the remainder is deliberately unplayed`,
  });
}

/**
 * A section swap: the incoming's chorus (or first real section)
 * lands exactly on an outgoing section boundary, handed over in two
 * beats at rate 1 — no beatmatch, no filter sweep; the structure
 * itself is the join.
 */
function authorSectionSwap(request: RecipeRequest): TransitionRecipe | null {
  const { outgoing, incoming } = request;
  const profile = STANDARD_PROFILE;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  const nowBeat = beatsAtTime(outMap, request.outgoingPositionSec);
  const totalBeats = beatsAtTime(outMap, outMap.durationSec);
  const swapBeats = 2;

  const bSections = (incoming.sections ?? []).filter(
    (s) => s.kind !== "intro" && s.startBeat >= swapBeats,
  );
  const bSection = bSections.find((s) => s.kind === "chorus") ?? bSections[0];
  if (!bSection) return null;

  const aBoundary = (outgoing.sections ?? [])
    .map((s) => s.endBeat)
    .filter(
      (endBeat) =>
        endBeat >= nowBeat + profile.minLeadBeats + swapBeats &&
        endBeat <= totalBeats,
    )
    .sort((a, b) => a - b)[0];
  if (aBoundary === undefined) return null;

  const durationMs = swapBeats * secondsPerBeat(outMap.bpm) * 1000;
  const startASec = timeAtBeat(outMap, aBoundary - swapBeats);
  const startBSec = timeAtBeat(inMap, bSection.startBeat - swapBeats);
  if (startBSec < 0) return null;

  return ownJoin(request, {
    preset: "fade",
    startASec,
    startBSec,
    durationMs,
    automation: {
      volumeOut: {
        kind: "linear-gain",
        unit: "linear",
        points: [
          { atMs: 0, value: 1, easing: "smooth" },
          { atMs: durationMs, value: 0 },
        ],
      },
      volumeIn: {
        kind: "linear-gain",
        unit: "linear",
        points: [
          { atMs: 0, value: 0, easing: "smooth" },
          { atMs: durationMs, value: 1 },
        ],
      },
      eqOut: {
        low: curve("eq-gain", "decibels", [
          [0, 0],
          [durationMs, -12],
        ]),
        mid: flatEq(),
        high: flatEq(),
      },
      eqIn: {
        low: curve("eq-gain", "decibels", [
          [0, -12],
          [durationMs, 0],
        ]),
        mid: flatEq(),
        high: flatEq(),
      },
      filterOut: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      filterIn: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      rateB: flatCurve("rate", "ratio", 1),
      echoSendOut: flatCurve("dry-wet", "percent", 0),
      echoSendIn: flatCurve("dry-wet", "percent", 0),
    },
    entryReason: `the incoming's ${bSection.kind} lands on the outgoing's section boundary`,
    exitReason: "a section boundary, swapped in two beats",
  });
}

// ---------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------

function signatureOf(recipe: TransitionRecipe): string {
  const o = recipe.overlap;
  const loops = recipe.loops
    .map((l) => `${l.type}:${Math.round(l.startMs)}-${Math.round(l.endMs)}`)
    .join(",");
  return [
    recipe.preset,
    o.startAMs === null ? "null" : Math.round(o.startAMs),
    Math.round(o.startBMs),
    Math.round(o.durationMs),
    o.rateB.toFixed(4),
    loops,
    recipe.fx.echo ? "echo" : "",
  ].join("|");
}

export interface CandidateOptions {
  /** Profiles to author under. Default: the three shipped temperaments. */
  profiles?: readonly DecisionProfile[];
}

/**
 * The candidate set for a pair, from a position. Generation only:
 * the order is authoring order (profiles first, then family rivals,
 * then the restraint families), duplicates of the same plan collapse
 * to their first telling, and nothing is ranked.
 */
export function candidatesForPair(
  request: RecipeRequest,
  options: CandidateOptions = {},
): Candidate[] {
  const profiles = options.profiles ?? DEFAULT_CANDIDATE_PROFILES;
  const pairShape = pairShapeOf(request.outgoing, request.incoming);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  const push = (
    recipe: TransitionRecipe | null,
    origin: string,
    profileId: string,
    familyOverride?: JoinFamily,
  ): void => {
    if (!recipe) return;
    if (validateRecipe(recipe).length > 0) return;
    const signature = signatureOf(recipe);
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push({
      recipe,
      // The restraint families are plain cuts/fades as artefacts —
      // what makes a cut a let-it-play or an early-cut is WHERE it
      // lands, which only the authoring family knows. Author- and
      // variant-born candidates have their family read off the
      // recipe; the own families stamp theirs.
      family: familyOverride ?? familyOfRecipe(recipe),
      profileId,
      origin,
      evidence: deriveCandidateEvidence(
        request.outgoing,
        request.incoming,
        recipe,
        pairShape,
      ),
    });
  };

  // The author's own answer under each temperament.
  for (const profile of profiles) {
    push(
      authorRecipe({ ...request, profile }),
      `author:${profile.id}`,
      profile.id,
    );
  }

  // The author's families as rivals, under the standard profile: a
  // shorter blend than the author would pick, the loop-extended
  // blend on its own, and each rate-1 family separately.
  const standard: RecipeRequest = { ...request, profile: STANDARD_PROFILE };
  push(
    authorBlendVariant(standard, { desiredBeats: 6 }),
    "variant:short-blend",
    STANDARD_PROFILE.id,
  );
  push(
    authorBlendVariant(standard, { loopOnly: true }),
    "variant:loop-extended",
    STANDARD_PROFILE.id,
  );
  push(
    authorRateOneVariant(standard, "drop-cut"),
    "variant:drop-cut",
    STANDARD_PROFILE.id,
  );
  push(
    authorRateOneVariant(standard, "filter-fade"),
    "variant:filter-fade",
    STANDARD_PROFILE.id,
  );

  // The restraint and structure families the author never picks alone.
  push(
    authorSectionSwap(request),
    "family:section-swap",
    STANDARD_PROFILE.id,
    "section-swap",
  );
  push(
    authorEarlyCut(request),
    "family:early-cut",
    STANDARD_PROFILE.id,
    "early-cut",
  );
  push(
    authorLetItPlay(request),
    "family:let-it-play",
    STANDARD_PROFILE.id,
    "let-it-play",
  );

  return candidates;
}
