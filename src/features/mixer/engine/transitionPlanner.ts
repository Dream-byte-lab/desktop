import type { TrackAnalysis } from "./analyseTrack";
import {
  beatsAtTime,
  phraseBeats,
  secondsPerBeat,
  timeAtBeat,
  type BeatMap,
} from "./beatMap";
import type { KeyEstimate } from "./detectKey";
import {
  meanVocalActivity,
  overlapsVocals,
  type VocalActivityCurve,
  type VocalRange,
} from "./detectVocals";
import {
  resolveProfile,
  STANDARD_PROFILE,
  withinStretchCeilings,
  type DecisionProfile,
} from "./decisionProfile";
import { keyCompatibility, type KeyCompatibility } from "./keyCompatibility";
import {
  flatCurve,
  FULL_BASS_CUT_DB,
  OPEN_FILTER_HZ,
  type AutomationCurve,
  type AutomationPoint,
  type EqCurves,
  type TransitionRecipe,
} from "./recipe";

// Plans one beatmatched blend between the track that is playing and the
// track that comes next. Pure arithmetic on beat maps — no audio, no clock —
// so every rule a DJ would apply by ear is written down and testable:
//
// - the blend starts on a phrase boundary of the outgoing track, never
//   mid-phrase, and never so soon that it cannot be scheduled safely;
// - the incoming track is tempo-matched to the outgoing one for the length
//   of the blend, and its chosen entry beat (its drop, or the first strong
//   beat of a section) lands exactly on a phrase boundary as the blend ends;
// - the bass swap happens on a bar boundary partway through the blend, so
//   only one track owns the low end at any moment;
// - after the blend, the incoming track glides back to its natural tempo.
//
// Returns null when no honest blend exists from here (the outgoing track is
// nearly over, or the incoming entry point cannot be reached) — the caller
// is then expected to fall back to a cut or an echo-out instead of forcing
// a bad mix.

export interface TransitionRequest {
  outgoing: BeatMap;
  /** Where the outgoing track is playing right now, in track seconds. */
  outgoingPositionSec: number;
  incoming: BeatMap;
  /**
   * Beat of the incoming track that must land on the phrase boundary at the
   * end of the blend — usually its drop or the first beat after its intro.
   */
  incomingEntryBeat: number;
  /** Desired blend length in beats. Defaults to 16. */
  blendBeats?: number;
  /** Bars per phrase on the outgoing track. Defaults to 4. */
  phraseBars?: number;
  /** The blend may not start sooner than this many beats from now. Defaults to 8. */
  minLeadBeats?: number;
  /**
   * Largest tempo stretch, as a fraction (0.08 = 8%), still considered a
   * comfortable beatmatch. Larger stretches are planned but flagged.
   */
  tempoTolerance?: number;
  /** Estimated keys, when the analyser produced them — used for the plan's harmonic report. */
  outgoingKey?: KeyEstimate | null;
  incomingKey?: KeyEstimate | null;
  /**
   * When true, a harmonically clashing pair gets no blend (null), so
   * the caller falls back to a cut or echo-out. Off by default: a clash
   * is reported on the plan, not treated as fatal.
   */
  requireKeyCompatibility?: boolean;
  /** Where each track's vocals are, when the analyser found them. */
  outgoingVocals?: VocalRange[];
  incomingVocals?: VocalRange[];
}

export interface TransitionPlan {
  /** Actual blend length in beats (may be shorter than requested). */
  blendBeats: number;
  /** Seconds from now until the incoming track starts playing. */
  startsInSec: number;
  /** Length of the overlap, in seconds. */
  blendDurationSec: number;
  /** Beat index in the outgoing track where the blend starts. */
  outgoingExitBeat: number;
  /** Beat index in the outgoing track where it stops. */
  outgoingEndBeat: number;
  /** Track time, in seconds, where the incoming track starts playing. */
  incomingStartSec: number;
  /** The incoming entry beat this plan was built around. */
  incomingEntryBeat: number;
  /** Playback rate for the incoming track during the blend. */
  incomingRate: number;
  /** How far the incoming tempo is stretched, as a fraction (0.05 = 5%). */
  tempoStretch: number;
  /** False when the stretch exceeds the comfortable tolerance. */
  tempoComfortable: boolean;
  /** Beats into the blend at which the bass swaps to the incoming track. */
  bassSwapBeatOffset: number;
  /** Seconds from now at which the bass swap happens. */
  bassSwapInSec: number;
  /** Seconds the incoming track takes to glide back to rate 1 afterwards. */
  rateReturnDurationSec: number;
  /** Harmonic fit of the pair, when both keys are known. */
  keyCompatibility: KeyCompatibility | null;
  /**
   * True when BOTH tracks are singing during the blend — the one
   * overlap listeners always hear. False when either side is
   * instrumental through the blend, or when vocals are unknown.
   */
  vocalOverlap: boolean;
}

const MIN_BLEND_BEATS = 4;
const EPSILON = 1e-9;

export function planTransition(
  request: TransitionRequest,
): TransitionPlan | null {
  const { outgoing, incoming } = request;
  const requestedBlend = request.blendBeats ?? 16;
  const minLead = request.minLeadBeats ?? 8;
  const tolerance = request.tempoTolerance ?? 0.08;
  const bars = request.phraseBars ?? 4;

  const spbOut = secondsPerBeat(outgoing.bpm);
  const spbIn = secondsPerBeat(incoming.bpm);
  const phrase = phraseBeats(outgoing, bars);
  const nowBeat = beatsAtTime(outgoing, request.outgoingPositionSec);

  // The blend cannot run the outgoing track past its own end. Start from
  // the first phrase boundary far enough ahead of now, and walk backwards
  // a phrase at a time while the blend would overrun the track.
  let exitBeat = Math.ceil((nowBeat + minLead - EPSILON) / phrase) * phrase;
  let blend = requestedBlend;
  while (
    exitBeat > nowBeat &&
    timeAtBeat(outgoing, exitBeat + blend) > outgoing.durationSec + EPSILON
  ) {
    exitBeat -= phrase;
  }
  if (timeAtBeat(outgoing, exitBeat + blend) > outgoing.durationSec + EPSILON) {
    return null;
  }
  if (exitBeat - nowBeat < 1) return null;

  // Walking back `blend` beats from the entry beat must not land before
  // the start of the incoming file. Those beats are measured in the
  // incoming track's own time — at the matched playback rate they take
  // exactly the blend's wall-clock length, but the position inside the
  // file is counted with the incoming track's own seconds-per-beat.
  const incomingStartSec = () =>
    incoming.firstBeatSec + (request.incomingEntryBeat - blend) * spbIn;
  while (blend > MIN_BLEND_BEATS && incomingStartSec() < 0) {
    blend -= 1;
  }
  if (incomingStartSec() < -EPSILON) return null;

  // The entry beat itself must exist inside the incoming track.
  const entryTimeSec = timeAtBeat(incoming, request.incomingEntryBeat);
  if (entryTimeSec >= incoming.durationSec) return null;

  const incomingRate = outgoing.bpm / incoming.bpm;
  const tempoStretch = Math.abs(incomingRate - 1);

  // Bass swap on the bar boundary nearest the middle of the blend.
  const halfBars = Math.floor(blend / 2 / outgoing.beatsPerBar);
  const bassSwapBeatOffset = Math.max(
    outgoing.beatsPerBar,
    halfBars * outgoing.beatsPerBar,
  );

  const startsInSec =
    timeAtBeat(outgoing, exitBeat) - request.outgoingPositionSec;
  const blendDurationSec = blend * spbOut;

  const keyFit = keyCompatibility(
    request.outgoingKey ?? null,
    request.incomingKey ?? null,
  );
  if (request.requireKeyCompatibility && keyFit && !keyFit.compatible) {
    return null;
  }

  // The blend windows in each track's own time: the outgoing side from
  // its exit beat to its end beat; the incoming side from where it
  // starts to the track-time it consumes during the blend (its wall
  // clock length stretched by the matched rate).
  const blendStartSec = Math.max(0, incomingStartSec());
  const vocalOverlap =
    overlapsVocals(
      request.outgoingVocals ?? [],
      timeAtBeat(outgoing, exitBeat),
      timeAtBeat(outgoing, exitBeat + blend),
    ) &&
    overlapsVocals(
      request.incomingVocals ?? [],
      blendStartSec,
      blendStartSec + blendDurationSec * incomingRate,
    );

  return {
    blendBeats: blend,
    startsInSec,
    blendDurationSec,
    outgoingExitBeat: exitBeat,
    outgoingEndBeat: exitBeat + blend,
    incomingStartSec: Math.max(0, incomingStartSec()),
    incomingEntryBeat: request.incomingEntryBeat,
    incomingRate,
    tempoStretch,
    tempoComfortable: tempoStretch <= tolerance + EPSILON,
    bassSwapBeatOffset,
    bassSwapInSec: startsInSec + bassSwapBeatOffset * spbOut,
    rateReturnDurationSec: phrase * secondsPerBeat(incoming.bpm),
    keyCompatibility: keyFit,
    vocalOverlap,
  };
}

/**
 * The referee: planTransition with the hard rule enforced — never
 * overlap two voices. If the natural blend would put both singers on
 * air together, the blend is retried shorter (a shorter window can
 * end before the outgoing voice's late line, or before the incoming
 * voice arrives). If every workable length still overlaps, there is
 * no honest blend for this pair from here, and the answer is null —
 * the caller falls back to a cut, which is what a DJ does when a
 * blend would clash. Key fit stays a report, never a veto: the
 * listener's chosen order is respected.
 */
export function planTransitionWithReferee(
  request: TransitionRequest,
): TransitionPlan | null {
  const start = request.blendBeats ?? 16;
  const attempts = [start, 12, 8, MIN_BLEND_BEATS].filter(
    (beats, index, all) =>
      beats <= start &&
      beats >= MIN_BLEND_BEATS &&
      all.indexOf(beats) === index,
  );
  for (const blendBeats of attempts) {
    const plan = planTransition({ ...request, blendBeats });
    if (plan && !plan.vocalOverlap) return plan;
  }
  return null;
}

// =====================================================================
// The recipe author (Step 5, slice S5-2).
//
// Everything above is v1 geometry — kept verbatim because the recipe
// adapter and the structure-less fallback still stand on it. What
// follows is the new centre of this file: authoring a TransitionRecipe
// for a pair, from the two tracks' analysis-v2 structures.
//
// The author's rules, in order:
//
// 1. ENTRY is chosen from the incoming track's structure: the
//    strongest usable drop (drop STRENGTH is spent here — earliest no
//    longer wins), else the intro's end, else the first chorus, else
//    a phrase fallback for structure-less analyses.
// 2. EXIT is chosen from the outgoing track's structure: the outro's
//    first beat, else a late section boundary the blend can occupy,
//    else v1's phrase arithmetic (the geometry above, generalised to
//    accept a chosen exit).
// 3. TEMPO is a strategy, not a reflex: beatmatching happens only
//    inside a stated reach and only when the tempo evidence is
//    trustworthy (tempo confidence and grid confidence — the v1
//    orphans, spent at last). Inside the profile's rate cap the deck
//    itself rate-shifts; past it, inside the profile's rendition
//    ceilings, the blend is authored against a pitch-preserved
//    rendition of the incoming (overlap.stretchB — preparation
//    renders it; the deck just plays it at rate 1). Beyond both, the
//    recipe is a rate-1 family: a drop-cut, or a filter fade — never
//    silent pitch damage.
// 4. KEY spends as a bounded veto: a distant relation caps blends at
//    8 beats; an unknown key is neutral, never a veto.
// 5. VOCALS are judged by the GRADED referee (applyVocalReferee):
//    the overlap integral of confidence-weighted vocal activity, with
//    section means corroborating. A trusted clash shortens the blend,
//    then changes the family; an uncertain reading shortens at most
//    one step — a synth lead that reads as voice (S5-1 report §3)
//    must not, on its own, forbid a blend.
// 6. The RATE RETURN is chosen from the incoming track's structure
//    (runway to its next section boundary, clamped) — the fixed
//    one-phrase glide is abolished; the return is recipe data.
// 7. When the incoming intro is too short for the blend the pair
//    deserves but the outgoing has a loopable breakdown/outro, the
//    recipe carries a LOOP block that extends the outgoing instead
//    of shrinking the join.
//
// The author's bounds are owned by the decision profile
// (decisionProfile.ts, Step 5 slice S5-3): every judgement constant
// below is read from the profile threaded through the request, and
// the standard profile carries exactly the values this author
// shipped with in S5-2 — the move changed their home, not their
// values. Authoring under a different profile is how candidates.ts
// asks the same pair for honestly different recipes.
// =====================================================================

export interface RecipeRequest {
  outgoing: TrackAnalysis;
  /** Where the outgoing track is playing right now, in track seconds. */
  outgoingPositionSec: number;
  incoming: TrackAnalysis;
  /**
   * The judgement profile to author under. Absent = the standard
   * profile (the pre-S5-3 behaviour, byte for byte).
   */
  profile?: DecisionProfile;
}

// ---------- vocal evidence: graded activity, confidence, corroboration

interface VocalWindowReading {
  /** Integrated product of both sides' effective activity, 0..1. */
  integral: number;
  /** Mean confidence of the weaker-evidenced side over the window. */
  trust: number;
  /** Both sides were read from graded curves (not fallbacks). */
  graded: boolean;
}

/** One window of one track's vocal evidence, sampled for integration. */
function vocalSamples(
  analysis: TrackAnalysis,
  startSec: number,
  endSec: number,
): { activityAt: (t: number) => number; trust: number; graded: boolean } {
  const curve: VocalActivityCurve | undefined = analysis.vocalActivity;
  if (curve && curve.points.length > 0) {
    // Effective activity: the reading discounted by its own doubt.
    // A borderline window counts for less than a decisive one — the
    // graded curve's confidence is spent, not just stored.
    let trustSum = 0;
    let trustCount = 0;
    for (const point of curve.points) {
      if (point.timeSec >= startSec && point.timeSec <= endSec) {
        trustSum += point.confidence;
        trustCount += 1;
      }
    }
    const trust = trustCount > 0 ? trustSum / trustCount : 0;
    return {
      activityAt: (t) =>
        meanVocalActivity(curve, t, t + curve.stepSec) * (0.35 + 0.65 * trust),
      trust,
      graded: true,
    };
  }
  const sections = analysis.sections;
  if (sections && sections.length > 0) {
    // Corroborating evidence: the sections' own vocal means. Coarser
    // than the curve, but an independent read of the same audio.
    const overlapping = sections.filter(
      (s) => s.endSec > startSec && s.startSec < endSec,
    );
    const trust =
      overlapping.length > 0
        ? overlapping.reduce((sum, s) => sum + s.confidence, 0) /
          overlapping.length
        : 0;
    return {
      activityAt: (t) => {
        const section = sections.find((s) => t >= s.startSec && t < s.endSec);
        return section ? section.vocalActivity * (0.35 + 0.65 * trust) : 0;
      },
      trust,
      graded: false,
    };
  }
  // Last resort: v1's binary ranges, as v1 read them. Coarse — and
  // the reading is labelled ungraded so trust decisions know it.
  const ranges = analysis.vocalRanges ?? [];
  return {
    activityAt: (t) =>
      ranges.some((r) => t >= r.startSec && t < r.endSec) ? 1 : 0,
    trust: 1,
    graded: false,
  };
}

/**
 * The graded overlap integral over a proposed pair of windows: how
 * much of the overlap has BOTH sides vocally active at once, each
 * side's activity weighted by the confidence behind it.
 */
export function vocalOverlapIntegral(
  outgoing: TrackAnalysis,
  outStartSec: number,
  outEndSec: number,
  incoming: TrackAnalysis,
  inStartSec: number,
  inEndSec: number,
): VocalWindowReading {
  const a = vocalSamples(outgoing, outStartSec, outEndSec);
  const b = vocalSamples(incoming, inStartSec, inEndSec);
  const duration = Math.max(0, outEndSec - outStartSec);
  if (duration <= 0)
    return { integral: 0, trust: 1, graded: a.graded && b.graded };
  const steps = Math.max(4, Math.ceil(duration / 0.25));
  let sum = 0;
  for (let i = 0; i < steps; i += 1) {
    const tA = outStartSec + ((i + 0.5) / steps) * duration;
    const spanB = Math.max(0, inEndSec - inStartSec);
    const tB = inStartSec + ((i + 0.5) / steps) * spanB;
    sum += a.activityAt(tA) * b.activityAt(tB);
  }
  return {
    integral: sum / steps,
    trust: Math.min(a.trust, b.trust),
    graded: a.graded && b.graded,
  };
}

// ---------- automation construction (the author's curve vocabulary)

function curveFrom(
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

/** Equal-power knots (the v1 blend shape, as data). */
function equalPowerPoints(durationMs: number): {
  out: [number, number][];
  into: [number, number][];
} {
  const out: [number, number][] = [];
  const into: [number, number][] = [];
  const KNOTS = 8;
  for (let i = 0; i <= KNOTS; i += 1) {
    const t = i / KNOTS;
    out.push([t * durationMs, Math.cos((t * Math.PI) / 2)]);
    into.push([t * durationMs, Math.sin((t * Math.PI) / 2)]);
  }
  return { out, into };
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Smooth linear-ish fade knots for the rate-1 filter-fade family. */
function smoothFadePoints(durationMs: number): {
  out: [number, number][];
  into: [number, number][];
} {
  const out: [number, number][] = [];
  const into: [number, number][] = [];
  const KNOTS = 4;
  for (let i = 0; i <= KNOTS; i += 1) {
    const t = i / KNOTS;
    out.push([t * durationMs, 1 - smoothstep(t)]);
    into.push([t * durationMs, smoothstep(t)]);
  }
  return { out, into };
}

interface AutomationSpec {
  preset: TransitionRecipe["preset"];
  durationMs: number;
  /** Where the bass ownership swaps, ms into the overlap; null = no swap. */
  swapAtMs: number | null;
  /** Whether long-blend mid/high opening applies. */
  openMidHigh: boolean;
  /** Sweep the outgoing's lowpass down across the overlap. */
  filterSweep: boolean;
  rateB: number;
  /**
   * True when B will be performed from a pitch-preserved rendition
   * (overlap.stretchB): the rendition is already at tempo, so the
   * rate curve is flat 1 — no hold at rateB and NO rate return.
   */
  stretchRendition?: boolean;
  /** Rate-return length after the overlap, ms (0 when rateB is 1). */
  rateReturnMs: number;
  /** Ramp A's echo send over the overlap's final beat of this length; null = no echo. */
  echoTailMs: number | null;
}

function buildAutomation(spec: AutomationSpec): TransitionRecipe["automation"] {
  const d = spec.durationMs;
  let volumeOut: AutomationCurve;
  let volumeIn: AutomationCurve;
  if (spec.preset === "cut") {
    volumeOut = curveFrom("linear-gain", "linear", [
      [0, 1],
      [0, 0],
    ]);
    volumeIn = curveFrom("linear-gain", "linear", [
      [0, 0],
      [0, 1],
    ]);
  } else if (spec.preset === "fade") {
    const pts = smoothFadePoints(d);
    volumeOut = curveFrom("linear-gain", "linear", pts.out);
    volumeIn = curveFrom("linear-gain", "linear", pts.into);
  } else {
    const pts = equalPowerPoints(d);
    volumeOut = curveFrom("linear-gain", "linear", pts.out);
    volumeIn = curveFrom("linear-gain", "linear", pts.into);
  }

  const flatEq = (): AutomationCurve =>
    curveFrom("eq-gain", "decibels", [[0, 0]]);
  let eqOut: EqCurves;
  let eqIn: EqCurves;
  if (spec.swapAtMs !== null && d > 0) {
    const swap = spec.swapAtMs;
    eqOut = {
      low: curveFrom("eq-gain", "decibels", [
        [0, 0],
        [swap, 0],
        [swap + 20, FULL_BASS_CUT_DB],
      ]),
      mid: flatEq(),
      high: flatEq(),
    };
    eqIn = {
      low: curveFrom("eq-gain", "decibels", [
        [0, FULL_BASS_CUT_DB],
        [swap, FULL_BASS_CUT_DB],
        [swap + 20, 0],
      ]),
      mid: flatEq(),
      high: flatEq(),
    };
  } else if (spec.preset === "fade" && d > 0) {
    // No beat alignment to protect: hand the low end over gradually.
    eqOut = {
      low: curveFrom("eq-gain", "decibels", [
        [0, 0],
        [d, -12],
      ]),
      mid: flatEq(),
      high: flatEq(),
    };
    eqIn = {
      low: curveFrom("eq-gain", "decibels", [
        [0, -12],
        [d, 0],
      ]),
      mid: flatEq(),
      high: flatEq(),
    };
  } else {
    eqOut = { low: flatEq(), mid: flatEq(), high: flatEq() };
    eqIn = { low: flatEq(), mid: flatEq(), high: flatEq() };
  }
  if (spec.openMidHigh && d > 0) {
    // A long blend opens the incoming's top as it settles, and tucks
    // the outgoing's away — the blend breathes instead of stacking.
    eqIn.mid = curveFrom("eq-gain", "decibels", [
      [0, -3],
      [d, 0],
    ]);
    eqIn.high = curveFrom("eq-gain", "decibels", [
      [0, -2],
      [d, 0],
    ]);
    eqOut.mid = curveFrom("eq-gain", "decibels", [
      [0, 0],
      [d, -3],
    ]);
    eqOut.high = curveFrom("eq-gain", "decibels", [
      [0, 0],
      [d, -2],
    ]);
  }

  const filterOut = spec.filterSweep
    ? curveFrom("filter-cutoff", "hertz", [
        [0, OPEN_FILTER_HZ],
        [d, 700],
      ])
    : flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ);
  const filterIn = flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ);

  const ratePoints: AutomationPoint[] =
    spec.rateB === 1 || spec.stretchRendition
      ? [{ atMs: 0, value: 1 }]
      : [
          { atMs: 0, value: spec.rateB },
          { atMs: d, value: spec.rateB, easing: "linear" },
          { atMs: d + spec.rateReturnMs, value: 1 },
        ];

  const echoSendOut =
    spec.echoTailMs !== null && d > 0
      ? curveFrom("dry-wet", "percent", [
          [0, 0],
          [Math.max(0, d - spec.echoTailMs), 0],
          [d, 0.9],
        ])
      : flatCurve("dry-wet", "percent", 0);

  return {
    volumeOut,
    volumeIn,
    eqOut,
    eqIn,
    filterOut,
    filterIn,
    rateB: { kind: "rate", unit: "ratio", points: ratePoints },
    echoSendOut,
    echoSendIn: flatCurve("dry-wet", "percent", 0),
  };
}

/**
 * Rebuilds a recipe's automation for a shorter overlap, preserving
 * its family character: the swap scales with the duration, the rate
 * return keeps its absolute length (it belongs to the incoming
 * track's structure, not to the overlap), echo and filter behaviour
 * carry over. Used by the referee; derived entirely from the recipe's
 * own data.
 */
function rebuildAutomation(
  recipe: TransitionRecipe,
  newDurationMs: number,
): TransitionRecipe["automation"] {
  const a = recipe.automation;
  const oldDuration = recipe.overlap.durationMs;
  const ratio = oldDuration > 0 ? newDurationMs / oldDuration : 0;
  const oldSwap = a.eqIn.low.points.find(
    (p, i) =>
      p.value > FULL_BASS_CUT_DB + 1 &&
      i > 0 &&
      a.eqIn.low.points[i - 1].value <= FULL_BASS_CUT_DB + 1,
  );
  const hadSwap =
    recipe.preset === "beatmatched-fade" &&
    a.eqIn.low.points.some((p) => p.value <= FULL_BASS_CUT_DB + 1) &&
    oldDuration > 0;
  const oldReturnMs =
    a.rateB.points.length > 0
      ? Math.max(
          0,
          a.rateB.points[a.rateB.points.length - 1].atMs - oldDuration,
        )
      : 0;
  return buildAutomation({
    preset: recipe.preset,
    durationMs: newDurationMs,
    swapAtMs: hadSwap
      ? Math.min(
          newDurationMs,
          (oldSwap ? oldSwap.atMs - 20 : oldDuration / 2) * ratio,
        )
      : null,
    openMidHigh: a.eqIn.mid.points.length > 1,
    filterSweep:
      a.filterOut.points[a.filterOut.points.length - 1].value < OPEN_FILTER_HZ,
    rateB: recipe.overlap.rateB,
    // A shortened stretch recipe stays a stretch recipe: the rebuilt
    // rate curve must stay flat, never re-acquire a hold-and-return.
    stretchRendition: recipe.overlap.stretchB !== null,
    rateReturnMs: oldReturnMs,
    echoTailMs:
      recipe.fx.echo && newDurationMs > 0
        ? (60 / recipe.overlap.bpmA) * 1000
        : null,
  });
}

// ---------- the graded vocal referee

/**
 * The referee, in its v2 form: a pure function over a drafted recipe.
 * It reads the graded vocal evidence for the recipe's windows and, if
 * two voices would genuinely clash, shortens the overlap — moving
 * both starts later, keeping both landings fixed — rebuilding the
 * automation for the shorter window. It never changes the family and
 * never lengthens anything; family changes are the author's call, and
 * performance-time re-checks (the executor calls this too, against
 * the deepened analysis) can only ever make a join safer.
 *
 * The discipline (from the S5-1 blind spot): the judgement spends the
 * curve's confidence as well as its activity, corroborated by section
 * means. When the evidence is UNCERTAIN (weak confidence, or only
 * fallback evidence on a side), the referee shortens at most one step
 * and only keeps the shortening if it fully clears the clash — it
 * does not chase a possibly-phantom voice down the ladder.
 */
function refereeWithProfile(
  recipe: TransitionRecipe,
  outgoing: TrackAnalysis,
  incoming: TrackAnalysis,
  profile: DecisionProfile,
): TransitionRecipe {
  if (recipe.preset !== "beatmatched-fade") return recipe;
  const { startAMs, startBMs, durationMs, rateB } = recipe.overlap;
  if (startAMs === null || durationMs <= 0) return recipe;

  const read = (candidate: TransitionRecipe): VocalWindowReading =>
    vocalOverlapIntegral(
      outgoing,
      candidate.overlap.startAMs! / 1000,
      (candidate.overlap.startAMs! + candidate.overlap.durationMs) / 1000,
      incoming,
      candidate.overlap.startBMs / 1000,
      (candidate.overlap.startBMs +
        candidate.overlap.durationMs * candidate.overlap.rateB) /
        1000,
    );

  const initial = read(recipe);
  const trusted =
    initial.graded && initial.trust >= profile.vocalTrustConfidence;
  const withEvidence = (
    candidate: TransitionRecipe,
    reading: VocalWindowReading,
    shortened: boolean,
  ): TransitionRecipe => ({
    ...candidate,
    evidence: {
      ...candidate.evidence,
      vocalOverlap: reading.integral,
      vocalEvidence: trusted ? "trusted" : "uncertain",
      refereeShortened: shortened,
    },
  });

  if (initial.integral <= profile.vocalClashIntegral) {
    return withEvidence(recipe, initial, false);
  }

  const spbA = secondsPerBeat(outgoing.beatMap.bpm);
  const endBeatA = beatsAtTime(
    outgoing.beatMap,
    (startAMs + durationMs) / 1000,
  );
  const beatsNow = durationMs / 1000 / spbA;
  const ladder = [12, 8, MIN_BLEND_BEATS].filter((b) => b < beatsNow - 0.5);
  const maxSteps = trusted ? ladder.length : 1;

  let shortest: TransitionRecipe | null = null;
  let shortestReading: VocalWindowReading | null = null;
  for (let step = 0; step < Math.min(maxSteps, ladder.length); step += 1) {
    const beats = ladder[step];
    const newDurationMs = beats * spbA * 1000;
    const newStartAMs = timeAtBeat(outgoing.beatMap, endBeatA - beats) * 1000;
    const newStartBMs = startBMs + (durationMs - newDurationMs) * rateB;
    const candidate: TransitionRecipe = {
      ...recipe,
      overlap: {
        ...recipe.overlap,
        startAMs: newStartAMs,
        startBMs: newStartBMs,
        durationMs: newDurationMs,
        durationBars: beats / outgoing.beatMap.beatsPerBar,
      },
      automation: rebuildAutomation(recipe, newDurationMs),
    };
    const reading = read(candidate);
    if (reading.integral <= profile.vocalClashIntegral) {
      return withEvidence(candidate, reading, true);
    }
    shortest = candidate;
    shortestReading = reading;
  }

  if (!trusted) {
    // One step did not clear it and the evidence is doubtful: keep
    // the author's original window rather than chase the phantom.
    return withEvidence(recipe, initial, false);
  }
  if (shortest && shortestReading) {
    return withEvidence(shortest, shortestReading, true);
  }
  return withEvidence(recipe, initial, false);
}

/**
 * The referee under the standard profile — the public seam the
 * executor re-runs at the decks. Performance-time discipline is
 * deliberately NOT profile-relative: whatever temperament authored
 * a recipe, the decks re-check it against the standard bounds, so a
 * join can only ever be made safer than written, never bolder.
 */
export function applyVocalReferee(
  recipe: TransitionRecipe,
  outgoing: TrackAnalysis,
  incoming: TrackAnalysis,
): TransitionRecipe {
  return refereeWithProfile(recipe, outgoing, incoming, STANDARD_PROFILE);
}

// ---------- entry / exit choice

export function chooseEntry(
  incoming: TrackAnalysis,
  profile: DecisionProfile = STANDARD_PROFILE,
): {
  beat: number;
  reason: string;
} {
  const map = incoming.beatMap;
  const totalBeats = Math.floor(
    (map.durationSec - map.firstBeatSec) / secondsPerBeat(map.bpm),
  );
  // Drop strength is spent, not just sorted: the strongest drop that
  // leaves a usable intro before it and a runway after it wins.
  for (const drop of incoming.drops) {
    if (
      drop.beat >= profile.minLeadBeats &&
      timeAtBeat(map, drop.beat) <=
        map.durationSec - 4 * secondsPerBeat(map.bpm)
    ) {
      return {
        beat: drop.beat,
        reason: `strongest usable drop (strength ${drop.strength.toFixed(2)})`,
      };
    }
  }
  if (incoming.intro && incoming.intro.endBeat >= MIN_BLEND_BEATS) {
    return { beat: incoming.intro.endBeat, reason: "the intro's last beat" };
  }
  const chorus = (incoming.sections ?? []).find(
    (s) => s.kind === "chorus" && s.startBeat > 0,
  );
  if (chorus) return { beat: chorus.startBeat, reason: "the first chorus" };
  // Structure-less fallback — entryBeat.ts's rule, inlined so the
  // author carries no dependency on a file S5-4 deletes.
  if (totalBeats >= 48)
    return { beat: 32, reason: "phrase fallback (no structure)" };
  if (totalBeats >= 24)
    return { beat: 16, reason: "phrase fallback (no structure)" };
  return { beat: 0, reason: "the track's first beat (no structure)" };
}

interface BlendGeometry {
  exitBeat: number;
  blendBeats: number;
  startASec: number;
  startBSec: number;
  bassSwapBeatOffset: number;
  exitReason: string;
  loop?: { sectionStartBeat: number; sectionEndBeat: number };
}

/**
 * Blend geometry for a chosen exit beat — planTransition's arithmetic
 * generalised to an exit the AUTHOR picked (and to grid-aware times):
 * the blend shortens rather than overrun either file, and returns
 * null when even the minimum blend cannot be reached.
 */
function blendGeometry(
  outgoing: TrackAnalysis,
  exitBeat: number,
  desiredBlend: number,
  incoming: TrackAnalysis,
  entryBeat: number,
  exitReason: string,
  positionSec: number,
): BlendGeometry | null {
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  // An exit whose start is already behind the playhead is not an
  // exit — the phrase walk-back can produce one near a track's end.
  if (timeAtBeat(outMap, exitBeat) < positionSec - 0.05) return null;
  const totalBeatsA = beatsAtTime(outMap, outMap.durationSec);
  let blend = Math.min(desiredBlend, Math.floor(totalBeatsA - exitBeat));
  while (
    blend >= MIN_BLEND_BEATS &&
    timeAtBeat(inMap, entryBeat - blend) < -EPSILON
  ) {
    blend -= 1;
  }
  if (blend < MIN_BLEND_BEATS) return null;
  if (timeAtBeat(inMap, entryBeat) >= inMap.durationSec) return null;
  const halfBars = Math.floor(blend / 2 / outMap.beatsPerBar);
  return {
    exitBeat,
    blendBeats: blend,
    startASec: timeAtBeat(outMap, exitBeat),
    startBSec: Math.max(0, timeAtBeat(inMap, entryBeat - blend)),
    bassSwapBeatOffset: Math.max(
      outMap.beatsPerBar,
      halfBars * outMap.beatsPerBar,
    ),
    exitReason,
  };
}

/** Mean energy of the outgoing's last two seconds (v1's tail test, as evidence). */
function tailEnergy(analysis: TrackAnalysis): number | null {
  const curve = analysis.energyCurve;
  if (curve.length === 0) return null;
  const tail = curve.slice(-2);
  return tail.reduce((sum, point) => sum + point.energy, 0) / tail.length;
}

/** The dotted-eighth echo spacing (mirrors twoDeckMixer's echoDelaySec). */
function dottedEighthSec(bpm: number): number {
  if (bpm <= 0) return 0.3;
  return Math.min(1.2, Math.max(0.08, 0.75 * (60 / bpm)));
}

function rateReturnMs(
  incoming: TrackAnalysis,
  entryBeat: number,
  profile: DecisionProfile,
): number {
  const map = incoming.beatMap;
  const next = (incoming.sections ?? []).find((s) => s.startBeat > entryBeat);
  let beats = next
    ? next.startBeat - entryBeat
    : profile.defaultRateReturnBeats;
  beats = Math.min(
    profile.maxRateReturnBeats,
    Math.max(profile.minRateReturnBeats, beats),
  );
  return Math.max(
    0,
    (timeAtBeat(map, entryBeat + beats) - timeAtBeat(map, entryBeat)) * 1000,
  );
}

export function fingerprintsOf(
  outgoing: TrackAnalysis,
  incoming: TrackAnalysis,
): TransitionRecipe["fingerprints"] {
  return {
    aAudioHash: outgoing.audioHash ?? null,
    bAudioHash: incoming.audioHash ?? null,
    analysisVersion:
      outgoing.analysisVersion ?? incoming.analysisVersion ?? null,
  };
}

function fallbackNote(): TransitionRecipe["fallback"] {
  return {
    kind: "cut",
    note: "If this recipe cannot be performed as written, cut plainly — never force the blend.",
  };
}

/**
 * Everything the two authors need that depends only on the pair, the
 * position and the profile — computed once, shared by authorRecipe
 * and by the candidate-facing variant wrappers below.
 */
export interface AuthorContext {
  profile: DecisionProfile;
  entry: { beat: number; reason: string };
  rateB: number;
  stretch: number;
  keyFit: KeyCompatibility | null;
  nowBeat: number;
  totalBeatsA: number;
  tempoTrusted: boolean;
  /** Beatmatching is viable in SOME mode (rate or rendition). */
  beatmatchViable: boolean;
  /** Beatmatching is viable by deck rate alone (inside the rate cap). */
  rateBeatmatchViable: boolean;
  /**
   * The viable beatmatch is a RENDITION beatmatch: the pair sits
   * past the profile's rate cap but inside its stretch ceilings, so
   * the blend is authored against a pitch-preserved rendition of B.
   * Renditions are spent only when rate cannot honestly cover the
   * gap — inside the rate cap, rate mode wins (no render cost).
   */
  stretchMode: boolean;
}

export function authorContext(request: RecipeRequest): AuthorContext {
  const { outgoing, incoming } = request;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  const profile = resolveProfile(request.profile);
  const nowBeat = beatsAtTime(outMap, request.outgoingPositionSec);
  const totalBeatsA = beatsAtTime(outMap, outMap.durationSec);

  const entry = chooseEntry(incoming, profile);
  const rateB = outMap.bpm / inMap.bpm;
  const stretch = Math.abs(rateB - 1);
  const keyFit = keyCompatibility(outgoing.key, incoming.key);

  // Tempo trust: confidence and grid agreement are spent, per the
  // charter's third requirement — never beatmatch on a guess.
  const tempoTrusted =
    (outgoing.tempoConfidence === undefined ||
      outgoing.tempoConfidence >= profile.minTempoConfidence) &&
    (incoming.tempoConfidence === undefined ||
      incoming.tempoConfidence >= profile.minTempoConfidence) &&
    (outMap.grid === undefined ||
      outMap.grid.confidence >= profile.minGridConfidence) &&
    (inMap.grid === undefined ||
      inMap.grid.confidence >= profile.minGridConfidence);
  const rateBeatmatchViable =
    stretch <= profile.maxBeatmatchStretch && tempoTrusted;
  // The rendition reach: past the rate cap, a pitch-preserved
  // rendition still beatmatches honestly — up to the profile's
  // asymmetric stretch ceilings, and only on trusted tempo evidence
  // (a rendition of a guessed tempo is a rendered guess).
  const stretchViable = tempoTrusted && withinStretchCeilings(profile, rateB);
  const beatmatchViable = rateBeatmatchViable || stretchViable;
  const stretchMode = beatmatchViable && !rateBeatmatchViable;

  return {
    profile,
    entry,
    rateB,
    stretch,
    keyFit,
    nowBeat,
    totalBeatsA,
    tempoTrusted,
    beatmatchViable,
    rateBeatmatchViable,
    stretchMode,
  };
}

/**
 * Authors the recipe the evidence best supports for this pair, from
 * this position, under the request's profile. One recipe — the
 * author's single best-supported answer, or null when no honest
 * join exists from here (the session's own fallbacks then apply,
 * exactly as when the v1 planner returned null). candidates.ts asks
 * this machinery for several recipes instead (the variant wrappers
 * below); the scoring of those rivals is scoring.ts's job, never
 * the author's.
 */
export function authorRecipe(request: RecipeRequest): TransitionRecipe | null {
  const ctx = authorContext(request);
  if (ctx.beatmatchViable) {
    const recipe = authorBlend(request, ctx);
    if (recipe) return recipe;
  }
  return authorRateOneJoin(request, ctx);
}

/** A blend rival the candidate enumerator may ask for. */
export interface BlendVariant {
  /**
   * Ask for this blend length instead of the evidence-derived one.
   * The distant-key cap still clamps it — a cap is a cap.
   */
  desiredBeats?: number;
  /** Only the loop-extended geometry is acceptable (null when none). */
  loopOnly?: boolean;
}

/**
 * The blend author, exposed for candidate enumeration: the same
 * authoring as authorRecipe's blend path (same profile gates, same
 * referee under the authoring profile), with an optional variant.
 * Returns null when beatmatching is not viable under the profile or
 * no honest blend exists.
 */
export function authorBlendVariant(
  request: RecipeRequest,
  variant: BlendVariant = {},
): TransitionRecipe | null {
  const ctx = authorContext(request);
  if (!ctx.beatmatchViable) return null;
  return authorBlend(request, ctx, variant);
}

/**
 * The rate-1 author, exposed for candidate enumeration: the drop-cut
 * and/or the filter fade, as authorRecipe's fallback path authors
 * them. `only` restricts the answer to one family (null when that
 * family is not honestly available); absent, the author's own
 * preference decides, exactly as in authorRecipe.
 */
export function authorRateOneVariant(
  request: RecipeRequest,
  only?: "drop-cut" | "filter-fade",
): TransitionRecipe | null {
  const ctx = authorContext(request);
  return authorRateOneJoin(request, ctx, only);
}

function authorBlend(
  request: RecipeRequest,
  ctx: AuthorContext,
  variant: BlendVariant = {},
): TransitionRecipe | null {
  const { outgoing, incoming } = request;
  const outMap = outgoing.beatMap;
  const { profile, entry, rateB, stretch, keyFit, nowBeat, totalBeatsA } = ctx;
  const stretchMode = ctx.stretchMode;
  const minLead = profile.minLeadBeats;

  // Desired length: a long blend is earned by a quiet pair (low vocal
  // density on both sides, small stretch, friendly keys); the distant
  // key cap applies no matter what else is true.
  const density = (a: TrackAnalysis): number | null => {
    if (a.vocalActivity && a.vocalActivity.points.length > 0) {
      return meanVocalActivity(a.vocalActivity, 0, a.beatMap.durationSec);
    }
    if (a.sections && a.sections.length > 0) {
      const total = a.sections.reduce(
        (sum, s) => sum + (s.endSec - s.startSec),
        0,
      );
      if (total <= 0) return null;
      return (
        a.sections.reduce(
          (sum, s) => sum + s.vocalActivity * (s.endSec - s.startSec),
          0,
        ) / total
      );
    }
    return null;
  };
  const outDensity = density(outgoing);
  const inDensity = density(incoming);
  let desired: number = profile.standardBlendBeats;
  if (
    stretch <= 0.03 &&
    keyFit?.compatible &&
    outDensity !== null &&
    inDensity !== null &&
    outDensity < 0.3 &&
    inDensity < 0.3
  ) {
    desired = profile.longBlendBeats;
  }
  if (variant.desiredBeats !== undefined) desired = variant.desiredBeats;
  if (keyFit && keyFit.relation === "distant") {
    desired = Math.min(desired, profile.distantKeyMaxBlendBeats);
  }

  let geometry: BlendGeometry | null = null;
  if (!variant.loopOnly) {
    // Exit candidates, in the author's order of preference.
    const exits: { beat: number; reason: string }[] = [];
    if (outgoing.outro && outgoing.outro.startBeat >= nowBeat + minLead) {
      exits.push({
        beat: outgoing.outro.startBeat,
        reason: "the outro's first beat",
      });
    }
    const sectionStarts = (outgoing.sections ?? [])
      .filter(
        (s) =>
          s.kind !== "intro" &&
          s.startBeat >= nowBeat + minLead &&
          s.startBeat + MIN_BLEND_BEATS <= totalBeatsA,
      )
      .map((s) => s.startBeat);
    if (sectionStarts.length > 0) {
      const last = Math.max(...sectionStarts);
      exits.push({
        beat: last,
        reason: "the last section the blend can occupy",
      });
    }
    const phrase = phraseBeats(outMap, 4);
    let phraseExit = Math.ceil((nowBeat + minLead - EPSILON) / phrase) * phrase;
    while (
      phraseExit > nowBeat &&
      timeAtBeat(outMap, phraseExit + desired) > outMap.durationSec + EPSILON
    ) {
      phraseExit -= phrase;
    }
    exits.push({ beat: phraseExit, reason: "a phrase boundary" });

    for (const exit of exits) {
      geometry = blendGeometry(
        outgoing,
        exit.beat,
        desired,
        incoming,
        entry.beat,
        exit.reason,
        request.outgoingPositionSec,
      );
      if (geometry) break;
    }
  }

  // Loop extension: the desired blend could not fit because the
  // OUTGOING runs out — and it has a loopable breakdown/outro the
  // exit sits inside. Extend the outgoing rather than shrink the join.
  if (
    !geometry ||
    (geometry.blendBeats < desired &&
      geometry.blendBeats < profile.standardBlendBeats)
  ) {
    const looped = loopExtendedGeometry(outgoing, incoming, ctx, desired);
    if (looped && (!geometry || looped.blendBeats > geometry.blendBeats)) {
      geometry = looped;
    }
  }
  if (!geometry) return null;

  const durationMs =
    (timeAtBeat(outMap, geometry.exitBeat + geometry.blendBeats) -
      geometry.startASec) *
    1000;
  const returnMs = rateReturnMs(incoming, entry.beat, profile);
  const draft: TransitionRecipe = {
    version: 1,
    preset: "beatmatched-fade",
    overlap: {
      startAMs: geometry.startASec * 1000,
      startBMs: geometry.startBSec * 1000,
      durationMs,
      durationBars: geometry.blendBeats / outMap.beatsPerBar,
      beatmatched: true,
      rateA: 1,
      rateB,
      stretchB: stretchMode ? rateB : null,
      bpmA: outMap.bpm,
      bpmB: incoming.beatMap.bpm,
    },
    leadInSec: Math.max(0, geometry.startASec - request.outgoingPositionSec),
    automation: buildAutomation({
      preset: "beatmatched-fade",
      durationMs,
      swapAtMs: geometry.bassSwapBeatOffset * secondsPerBeat(outMap.bpm) * 1000,
      openMidHigh: geometry.blendBeats >= 8,
      filterSweep: false,
      rateB,
      // Stretch mode has no rate return to schedule: the rendition
      // IS at tempo for the whole track, not just the overlap.
      stretchRendition: stretchMode,
      rateReturnMs: stretchMode ? 0 : returnMs,
      echoTailMs: null,
    }),
    loops: geometry.loop
      ? [
          {
            type: "loop",
            side: "A",
            startMs: timeAtBeat(outMap, geometry.loop.sectionStartBeat) * 1000,
            endMs: timeAtBeat(outMap, geometry.loop.sectionEndBeat) * 1000,
            beats:
              geometry.loop.sectionEndBeat - geometry.loop.sectionStartBeat,
          },
        ]
      : [],
    fx: {},
    fingerprints: fingerprintsOf(outgoing, incoming),
    fallback: fallbackNote(),
    evidence: {
      entryReason: entry.reason,
      exitReason: geometry.exitReason,
      vocalOverlap: 0,
      vocalEvidence: "trusted",
      tempoStretch: stretch,
      keyScore: keyFit?.score ?? null,
      refereeShortened: false,
    },
  };

  const refereed = refereeWithProfile(draft, outgoing, incoming, profile);
  // A trusted, still-clashing blend is not an honest blend: the
  // author changes family instead of shipping the clash.
  if (
    refereed.evidence.vocalOverlap > profile.vocalClashIntegral &&
    refereed.evidence.vocalEvidence === "trusted"
  ) {
    return null;
  }
  return refereed;
}

function loopExtendedGeometry(
  outgoing: TrackAnalysis,
  incoming: TrackAnalysis,
  ctx: AuthorContext,
  desired: number,
): BlendGeometry | null {
  const outMap = outgoing.beatMap;
  const entryBeat = ctx.entry.beat;
  const nowBeat = ctx.nowBeat;
  const minLead = ctx.profile.minLeadBeats;
  const phrase = phraseBeats(outMap, 4);
  for (const section of outgoing.sections ?? []) {
    if (section.kind !== "breakdown" && section.kind !== "outro") continue;
    const lengthBeats = section.endBeat - section.startBeat;
    if (lengthBeats < MIN_BLEND_BEATS) continue;
    if (outMap.grid && outMap.grid.confidence < ctx.profile.minGridConfidence) {
      continue;
    }
    // The exit must sit inside the loopable section, with the
    // section extending at least two beats past it.
    let exitBeat = Math.max(
      section.startBeat,
      Math.ceil((nowBeat + minLead - EPSILON) / phrase) * phrase,
    );
    if (exitBeat < nowBeat + minLead) {
      exitBeat = Math.ceil((nowBeat + minLead - EPSILON) / phrase) * phrase;
    }
    if (exitBeat >= section.endBeat - 2) continue;
    if (timeAtBeat(incoming.beatMap, entryBeat - desired) < -EPSILON) continue;
    const halfBars = Math.floor(desired / 2 / outMap.beatsPerBar);
    return {
      exitBeat,
      blendBeats: desired,
      startASec: timeAtBeat(outMap, exitBeat),
      startBSec: Math.max(0, timeAtBeat(incoming.beatMap, entryBeat - desired)),
      bassSwapBeatOffset: Math.max(
        outMap.beatsPerBar,
        halfBars * outMap.beatsPerBar,
      ),
      exitReason: `inside the loopable ${section.kind} (loop-extended)`,
      loop: {
        sectionStartBeat: section.startBeat,
        sectionEndBeat: section.endBeat,
      },
    };
  }
  return null;
}

/**
 * The rate-1 families: a drop-cut (beatmatched for its two beats when
 * the tempo evidence allows, a plain cut when it does not), else a
 * filter fade — echo-flavoured when the outgoing is playing out loud
 * to its very end. Chosen when beatmatching was refused, or when even
 * the referee could not make a blend honest.
 */
function authorRateOneJoin(
  request: RecipeRequest,
  ctx: AuthorContext,
  only?: "drop-cut" | "filter-fade",
): TransitionRecipe | null {
  const { outgoing, incoming } = request;
  const outMap = outgoing.beatMap;
  const inMap = incoming.beatMap;
  const { profile, entry, keyFit, stretch, nowBeat, totalBeatsA } = ctx;
  const minLead = profile.minLeadBeats;
  // The beatmatched CUT below holds B at rate on the deck for its
  // two beats — a rendition cannot serve it (the deck would keep
  // playing the retimed copy for the whole track, far past the
  // cut's promise), so this family gates on RATE viability alone.
  // A stretch-only pair takes the plain cut here, as it did before
  // renditions existed.
  const beatmatchViable = ctx.rateBeatmatchViable;
  const phrase = phraseBeats(outMap, 4);

  // A landing point for A: the first phrase boundary with enough
  // lead, walked back if it would overrun the track.
  let endBeat = Math.ceil((nowBeat + minLead - EPSILON) / phrase) * phrase;
  while (
    endBeat > nowBeat &&
    timeAtBeat(outMap, endBeat) > outMap.durationSec + EPSILON
  ) {
    endBeat -= phrase;
  }
  const endSec = timeAtBeat(outMap, endBeat);
  const leadInSec = Math.max(0, endSec - request.outgoingPositionSec);

  const strongDrop = incoming.drops.find(
    (drop) =>
      drop.beat >= profile.minLeadBeats &&
      drop.strength >= profile.minDropCutStrength &&
      drop.timeSec <= inMap.durationSec - 2,
  );

  if (only !== "filter-fade" && strongDrop && endBeat - nowBeat >= 1) {
    const dropSec = timeAtBeat(inMap, strongDrop.beat);
    if (beatmatchViable) {
      // Beatmatched cut: two beats of matched overlap, the drop
      // landing exactly as A leaves.
      const blendBeats = 2;
      const durationMs = blendBeats * secondsPerBeat(outMap.bpm) * 1000;
      const startBSec = Math.max(
        0,
        timeAtBeat(inMap, strongDrop.beat - blendBeats),
      );
      const rateB = outMap.bpm / inMap.bpm;
      return {
        version: 1,
        preset: "beatmatched-cut",
        overlap: {
          startAMs: (endSec - durationMs / 1000) * 1000,
          startBMs: startBSec * 1000,
          durationMs,
          durationBars: blendBeats / outMap.beatsPerBar,
          beatmatched: true,
          rateA: 1,
          rateB,
          stretchB: null,
          bpmA: outMap.bpm,
          bpmB: inMap.bpm,
        },
        leadInSec: Math.max(0, leadInSec - durationMs / 1000),
        automation: buildAutomation({
          preset: "beatmatched-cut",
          durationMs,
          swapAtMs: durationMs,
          openMidHigh: false,
          filterSweep: false,
          rateB,
          rateReturnMs: rateReturnMs(incoming, strongDrop.beat, profile),
          echoTailMs: null,
        }),
        loops: [],
        fx: {},
        fingerprints: fingerprintsOf(outgoing, incoming),
        fallback: fallbackNote(),
        evidence: {
          entryReason: `drop-cut onto the strongest drop (strength ${strongDrop.strength.toFixed(2)})`,
          exitReason: "a phrase boundary, cut as the drop lands",
          vocalOverlap: 0,
          vocalEvidence: "trusted",
          tempoStretch: stretch,
          keyScore: keyFit?.score ?? null,
          refereeShortened: false,
        },
      };
    }
    return {
      version: 1,
      preset: "cut",
      overlap: {
        startAMs: endSec * 1000,
        startBMs: dropSec * 1000,
        durationMs: 0,
        durationBars: 0,
        beatmatched: false,
        rateA: 1,
        rateB: 1,
        stretchB: null,
        bpmA: outMap.bpm,
        bpmB: inMap.bpm,
      },
      leadInSec,
      automation: buildAutomation({
        preset: "cut",
        durationMs: 0,
        swapAtMs: null,
        openMidHigh: false,
        filterSweep: false,
        rateB: 1,
        rateReturnMs: 0,
        echoTailMs: null,
      }),
      loops: [],
      fx: {},
      fingerprints: fingerprintsOf(outgoing, incoming),
      fallback: fallbackNote(),
      evidence: {
        entryReason: `cut onto the strongest drop (strength ${strongDrop.strength.toFixed(2)})`,
        exitReason: "a phrase boundary",
        vocalOverlap: 0,
        vocalEvidence: "trusted",
        tempoStretch: stretch,
        keyScore: keyFit?.score ?? null,
        refereeShortened: false,
      },
    };
  }

  // Asked for a drop-cut only, and none was honestly available.
  if (only === "drop-cut") return null;

  // Filter fade over the outgoing's last full section (or its last
  // eight beats), the incoming entering at its chosen entry.
  const fadeBeats = 8;
  let exitBeat = endBeat - fadeBeats;
  const lastSection = (outgoing.sections ?? [])
    .filter(
      (s) =>
        s.startBeat >= nowBeat + minLead &&
        s.startBeat + fadeBeats <= totalBeatsA,
    )
    .pop();
  if (lastSection) exitBeat = lastSection.startBeat;
  if (exitBeat < nowBeat + 1 || exitBeat + fadeBeats > totalBeatsA + EPSILON) {
    return null;
  }
  const startASec = timeAtBeat(outMap, exitBeat);
  const durationMs = fadeBeats * secondsPerBeat(outMap.bpm) * 1000;
  const startBSec = Math.max(
    0,
    timeAtBeat(inMap, entry.beat) - durationMs / 1000,
  );
  const playsOut = exitBeat + fadeBeats >= totalBeatsA - EPSILON;
  const tail = tailEnergy(outgoing);
  const echo =
    playsOut && tail !== null && tail >= 0.08
      ? {
          delaySec: dottedEighthSec(outMap.bpm),
          feedback: 0.38,
          wet: Math.min(0.6, Math.max(0.3, 0.3 + tail)),
          divisionBeats: 0.75,
        }
      : undefined;
  return {
    version: 1,
    preset: "fade",
    overlap: {
      startAMs: startASec * 1000,
      startBMs: startBSec * 1000,
      durationMs,
      durationBars: fadeBeats / outMap.beatsPerBar,
      beatmatched: false,
      rateA: 1,
      rateB: 1,
      stretchB: null,
      bpmA: outMap.bpm,
      bpmB: inMap.bpm,
    },
    leadInSec: Math.max(0, startASec - request.outgoingPositionSec),
    automation: buildAutomation({
      preset: "fade",
      durationMs,
      swapAtMs: null,
      openMidHigh: false,
      filterSweep: true,
      rateB: 1,
      rateReturnMs: 0,
      echoTailMs: echo ? secondsPerBeat(outMap.bpm) * 1000 : null,
    }),
    loops: [],
    fx: echo ? { echo } : {},
    fingerprints: fingerprintsOf(outgoing, incoming),
    fallback: fallbackNote(),
    evidence: {
      entryReason: entry.reason,
      exitReason: lastSection
        ? `the last ${lastSection.kind} section, faded`
        : "the final eight beats, faded",
      vocalOverlap: 0,
      vocalEvidence: "trusted",
      tempoStretch: stretch,
      keyScore: keyFit?.score ?? null,
      refereeShortened: false,
    },
  };
}
