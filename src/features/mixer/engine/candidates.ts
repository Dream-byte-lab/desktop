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
// One deliberate omission, an honesty rule, not an oversight:
//
// - A candidate whose recipe fails validateRecipe is dropped at the
//   door. The set contains only performable joins.
//
// (Spinback / vinyl-stop were omitted under the same rule until the
// revamp's R1 taught the executor to perform them; they are now
// enumerated as heavily-gated rivals — see authorStopExit. The
// scratch family joined under the same rule with R2 — see the
// scratch authors below. The effects rack joined with R3, not as
// standalone joins but as dressings on joins already authored —
// see authorEffectVariants.)
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
import { meanVocalActivity } from "./detectVocals";
import {
  flatCurve,
  OPEN_FILTER_HZ,
  validateRecipe,
  type AutomationCurve,
  type RecipeEffectBlock,
  type RecipeFx,
  type RecipeLoopBlock,
  type ScratchTechnique,
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
  /**
   * True when the recipe performs against a pitch-preserved
   * rendition of B (overlap.stretchB set): scoring judges its
   * stretch against the profile's rendition ceiling for its
   * direction, not the rate cap.
   */
  stretchMode: boolean;
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
  // A scratch block makes the recipe a scratch join, whatever else
  // it carries — the performance IS the join.
  if (recipe.loops.some((l) => l.type === "scratch")) return "scratch";
  for (const loop of recipe.loops) {
    if (loop.type === "spinback") return "spinback";
    // The stop family: a brake is the gradual telling of the same
    // exit a vinyl-stop tells suddenly — one family, two techniques.
    if (loop.type === "vinyl-stop" || loop.type === "brake")
      return "vinyl-stop";
  }
  if (recipe.loops.some((l) => l.type === "loop")) {
    return "loop-extended-blend";
  }
  // An effect-dressed join is its own family, as a loop-extended
  // blend is: the dressing is what the scorer must price. The
  // scratch and stop readings above win because those performances
  // ARE their joins, and our authors never carry effect blocks on
  // them.
  if ((recipe.effects ?? []).length > 0) return "fx";
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
    stretchMode: o.stretchB !== null,
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
  loops?: TransitionRecipe["loops"];
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
      stretchB: null,
      bpmA: outMap.bpm,
      bpmB: inMap.bpm,
    },
    leadInSec: Math.max(0, spec.startASec - request.outgoingPositionSec),
    automation: spec.automation,
    loops: spec.loops ?? [],
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

/**
 * The stop exits (the revamp's R1): the outgoing is stopped DEAD at
 * its outro's first beat — spun back, braked, or vinyl-stopped —
 * and the incoming lands its entry exactly as the stop completes.
 * Theatre, and priced like it: these are rivals the scorer may
 * refuse, authored only where every gate below passes. The gates
 * are the spec's discipline (§2B: a technique fires when it makes
 * MUSICAL sense, never on a counter):
 *
 * - The authoring profile must price the family within reach
 *   (familyCosts ≤ STOP_AUTHOR_MAX_FAMILY_COST). The conservative
 *   profile prices both stop families at 0.6 — it never authors
 *   them; a profile pricing one at 1+ has priced it out entirely.
 * - The exit must be an ENERGY-ENDING one: the outro's first beat,
 *   with the outro audibly quieter than what precedes it (or, with
 *   no section evidence at all, only a short outro tail counts).
 *   A stop in the middle of a track still climbing is vandalism.
 * - The incoming must offer a real landing — a drop, a section
 *   start, or its intro's end — for the stop to hand over TO.
 * - A spinback additionally needs runway behind the stop point:
 *   the record runs backwards through several seconds of itself.
 *
 * The stop family's technique is chosen by the moment: a long
 * falling outro earns a BRAKE (gradual, 4 beats); a short one a
 * VINYL STOP (sudden, 1 beat). Both are the "vinyl-stop" family —
 * the scorer prices the exit, the block names the technique.
 */
const STOP_AUTHOR_MAX_FAMILY_COST = 0.5;
const VINYL_STOP_BEATS = 1;
const BRAKE_BEATS = 4;
const SPINBACK_BEATS = 2;
const SPINBACK_PEAK_RATE = -3.5;
/** With no section evidence, an outro longer than this is not a stop moment. */
const UNWITNESSED_OUTRO_MAX_BEATS = 32;

function authorStopExit(
  request: RecipeRequest,
  profile: DecisionProfile,
  family: "spinback" | "vinyl-stop",
): TransitionRecipe | null {
  if (profile.familyCosts[family] > STOP_AUTHOR_MAX_FAMILY_COST) return null;
  const { outgoing, incoming } = request;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  if (!outgoing.outro) return null;

  const spbA = secondsPerBeat(outMap.bpm);
  const exitBeat = outgoing.outro.startBeat;
  const exitSec = timeAtBeat(outMap, exitBeat);
  // The stop must not already be upon us.
  if (exitSec < request.outgoingPositionSec + profile.minLeadBeats * spbA) {
    return null;
  }

  // Energy must be falling into the exit.
  const sections = outgoing.sections ?? [];
  const outroSection =
    sections.find((s) => s.kind === "outro") ??
    sections.find((s) => exitSec >= s.startSec && exitSec < s.endSec);
  const before = sections
    .filter((s) => s.kind !== "outro" && s.endSec <= exitSec + 1e-6)
    .pop();
  if (outroSection && before) {
    if (outroSection.meanRms > before.meanRms) return null;
  } else if (!outroSection) {
    const tailBeats = beatsAtTime(outMap, outMap.durationSec) - exitBeat;
    if (tailBeats > UNWITNESSED_OUTRO_MAX_BEATS) return null;
  }

  // The incoming must offer a real landing for the stop to hand to.
  const entry = chooseEntry(incoming, profile);
  const entryIsDrop = incoming.drops.some(
    (d) => Math.abs(d.beat - entry.beat) <= 0.5,
  );
  const entryIsSection = (incoming.sections ?? []).some(
    (s) => Math.abs(s.startBeat - entry.beat) <= 0.5,
  );
  const entryIsIntroEnd = incoming.intro
    ? Math.abs(incoming.intro.endBeat - entry.beat) <= 0.5
    : false;
  if (!entryIsDrop && !entryIsSection && !entryIsIntroEnd) return null;

  const tailBeats = beatsAtTime(outMap, outMap.durationSec) - exitBeat;
  const useBrake = family === "vinyl-stop" && tailBeats >= 24;
  const beats =
    family === "spinback"
      ? SPINBACK_BEATS
      : useBrake
        ? BRAKE_BEATS
        : VINYL_STOP_BEATS;
  const durationMs = beats * spbA * 1000;
  const durationSec = durationMs / 1000;

  if (family === "spinback") {
    // The record runs backwards at an average |rate| of ~2.5 over
    // the spin: the stop point needs that much track behind it,
    // plus a margin, or the spin would run off the track's start.
    if (exitSec < durationSec * 2.5 + 2) return null;
  }

  // B starts early and silent, so its entry beat lands exactly as
  // the stop completes.
  const startBSec = timeAtBeat(inMap, entry.beat) - durationSec;
  if (startBSec < 0) return null;

  const block: TransitionRecipe["loops"][number] =
    family === "spinback"
      ? {
          type: "spinback",
          side: "A",
          startMs: exitSec * 1000,
          endMs: exitSec * 1000 + durationMs,
          beats,
          peakRate: SPINBACK_PEAK_RATE,
        }
      : {
          type: useBrake ? "brake" : "vinyl-stop",
          side: "A",
          startMs: exitSec * 1000,
          endMs: exitSec * 1000 + durationMs,
          beats,
        };

  return ownJoin(request, {
    preset: "cut",
    startASec: exitSec,
    startBSec,
    durationMs,
    automation: {
      // A plays at full level THROUGH the stop — the rate fall is
      // the sound — and is gone at its end; B is silent until the
      // stop completes, then arrives whole.
      volumeOut: curve("linear-gain", "linear", [
        [0, 1],
        [durationMs, 1],
        [durationMs, 0],
      ]),
      volumeIn: curve("linear-gain", "linear", [
        [0, 0],
        [durationMs, 0],
        [durationMs, 1],
      ]),
      eqOut: { low: flatEq(), mid: flatEq(), high: flatEq() },
      eqIn: { low: flatEq(), mid: flatEq(), high: flatEq() },
      filterOut: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      filterIn: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      rateB: flatCurve("rate", "ratio", 1),
      echoSendOut: flatCurve("dry-wet", "percent", 0),
      echoSendIn: flatCurve("dry-wet", "percent", 0),
    },
    loops: [block],
    entryReason: entry.reason,
    exitReason:
      family === "spinback"
        ? "the outgoing is spun back at its outro's first beat — a stop exit, handed to the incoming's entry"
        : useBrake
          ? "the outgoing brakes to a stop across its falling outro — a stop exit, handed to the incoming's entry"
          : "the outgoing is vinyl-stopped at its outro's first beat — a stop exit, handed to the incoming's entry",
  });
}

// ---------------------------------------------------------------------
// The scratch joins (the revamp's R2)
// ---------------------------------------------------------------------

/**
 * The scratch authors: the fader-gated family — baby, chirp,
 * transformer, flare — as heavily-gated rivals, in the stop exits'
 * discipline and with a narrower door. A stop is performed AT a
 * moment; a scratch is performed ON material, and material can
 * refuse it. Every gate below must hold:
 *
 * - The authoring profile must price the scratch family within
 *   reach (familyCosts.scratch ≤ SCRATCH_AUTHOR_MAX_FAMILY_COST).
 *   STANDARD pays exactly the ceiling — reachable, but the dearest
 *   thing it authors; ADVENTUROUS pays less; CONSERVATIVE prices
 *   the family out of its own reach and never authors one.
 * - The scratch window's audio must be WITNESSED: the graded vocal
 *   curve, or the sections' own vocal means, must cover the window
 *   with real confidence. An unwitnessed window is a closed door —
 *   the author does not guess about material it cannot hear.
 * - The window's vocal density must be LOW (mean activity ≤
 *   SCRATCH_MAX_VOCAL_ACTIVITY). Scratching across a lead vocal is
 *   the amateur tell; a scratch window is for stabs, drums and air.
 * - The window must be TRANSIENT-RICH — a drop at its edge, or an
 *   energy contour peaking well above its own mean inside it.
 *   There must be something for the hand to chop.
 *
 * Two shapes. The SCRATCH-IN scratches the INCOMING in across the
 * last beats before its entry — the classic: the entry (a drop, a
 * section start, an intro's end, via chooseEntry) is the landing,
 * and the mix hands over on it at an outgoing section boundary.
 * The SCRATCH-OUT scratches the OUTGOING across its outro's first
 * beats — inheriting the stop exits' falling-energy outro gate —
 * and hands over to the incoming's entry as the window ends.
 */
const SCRATCH_AUTHOR_MAX_FAMILY_COST = 0.5;
/** Mean graded vocal activity above which a window is a voice, not material. */
const SCRATCH_MAX_VOCAL_ACTIVITY = 0.25;
/** Energy-contour peak-to-mean ratio a window must show to count as stabby. */
const SCRATCH_TRANSIENT_PEAK_RATIO = 1.6;

interface WindowVocalReading {
  witnessed: boolean;
  /** Mean vocal activity over the window, 0..1. */
  mean: number;
}

/**
 * One window of one track's vocal evidence, for the scratch gates:
 * the graded curve first (its own confidence must clear the
 * profile's trust floor), the sections' vocal means as the coarser
 * corroborating read, and silence — unwitnessed — when neither
 * covers the window.
 */
function windowVocalReading(
  analysis: TrackAnalysis,
  startSec: number,
  endSec: number,
  profile: DecisionProfile,
): WindowVocalReading {
  const curve = analysis.vocalActivity;
  if (curve && curve.points.length > 0) {
    const points = curve.points.filter(
      (p) => p.timeSec >= startSec && p.timeSec < endSec,
    );
    if (points.length > 0) {
      const trust =
        points.reduce((sum, p) => sum + p.confidence, 0) / points.length;
      return {
        witnessed: trust >= profile.vocalTrustConfidence,
        mean: meanVocalActivity(curve, startSec, endSec),
      };
    }
  }
  const overlapping = (analysis.sections ?? []).filter(
    (s) => s.endSec > startSec && s.startSec < endSec,
  );
  if (overlapping.length > 0) {
    const span = Math.max(0, endSec - startSec);
    let covered = 0;
    let weighted = 0;
    let confidence = 0;
    for (const s of overlapping) {
      const slice = Math.min(s.endSec, endSec) - Math.max(s.startSec, startSec);
      covered += slice;
      weighted += s.vocalActivity * slice;
      confidence += s.confidence * slice;
    }
    return {
      witnessed: span > 0 && covered >= span * 0.9 && confidence / span >= 0.5,
      mean: covered > 0 ? weighted / covered : 0,
    };
  }
  return { witnessed: false, mean: 0 };
}

/**
 * Whether a window has something to chop: a drop at its edge, or
 * an energy contour whose peak inside the window stands well
 * clear of its own mean (stabs over a bed). A flat window — or a
 * window no instrument measured — is not scratch material.
 */
function windowTransientRich(
  analysis: TrackAnalysis,
  startBeat: number,
  endBeat: number,
  startSec: number,
  endSec: number,
): boolean {
  if (
    analysis.drops.some(
      (d) => d.beat >= startBeat - 0.5 && d.beat <= endBeat + 0.5,
    )
  ) {
    return true;
  }
  const bins = (analysis.energyContour ?? []).filter(
    (b) => b.timeSec >= startSec && b.timeSec < endSec,
  );
  if (bins.length < 4) return false;
  const mean = bins.reduce((sum, b) => sum + b.rms, 0) / bins.length;
  if (mean <= 0) return false;
  return (
    Math.max(...bins.map((b) => b.rms)) >= mean * SCRATCH_TRANSIENT_PEAK_RATIO
  );
}

/** The incoming's normalised energy at a beat (deriveCandidateEvidence's read). */
function entryEnergyOf(
  incoming: TrackAnalysis,
  entryBeat: number,
): number | null {
  const sections = incoming.sections ?? [];
  if (sections.length === 0) return null;
  const peak = Math.max(...sections.map((s) => s.meanRms));
  const atEntry = sections.find(
    (s) => entryBeat >= s.startBeat && entryBeat < s.endBeat,
  );
  return atEntry && peak > 0 ? atEntry.meanRms / peak : null;
}

/** Whether a chosen entry is a real landing: a drop, a section start, an intro's end. */
function entryIsLanding(incoming: TrackAnalysis, entryBeat: number): boolean {
  return (
    incoming.drops.some((d) => Math.abs(d.beat - entryBeat) <= 0.5) ||
    (incoming.sections ?? []).some(
      (s) => Math.abs(s.startBeat - entryBeat) <= 0.5,
    ) ||
    (incoming.intro
      ? Math.abs(incoming.intro.endBeat - entryBeat) <= 0.5
      : false)
  );
}

interface ScratchShape {
  technique: ScratchTechnique;
  beats: number;
  strokes: number;
  excursionBeats: number;
  clicksPerBeat?: number;
  tapsPerStroke?: number;
}

/**
 * The technique rules, stated as rules — the moment's energy and
 * the profile's temperament pick the move:
 *
 * - No witnessed entry energy, or a quiet entry (< 0.45): the
 *   BABY — the foundation move, smooth and unshowy.
 * - A mid-energy entry (0.45–0.75): the CHIRP — rhythmic gating
 *   earns its place as the energy rises.
 * - A hot entry (≥ 0.75): the FLARE under a bold profile (one that
 *   prices scratch cheap — adventurous among the shipped three),
 *   the CHIRP otherwise. The flare's clicks are the boldest tell
 *   in the family; only the bold temperament reaches for them.
 * - The TRANSFORMER is a showcase with a room requirement — a bold
 *   profile, an entry at ≥ 0.6 energy landing on a DROP, and four
 *   full beats of window. It is attempted first when its
 *   conditions hold and yields to the energy's own technique when
 *   its window refuses (the caller tries shapes in order).
 * - The CRAB is the family's most demanding telling of the same
 *   stab: a bold profile, a HOT entry (≥ 0.75) landing on a drop —
 *   its material IS the stab at the landing, so without the drop
 *   it is never attempted. In the hot drop branch it is attempted
 *   after the transformer (whose four-beat room is the rarer
 *   showcase) and before the flare (which remains the fallback
 *   when the crab's own window checks refuse). Its difficulty is
 *   expressed as this eligibility, not as a price: it spends the
 *   family's one scratch price like every technique in it. Its
 *   excursion is deliberately the family's shortest — the crab
 *   works a SHORT sound, and a wide drag smears the stab it
 *   exists to chop.
 */
function scratchShapesFor(
  profile: DecisionProfile,
  entryEnergy: number | null,
  entryIsDrop: boolean,
): ScratchShape[] {
  const baby: ScratchShape = {
    technique: "baby",
    beats: 2,
    strokes: 2,
    excursionBeats: 0.75,
  };
  const chirp: ScratchShape = {
    technique: "chirp",
    beats: 2,
    strokes: 2,
    excursionBeats: 0.75,
  };
  const flare: ScratchShape = {
    technique: "flare",
    beats: 2,
    strokes: 2,
    excursionBeats: 0.75,
  };
  const transformer: ScratchShape = {
    technique: "transformer",
    beats: 4,
    strokes: 1,
    excursionBeats: 0.4,
    clicksPerBeat: 2,
  };
  const crab: ScratchShape = {
    technique: "crab",
    beats: 2,
    strokes: 2,
    excursionBeats: 0.5,
    tapsPerStroke: 3,
  };
  const bold = profile.familyCosts.scratch <= 0.4;
  if (entryEnergy === null || entryEnergy < 0.45) return [baby];
  if (entryEnergy < 0.75) {
    return bold && entryEnergy >= 0.6 && entryIsDrop
      ? [transformer, chirp]
      : [chirp];
  }
  if (bold) return entryIsDrop ? [transformer, crab, flare] : [flare];
  return [chirp];
}

function scratchBlock(
  shape: ScratchShape,
  side: "A" | "B",
  startSec: number,
  durationSec: number,
): RecipeLoopBlock {
  return {
    type: "scratch",
    side,
    startMs: startSec * 1000,
    endMs: startSec * 1000 + durationSec * 1000,
    beats: shape.beats,
    technique: shape.technique,
    strokes: shape.strokes,
    excursionBeats: shape.excursionBeats,
    ...(shape.clicksPerBeat !== undefined
      ? { clicksPerBeat: shape.clicksPerBeat }
      : {}),
    ...(shape.tapsPerStroke !== undefined
      ? { tapsPerStroke: shape.tapsPerStroke }
      : {}),
  };
}

/**
 * The scratch-in: the incoming is performed across its last beats
 * before its entry — heard through the hand and the gate over the
 * outgoing's tail — and lands whole on the entry as the outgoing
 * leaves at its own section boundary.
 */
function authorScratchIn(
  request: RecipeRequest,
  profile: DecisionProfile,
): TransitionRecipe | null {
  if (profile.familyCosts.scratch > SCRATCH_AUTHOR_MAX_FAMILY_COST) {
    return null;
  }
  const { outgoing, incoming } = request;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  const spbA = secondsPerBeat(outMap.bpm);
  const spbB = secondsPerBeat(inMap.bpm);

  // The incoming must offer a real landing for the performance to
  // hand over TO.
  const entry = chooseEntry(incoming, profile);
  if (!entryIsLanding(incoming, entry.beat)) return null;
  const entryIsDrop = incoming.drops.some(
    (d) => Math.abs(d.beat - entry.beat) <= 0.5,
  );
  const entryEnergy = entryEnergyOf(incoming, entry.beat);
  const entrySec = timeAtBeat(inMap, entry.beat);

  // The handover moments the outgoing offers: its section ends and
  // its outro's start, strictly inside the track.
  const nowBeatA = beatsAtTime(outMap, request.outgoingPositionSec);
  const totalBeatsA = beatsAtTime(outMap, outMap.durationSec);
  const anchorSecs = [
    ...(outgoing.sections ?? []).map((s) => s.endBeat),
    ...(outgoing.outro ? [outgoing.outro.startBeat] : []),
  ]
    .filter((b) => b > nowBeatA && b < totalBeatsA)
    .map((b) => timeAtBeat(outMap, b))
    .sort((x, y) => x - y);

  for (const shape of scratchShapesFor(profile, entryEnergy, entryIsDrop)) {
    const windowSec = shape.beats * spbB;
    const startBSec = entrySec - windowSec;
    if (startBSec < 0) continue;
    // The window's material gates, on the incoming's own audio.
    const vocal = windowVocalReading(incoming, startBSec, entrySec, profile);
    if (!vocal.witnessed || vocal.mean > SCRATCH_MAX_VOCAL_ACTIVITY) continue;
    if (
      !windowTransientRich(
        incoming,
        entry.beat - shape.beats,
        entry.beat,
        startBSec,
        entrySec,
      )
    ) {
      continue;
    }
    // The earliest anchor that still leaves the profile's full
    // lead before the performance begins.
    const anchorSec = anchorSecs.find(
      (sec) =>
        sec - windowSec >=
        request.outgoingPositionSec + profile.minLeadBeats * spbA,
    );
    if (anchorSec === undefined) continue;
    const durationMs = windowSec * 1000;

    return ownJoin(request, {
      preset: "cut",
      startASec: anchorSec - windowSec,
      startBSec,
      durationMs,
      automation: {
        // A plays on at full level under the performance; B rises
        // quickly to its performance level, is heard through the
        // hand and the gate for the whole window, and lands whole
        // on its entry as A leaves.
        volumeOut: curve("linear-gain", "linear", [
          [0, 1],
          [durationMs, 1],
          [durationMs, 0],
        ]),
        volumeIn: curve("linear-gain", "linear", [
          [0, 0],
          [Math.min(40, durationMs / 4), 0.9],
          [durationMs, 0.9],
          [durationMs, 1],
        ]),
        eqOut: { low: flatEq(), mid: flatEq(), high: flatEq() },
        eqIn: { low: flatEq(), mid: flatEq(), high: flatEq() },
        filterOut: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
        filterIn: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
        rateB: flatCurve("rate", "ratio", 1),
        echoSendOut: flatCurve("dry-wet", "percent", 0),
        echoSendIn: flatCurve("dry-wet", "percent", 0),
      },
      loops: [scratchBlock(shape, "B", startBSec, windowSec)],
      entryReason: entry.reason,
      exitReason: `the incoming is scratched in — a ${shape.technique} across its last ${shape.beats} beats, over witnessed low-vocal material, landing on its entry`,
    });
  }
  return null;
}

/**
 * The scratch-out: the outgoing is performed across its outro's
 * first beats and then leaves, handing over to the incoming's
 * entry. On the way out the family stays close to the ground — a
 * hot landing earns the chirp's rhythm; anything quieter gets the
 * baby's smooth hand.
 */
function authorScratchOut(
  request: RecipeRequest,
  profile: DecisionProfile,
): TransitionRecipe | null {
  if (profile.familyCosts.scratch > SCRATCH_AUTHOR_MAX_FAMILY_COST) {
    return null;
  }
  const { outgoing, incoming } = request;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  if (!outgoing.outro) return null;
  const spbA = secondsPerBeat(outMap.bpm);

  const exitBeat = outgoing.outro.startBeat;
  const exitSec = timeAtBeat(outMap, exitBeat);
  const windowBeats = 2;
  const windowSec = windowBeats * spbA;
  // The window sits at the outro's head: not already upon us, and
  // the outro must have room for it.
  if (exitSec < request.outgoingPositionSec + profile.minLeadBeats * spbA) {
    return null;
  }
  const outroBeats = beatsAtTime(outMap, outMap.durationSec) - exitBeat;
  if (outroBeats < windowBeats) return null;

  // Energy must be falling into the outro — the stop exits' gate,
  // inherited whole.
  const sections = outgoing.sections ?? [];
  const outroSection =
    sections.find((s) => s.kind === "outro") ??
    sections.find((s) => exitSec >= s.startSec && exitSec < s.endSec);
  const before = sections
    .filter((s) => s.kind !== "outro" && s.endSec <= exitSec + 1e-6)
    .pop();
  if (outroSection && before) {
    if (outroSection.meanRms > before.meanRms) return null;
  } else if (!outroSection) {
    if (outroBeats > UNWITNESSED_OUTRO_MAX_BEATS) return null;
  }

  // The window's material gates, on the outgoing's own audio.
  const vocal = windowVocalReading(
    outgoing,
    exitSec,
    exitSec + windowSec,
    profile,
  );
  if (!vocal.witnessed || vocal.mean > SCRATCH_MAX_VOCAL_ACTIVITY) return null;
  if (
    !windowTransientRich(
      outgoing,
      exitBeat,
      exitBeat + windowBeats,
      exitSec,
      exitSec + windowSec,
    )
  ) {
    return null;
  }

  // The incoming must offer a real landing for the handover.
  const entry = chooseEntry(incoming, profile);
  if (!entryIsLanding(incoming, entry.beat)) return null;
  const entrySec = timeAtBeat(inMap, entry.beat);
  // B starts early and silent (the stop exits' geometry), so its
  // entry lands exactly as the scratch window ends.
  const startBSec = entrySec - windowSec;
  if (startBSec < 0) return null;

  const entryEnergy = entryEnergyOf(incoming, entry.beat);
  const shape: ScratchShape = {
    technique: entryEnergy !== null && entryEnergy >= 0.6 ? "chirp" : "baby",
    beats: windowBeats,
    strokes: 2,
    excursionBeats: 0.75,
  };
  const durationMs = windowSec * 1000;

  return ownJoin(request, {
    preset: "cut",
    startASec: exitSec,
    startBSec,
    durationMs,
    automation: {
      // A plays at full level THROUGH the scratch — the hand and
      // the gate are the sound — and is gone at its end; B is
      // silent until the window completes, then arrives whole.
      volumeOut: curve("linear-gain", "linear", [
        [0, 1],
        [durationMs, 1],
        [durationMs, 0],
      ]),
      volumeIn: curve("linear-gain", "linear", [
        [0, 0],
        [durationMs, 0],
        [durationMs, 1],
      ]),
      eqOut: { low: flatEq(), mid: flatEq(), high: flatEq() },
      eqIn: { low: flatEq(), mid: flatEq(), high: flatEq() },
      filterOut: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      filterIn: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      rateB: flatCurve("rate", "ratio", 1),
      echoSendOut: flatCurve("dry-wet", "percent", 0),
      echoSendIn: flatCurve("dry-wet", "percent", 0),
    },
    loops: [scratchBlock(shape, "A", exitSec, windowSec)],
    entryReason: entry.reason,
    exitReason: `the outgoing is scratched out — a ${shape.technique} across its outro's first beats, over witnessed low-vocal material, handed to the incoming's entry`,
  });
}

// ---------------------------------------------------------------------
// The manual authors (the DJ stage engine seams)
// ---------------------------------------------------------------------

/**
 * The R1 stop moves and R2 scratches authored for the HOST's
 * hand, on the stage's trigger. A manual trigger is the host's
 * deliberate act — spec Addendum A: the stage is the host's, and
 * a user intervention always stands — so the moment gates the
 * brain's own authors obey do NOT apply here: no price gate (a
 * profile may price a family out of the BRAIN's reach; the host's
 * hand is not the brain), no outro requirement, no falling-energy
 * gate, no minimum-play floor (the floor binds the DJ only), and
 * no lottery. The exit is HERE, at the position the hand fires
 * from.
 *
 * What still gates, because it is structural or material, not
 * taste:
 * - The incoming must offer a real landing (entryIsLanding) for
 *   the move to hand over TO, and B must be able to start early
 *   and silent so its entry lands as the move completes
 *   (startBSec ≥ 0) — the stop exits' geometry, unchanged.
 * - A spinback needs its runway behind the stop point, or the
 *   record would run off the track's start.
 * - A scratch is performed ON material: the window the hand
 *   would touch must be witnessed, low-vocal and transient-rich
 *   — the R2 material gates, unchanged. Material can refuse the
 *   host exactly as it refuses the brain; scratching across a
 *   lead vocal is not the host's intent either, it is an accident
 *   the engine can prevent.
 * - The window must fit inside the outgoing: a move that would
 *   end past the track's end cannot be performed as written.
 *
 * The recipes are the brain's own shapes — same blocks, same
 * automation, same ownJoin — so the executor performs a manual
 * move through exactly the path it performs an authored one, and
 * validateRecipe still has the last word (the brain checks it
 * before the decision stands).
 */
export type ManualDeckMove =
  "brake" | "vinyl-stop" | "spinback" | ScratchTechnique;

/** The stop moves a manual trigger can name. */
export type ManualStopMove = "brake" | "vinyl-stop" | "spinback";

export function isManualStopMove(move: ManualDeckMove): move is ManualStopMove {
  return move === "brake" || move === "vinyl-stop" || move === "spinback";
}

/**
 * A stop exit authored for the host's hand: the outgoing is
 * stopped DEAD here — at the position the trigger fires from —
 * braked, vinyl-stopped or spun back, and the incoming lands its
 * entry exactly as the stop completes. The technique is the one
 * the host named: unlike authorStopExit, the tail's length does
 * not get a vote.
 */
export function authorManualStopExit(
  request: RecipeRequest,
  profile: DecisionProfile,
  move: ManualStopMove,
): TransitionRecipe | null {
  const { outgoing, incoming } = request;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  const spbA = secondsPerBeat(outMap.bpm);
  const exitSec = request.outgoingPositionSec;

  const beats =
    move === "spinback"
      ? SPINBACK_BEATS
      : move === "brake"
        ? BRAKE_BEATS
        : VINYL_STOP_BEATS;
  const durationMs = beats * spbA * 1000;
  const durationSec = durationMs / 1000;
  // The move must fit inside the outgoing: past the track's end
  // there is nothing left to stop.
  if (exitSec + durationSec > outMap.durationSec) return null;

  if (move === "spinback") {
    // The record runs backwards at an average |rate| of ~2.5 over
    // the spin: the stop point needs that much track behind it,
    // plus a margin, or the spin would run off the track's start.
    if (exitSec < durationSec * 2.5 + 2) return null;
  }

  // The incoming must offer a real landing for the stop to hand to.
  const entry = chooseEntry(incoming, profile);
  if (!entryIsLanding(incoming, entry.beat)) return null;

  // B starts early and silent, so its entry beat lands exactly as
  // the stop completes.
  const startBSec = timeAtBeat(inMap, entry.beat) - durationSec;
  if (startBSec < 0) return null;

  const block: RecipeLoopBlock =
    move === "spinback"
      ? {
          type: "spinback",
          side: "A",
          startMs: exitSec * 1000,
          endMs: exitSec * 1000 + durationMs,
          beats,
          peakRate: SPINBACK_PEAK_RATE,
        }
      : {
          type: move,
          side: "A",
          startMs: exitSec * 1000,
          endMs: exitSec * 1000 + durationMs,
          beats,
        };

  return ownJoin(request, {
    preset: "cut",
    startASec: exitSec,
    startBSec,
    durationMs,
    automation: {
      // A plays at full level THROUGH the stop — the rate fall is
      // the sound — and is gone at its end; B is silent until the
      // stop completes, then arrives whole.
      volumeOut: curve("linear-gain", "linear", [
        [0, 1],
        [durationMs, 1],
        [durationMs, 0],
      ]),
      volumeIn: curve("linear-gain", "linear", [
        [0, 0],
        [durationMs, 0],
        [durationMs, 1],
      ]),
      eqOut: { low: flatEq(), mid: flatEq(), high: flatEq() },
      eqIn: { low: flatEq(), mid: flatEq(), high: flatEq() },
      filterOut: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      filterIn: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      rateB: flatCurve("rate", "ratio", 1),
      echoSendOut: flatCurve("dry-wet", "percent", 0),
      echoSendIn: flatCurve("dry-wet", "percent", 0),
    },
    loops: [block],
    entryReason: entry.reason,
    exitReason:
      move === "spinback"
        ? "the host spun the outgoing back, by hand, from here — a manual stop exit, handed to the incoming's entry"
        : move === "brake"
          ? "the host braked the outgoing to a stop, by hand, from here — a manual stop exit, handed to the incoming's entry"
          : "the host vinyl-stopped the outgoing, by hand, from here — a manual stop exit, handed to the incoming's entry",
  });
}

/** The window each scratch technique works, in the R2 authors' own shapes. */
const MANUAL_SCRATCH_SHAPES: Record<ScratchTechnique, ScratchShape> = {
  baby: { technique: "baby", beats: 2, strokes: 2, excursionBeats: 0.75 },
  chirp: { technique: "chirp", beats: 2, strokes: 2, excursionBeats: 0.75 },
  flare: { technique: "flare", beats: 2, strokes: 2, excursionBeats: 0.75 },
  transformer: {
    technique: "transformer",
    beats: 4,
    strokes: 1,
    excursionBeats: 0.4,
    clicksPerBeat: 2,
  },
  crab: {
    technique: "crab",
    beats: 2,
    strokes: 2,
    excursionBeats: 0.5,
    tapsPerStroke: 3,
  },
};

/**
 * A scratch authored for the host's hand, in the scratch-out's
 * geometry: the named technique is performed on the outgoing
 * starting HERE, across its window, and the incoming lands its
 * entry as the window ends. The technique is the one the host
 * named — no energy read gets to substitute another — but the
 * window's material gates stand exactly as the R2 authors wrote
 * them: witnessed, low-vocal, transient-rich, or no scratch.
 */
export function authorManualScratch(
  request: RecipeRequest,
  profile: DecisionProfile,
  technique: ScratchTechnique,
): TransitionRecipe | null {
  const { outgoing, incoming } = request;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  const spbA = secondsPerBeat(outMap.bpm);
  const shape = MANUAL_SCRATCH_SHAPES[technique];
  const startSec = request.outgoingPositionSec;
  const windowSec = shape.beats * spbA;
  const endSec = startSec + windowSec;
  // The window must fit inside the outgoing.
  if (endSec > outMap.durationSec) return null;

  // The window's material gates, on the outgoing's own audio —
  // the material the host's hand would actually touch.
  const vocal = windowVocalReading(outgoing, startSec, endSec, profile);
  if (!vocal.witnessed || vocal.mean > SCRATCH_MAX_VOCAL_ACTIVITY) return null;
  const startBeat = beatsAtTime(outMap, startSec);
  if (
    !windowTransientRich(
      outgoing,
      startBeat,
      startBeat + shape.beats,
      startSec,
      endSec,
    )
  ) {
    return null;
  }

  // The incoming must offer a real landing for the handover.
  const entry = chooseEntry(incoming, profile);
  if (!entryIsLanding(incoming, entry.beat)) return null;
  const entrySec = timeAtBeat(inMap, entry.beat);
  // B starts early and silent (the stop exits' geometry), so its
  // entry lands exactly as the scratch window ends.
  const startBSec = entrySec - windowSec;
  if (startBSec < 0) return null;

  const durationMs = windowSec * 1000;
  return ownJoin(request, {
    preset: "cut",
    startASec: startSec,
    startBSec,
    durationMs,
    automation: {
      // A plays at full level THROUGH the scratch — the hand and
      // the gate are the sound — and is gone at its end; B is
      // silent until the window completes, then arrives whole.
      volumeOut: curve("linear-gain", "linear", [
        [0, 1],
        [durationMs, 1],
        [durationMs, 0],
      ]),
      volumeIn: curve("linear-gain", "linear", [
        [0, 0],
        [durationMs, 0],
        [durationMs, 1],
      ]),
      eqOut: { low: flatEq(), mid: flatEq(), high: flatEq() },
      eqIn: { low: flatEq(), mid: flatEq(), high: flatEq() },
      filterOut: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      filterIn: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      rateB: flatCurve("rate", "ratio", 1),
      echoSendOut: flatCurve("dry-wet", "percent", 0),
      echoSendIn: flatCurve("dry-wet", "percent", 0),
    },
    loops: [scratchBlock(shape, "A", startSec, windowSec)],
    entryReason: entry.reason,
    exitReason: `the host scratched the outgoing out by hand — a ${technique} across ${shape.beats} beats from here, over witnessed low-vocal material, handed to the incoming's entry`,
  });
}

// ---------------------------------------------------------------------
// The effect dressings (the revamp's R3)
// ---------------------------------------------------------------------

/**
 * The effect author: the effects rack — reverb, delay, flanger,
 * phaser, distortion, spiral, trans, roll — as DRESSINGS on a join
 * the author already made, never as standalone joins. A variant is
 * a shallow clone of its base with fx / effects replaced and the
 * exit reason extended: the base's automation, loops and geometry
 * are shared untouched, because a chain is a filter-fade's curves
 * INTO a delay block INTO a reverb tail — composition, not
 * replacement. Most pairs earn no dressing at all; every gate
 * below must hold for the variant it guards:
 *
 * - Price: the profile must price the fx family within reach
 *   (familyCosts.fx ≤ FX_AUTHOR_MAX_FAMILY_COST). STANDARD and
 *   ADVENTUROUS author dressings; CONSERVATIVE prices the rack out
 *   of its own reach, mirroring its scratch / stop stance.
 * - Host: only blends and the two fades carry a dressing. Theatre
 *   never stacks on theatre (no fx on scratch / stop joins),
 *   restraint stays restrained (no fx on let-it-play / early-cut /
 *   section-swap), and a loop-extended base is already dressed.
 * - Anchor: the base must name its A anchor and span real time.
 * - The distant-key guard: scoring's distant-key veto is scoped to
 *   the blend families, and a dressing performs the SAME blend as
 *   its base while reading family "fx" — so without this gate a
 *   dressed join would escape a veto its own base receives. The
 *   author does not dress a join the scorer would refuse as a
 *   blend: a vetoed blend stays vetoed, dressed or not. (The other
 *   vetoes are family-blind and share the base's evidence, so they
 *   already fall on the dressing exactly as on the base.)
 * - Vocal witness, in two classes, read by the scratch gates'
 *   instrument (windowVocalReading). The WASH class (reverb, delay,
 *   spiral, flanger, phaser) ADDS sound around the voice, so its
 *   windows may carry a witnessed mean up to
 *   FX_WASH_MAX_VOCAL_ACTIVITY. The STRICT class (trans, roll,
 *   distortion) cuts or crushes the dry signal itself, so its
 *   windows answer to the scratch gates' stricter bound. An
 *   unwitnessed window earns nothing in either class.
 *
 * Four variants, returned in this order:
 *
 * - TAIL (side A, over the overlap in A's time): the outgoing's
 *   exit, dressed by its own energy there. A quiet exit (or none
 *   witnessed) earns a REVERB tail alone; a mid-energy exit earns
 *   the CHAIN — one beat of delay into the same reverb; a hot exit
 *   earns the SPIRAL when its window is quiet-voiced enough for
 *   the sweep to read (a stricter gate of its own), and falls back
 *   to the chain when it is not.
 * - WASH (side B, over the overlap in B's time): the incoming's
 *   arrival. A hot entry earns the FLANGER's motion; a quieter one
 *   the PHASER's slower sweep.
 * - CHOP (side A, over the window ENDING at the handover — the
 *   outgoing's last bars alone, before the join begins):
 *   transient-rich material earns the ROLL's stutter, flat material
 *   the TRANS gate's chop. The window must not already be upon us:
 *   the executor schedules from the call moment, and a window in
 *   the past cannot be performed.
 * - GRIT (side B, over the wash's span): DISTORTION on a drop
 *   landing — only at a genuinely loud entry, and only a bold
 *   profile reaches for it below the loudest entries.
 */
const FX_AUTHOR_MAX_FAMILY_COST = 0.5;
/** Mean vocal activity a wash-class window may carry — it adds sound AROUND a voice. */
const FX_WASH_MAX_VOCAL_ACTIVITY = 0.6;
/** Mean vocal activity above which even a hot exit falls back from the spiral to the chain. */
const FX_SPIRAL_MAX_VOCAL_ACTIVITY = 0.35;
/** The fx price at or below which a profile counts as bold for the grit gate. */
const FX_GRIT_BOLD_MAX_FAMILY_COST = 0.35;
/** Entry energy at or above which even a cautious profile's entry earns grit. */
const FX_GRIT_UNIVERSAL_ENTRY_ENERGY = 0.8;

const FX_HOST_FAMILIES: ReadonlySet<JoinFamily> = new Set([
  "long-blend",
  "standard-blend",
  "short-blend",
  "echo-out",
  "filter-fade",
]);

function authorEffectVariants(
  base: TransitionRecipe,
  request: RecipeRequest,
  profile: DecisionProfile,
): TransitionRecipe[] {
  if (profile.familyCosts.fx > FX_AUTHOR_MAX_FAMILY_COST) return [];
  if (!FX_HOST_FAMILIES.has(familyOfRecipe(base))) return [];
  const startAMs = base.overlap.startAMs;
  if (startAMs === null || !(base.overlap.durationMs > 0)) return [];

  const { outgoing, incoming } = request;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;

  // The distant-key guard (see the header): the relation counts
  // only when both key confidences clear the spend floor, exactly
  // as deriveCandidateEvidence reads it, and the blend's length is
  // the family reader's own formula.
  const keyFit = keyCompatibility(outgoing.key, incoming.key);
  const keyConfidence =
    outgoing.key && incoming.key
      ? Math.min(outgoing.key.confidence, incoming.key.confidence)
      : null;
  const blendBeats =
    (base.overlap.durationMs / 1000) * (base.overlap.bpmA / 60);
  if (
    keyFit &&
    keyConfidence !== null &&
    keyConfidence >= KEY_SPEND_CONFIDENCE &&
    keyFit.relation === "distant" &&
    blendBeats > profile.distantKeyMaxBlendBeats
  ) {
    return [];
  }

  const durationMs = base.overlap.durationMs;
  const durationSec = durationMs / 1000;
  const startASec = startAMs / 1000;
  const startBMs = base.overlap.startBMs;
  const startBSec = startBMs / 1000;
  const rateB = base.overlap.rateB;
  const spbA = secondsPerBeat(outMap.bpm);
  const spbB = secondsPerBeat(inMap.bpm);

  const dress = (
    fx: RecipeFx,
    effects: RecipeEffectBlock[],
    dressing: string,
  ): TransitionRecipe => ({
    ...base,
    fx,
    effects,
    evidence: {
      ...base.evidence,
      exitReason: `${base.evidence.exitReason} — ${dressing}`,
    },
  });

  // ---- the tail (side A, over the overlap in A's time) ----
  let tail: TransitionRecipe | null = null;
  const tailBeats = durationSec / spbA;
  if (tailBeats >= 4) {
    const vocal = windowVocalReading(
      outgoing,
      startASec,
      startASec + durationSec,
      profile,
    );
    if (vocal.witnessed && vocal.mean <= FX_WASH_MAX_VOCAL_ACTIVITY) {
      const exitEnergy = entryEnergyOf(
        outgoing,
        beatsAtTime(outMap, startASec),
      );
      const window = {
        side: "A" as const,
        startMs: startAMs,
        endMs: startAMs + durationMs,
        beats: tailBeats,
      };
      if (exitEnergy === null || exitEnergy < 0.4) {
        tail = dress(
          { reverb: { decaySec: 1.8, wet: 0.55 } },
          [{ kind: "reverb", ...window, level: 0.5 }],
          "the outgoing leaves through a reverb tail",
        );
      } else if (
        exitEnergy >= 0.65 &&
        vocal.mean <= FX_SPIRAL_MAX_VOCAL_ACTIVITY
      ) {
        tail = dress(
          {
            spiral: {
              delaySec: spbA / 2,
              sweepToRatio: 0.5,
              feedback: 0.45,
              wet: 0.5,
            },
          },
          [{ kind: "spiral", ...window, level: 0.4 }],
          "the outgoing leaves through a spiralling delay",
        );
      } else {
        tail = dress(
          {
            delay: { delaySec: spbA, feedback: 0.35, wet: 0.5 },
            reverb: { decaySec: 1.8, wet: 0.55 },
            chainDelayIntoReverb: true,
          },
          [
            { kind: "delay", ...window, level: 0.45 },
            { kind: "reverb", ...window, level: 0.5 },
          ],
          "the outgoing leaves through a delay chained into reverb",
        );
      }
    }
  }

  // ---- the wash and the grit share B's overlap span ----
  const bSpanMs = durationMs * rateB;
  const bSpanSec = bSpanMs / 1000;
  const bEndSec = startBSec + bSpanSec;
  const bBeats = bSpanSec / spbB;
  const bWindow = {
    side: "B" as const,
    startMs: startBMs,
    endMs: startBMs + bSpanMs,
    beats: bBeats,
  };
  const vocalB = windowVocalReading(incoming, startBSec, bEndSec, profile);
  const entryBeatB = beatsAtTime(inMap, bEndSec);
  const entryEnergyB = entryEnergyOf(incoming, entryBeatB);

  // ---- the wash (side B, over the overlap in B's time) ----
  let wash: TransitionRecipe | null = null;
  if (
    bBeats >= 4 &&
    vocalB.witnessed &&
    vocalB.mean <= FX_WASH_MAX_VOCAL_ACTIVITY
  ) {
    wash =
      (entryEnergyB ?? 0) >= 0.5
        ? dress(
            {
              flanger: { rateHz: 0.3, depthMs: 1.2, feedback: 0.3, wet: 0.5 },
            },
            [{ kind: "flanger", ...bWindow, level: 0.35 }],
            "the incoming arrives through a flanger wash",
          )
        : dress(
            { phaser: { rateHz: 0.18, depth: 0.7, wet: 0.5 } },
            [{ kind: "phaser", ...bWindow, level: 0.35 }],
            "the incoming arrives through a phaser wash",
          );
  }

  // ---- the chop (side A, ending at the handover) ----
  let chop: TransitionRecipe | null = null;
  const chopWindow = (beats: number): { startSec: number; startMs: number } => {
    const startSec = startASec - beats * spbA;
    return { startSec, startMs: startAMs - beats * spbA * 1000 };
  };
  const chopGatesPass = (startSec: number): boolean => {
    if (startSec < request.outgoingPositionSec + 0.3) return false;
    const vocal = windowVocalReading(outgoing, startSec, startASec, profile);
    return vocal.witnessed && vocal.mean <= SCRATCH_MAX_VOCAL_ACTIVITY;
  };
  const rollWindow = chopWindow(2);
  if (
    chopGatesPass(rollWindow.startSec) &&
    windowTransientRich(
      outgoing,
      beatsAtTime(outMap, rollWindow.startSec),
      beatsAtTime(outMap, startASec),
      rollWindow.startSec,
      startASec,
    )
  ) {
    chop = dress(
      { roll: { sliceBeats: 0.5, feedback: 0.94 } },
      [
        {
          kind: "roll",
          side: "A",
          startMs: rollWindow.startMs,
          endMs: startAMs,
          beats: 2,
          level: 0.8,
        },
      ],
      "the outgoing's last beats are rolled before the handover",
    );
  } else {
    const transWindow = chopWindow(4);
    if (chopGatesPass(transWindow.startSec)) {
      chop = dress(
        { trans: { divisionBeats: 0.5, depth: 0.85 } },
        [
          {
            kind: "trans",
            side: "A",
            startMs: transWindow.startMs,
            endMs: startAMs,
            beats: 4,
            level: 1,
          },
        ],
        "the outgoing's last bars are chopped by a trans gate before the handover",
      );
    }
  }

  // ---- the grit (side B, over the wash's span) ----
  let grit: TransitionRecipe | null = null;
  const entryIsDrop =
    entryIsLanding(incoming, entryBeatB) &&
    incoming.drops.some((d) => Math.abs(d.beat - entryBeatB) <= 0.5);
  if (
    entryIsDrop &&
    entryEnergyB !== null &&
    entryEnergyB >= 0.65 &&
    (profile.familyCosts.fx <= FX_GRIT_BOLD_MAX_FAMILY_COST ||
      entryEnergyB >= FX_GRIT_UNIVERSAL_ENTRY_ENERGY) &&
    vocalB.witnessed &&
    vocalB.mean <= SCRATCH_MAX_VOCAL_ACTIVITY
  ) {
    grit = dress(
      { distortion: { amount: 0.65, wet: 0.55 } },
      [{ kind: "distortion", ...bWindow, level: 0.5 }],
      "the incoming lands with distortion grit on its entry",
    );
  }

  return [tail, wash, chop, grit].filter(
    (variant): variant is TransitionRecipe => variant !== null,
  );
}

// ---------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------

function signatureOf(recipe: TransitionRecipe): string {
  const o = recipe.overlap;
  const loops = recipe.loops
    .map(
      (l) =>
        `${l.type}:${l.technique ?? ""}:${l.strokes ?? ""}:${l.tapsPerStroke ?? ""}:${Math.round(l.startMs)}-${Math.round(l.endMs)}`,
    )
    .join(",");
  // The dressing is part of the plan: two dressings of the same
  // base are different joins and must never collapse into one
  // candidate, while identical dressings under several profiles
  // still collapse to their first telling.
  const effects = (recipe.effects ?? [])
    .map(
      (e) =>
        `${e.kind}:${e.side}:${Math.round(e.startMs)}-${Math.round(e.endMs)}`,
    )
    .join(",");
  return [
    recipe.preset,
    o.startAMs === null ? "null" : Math.round(o.startAMs),
    Math.round(o.startBMs),
    Math.round(o.durationMs),
    o.rateB.toFixed(4),
    // The same geometry performed by rate and by rendition are two
    // different joins (different cost, different sound) — they must
    // never collapse into one candidate.
    o.stretchB === null ? "rate" : `stretch:${o.stretchB.toFixed(4)}`,
    loops,
    effects,
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

  // The author's own answer under each temperament — and, with
  // R3, the effect dressings that answer earns under the same
  // temperament (authorEffectVariants' gates decide; identical
  // dressings under several profiles collapse by signature).
  for (const profile of profiles) {
    const base = authorRecipe({ ...request, profile });
    push(base, `author:${profile.id}`, profile.id);
    if (base) {
      for (const variant of authorEffectVariants(base, request, profile)) {
        push(variant, `fx:${profile.id}`, profile.id, "fx");
      }
    }
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

  // The stop exits (R1): authored under every profile that prices
  // them within reach — the gates inside authorStopExit decide;
  // identical tellings under several profiles collapse by signature.
  for (const profile of profiles) {
    push(
      authorStopExit(request, profile, "spinback"),
      `family:spinback:${profile.id}`,
      profile.id,
      "spinback",
    );
    push(
      authorStopExit(request, profile, "vinyl-stop"),
      `family:vinyl-stop:${profile.id}`,
      profile.id,
      "vinyl-stop",
    );
  }

  // The scratch joins (R2): authored under every profile that
  // prices the family within reach — the material gates inside the
  // authors decide; identical tellings under several profiles
  // collapse by signature.
  for (const profile of profiles) {
    push(
      authorScratchIn(request, profile),
      `family:scratch-in:${profile.id}`,
      profile.id,
      "scratch",
    );
    push(
      authorScratchOut(request, profile),
      `family:scratch-out:${profile.id}`,
      profile.id,
      "scratch",
    );
  }

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
