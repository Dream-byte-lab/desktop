// authors.ts — candidate generation for the liveRave rebuild
// (design §3.3). Pure and environment-pure (§8.4): facts in,
// candidate documents out; every fit/geometry computation goes
// through the kernel seam (kernel.ts). Infeasible candidates are
// NOT generated — the reason is recorded in `rejected` instead.
//
// BEAT-SPACE RULING (coordinator, binding): in every JoinRecipe
// emitted here, curve points and block atBeat values are beats
// relative to the OVERLAP START — beat 0 is the moment the outgoing
// track reaches exitAnchorMs and the incoming track is at
// entryAnchorMs. Curves nominally span [0, overlapBeats]; fx tails
// and stop-exit runouts may extend past overlapBeats; nothing starts
// before beat −8 (this author set in fact never starts before 0).
// The performer's beat→seconds conversion uses the OUTGOING track's
// grid at the exit anchor.
//
// PERFORMER CONTRACT (Wave 2B, binding — the performer is built and
// tested against exactly these conventions):
// - Curve units: gain curves are LINEAR multipliers (1 = unity).
//   EQ curves (low/mid/high) are LINEAR multipliers the performer
//   maps to dB (1 = 0 dB, 0.2 ≈ −14 dB, a full bass cut ≈ 0.02–0.05).
//   Filter curves are Hz absolute in [30, 20000] (20000 = open).
// - FxBlock.params use ONLY the performer's keys, per kind:
//   reverb {wet, decay}; delay {wet, beats, feedback};
//   spiral {wet, beats, feedbackMax, freqStart, freqEnd};
//   flanger {wet, rate, depth}; phaser {wet, rate, depth};
//   saturation {wet, drive}; gating {wet, division, depth, low};
//   slip-roll {wet, sliceBeats}. (Full key vocabulary: wet, decay,
//   timeSec, beats, feedback, feedbackMax, freqStart, freqEnd,
//   drive, rate, depth, division, low, sliceBeats.)
// - LoopBlocks carry no atBeat: the performer sets the loop points
//   when the recipe is performed and the loop engages when the
//   playhead reaches the span. Loop-blend spans therefore sit in
//   track time INSIDE the outgoing's outro, and the recipe's exit
//   anchor is the span's END.
// - A spinback JogBlock means the window BEHIND the playhead at
//   atBeat, of length `beats`. On side A it is TERMINAL (no resume)
//   — authored only in stop-exit joins. Every other scratch/jog
//   block is performed WITH resume: the deck continues after the
//   block, and windows here are shaped for that.
//
// Vocal safety is decided HERE, at authoring: blend geometry is
// searched (exit/entry phrase shifts, shorter overlaps) so that
// witnessed vocal windows do not collide, and the resulting safety
// is reported as evidence — never re-judged later (§3 preamble).
//
// Every candidate carries authored.evidence = the raw component
// record { tempoFit, keyFit, phraseFit, structureFit, energyFit,
// vocalSafety } computed by the kernel. That record is the
// PairSupply document payload (§8.1): complete for every candidate,
// with NO family-derived term in it (§4 invariant 2). Fx dressings
// are their own candidates (the host's family, fx blocks added, the
// dressing named in authored.notes) with the host's evidence — a
// dressing is never surcharged against its base (§3.3).

import type { FactPhrase, TrackFacts } from "./facts";
import {
  beatmatchRate,
  blendGeometry,
  clamp01,
  energyArcFit,
  keyFitScore,
  phraseAlignmentScore,
  relativeWindowEnergy,
  tempoFit,
  trackEnergyLevel,
  trackMsPerBeat,
  trackPeakEnergy,
  vocalSafety,
  windowTransientScore,
} from "./kernel";
import type {
  CurvePoint,
  FxBlock,
  FxKind,
  JogBlock,
  JoinBlock,
  JoinCurves,
  JoinFamily,
  JoinRecipe,
  ScratchBlock,
  ScratchTechnique,
} from "./recipe";
import { SCRATCH_TECHNIQUES } from "./recipe";
import type { Shaping } from "./shaping";

// ---------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------

export interface AuthorContext {
  /** Position in the set's energy arc, 0..1. */
  arcPosition: number;
  shaping: Shaping;
}

export interface RejectedCandidate {
  family: string;
  reason: string;
}

export interface AuthorResult {
  candidates: JoinRecipe[];
  rejected: RejectedCandidate[];
}

/** Fx kinds a recipe carries (empty for undressed candidates). */
export function fxKindsOfRecipe(recipe: JoinRecipe): FxKind[] {
  const kinds: FxKind[] = [];
  for (const block of recipe.blocks) {
    if (block.type === "fx" && !kinds.includes(block.kind)) {
      kinds.push(block.kind);
    }
  }
  return kinds;
}

/** True when a candidate carries any fx dressing block. */
export function isFxDressed(recipe: JoinRecipe): boolean {
  return recipe.blocks.some((block) => block.type === "fx");
}

// ---------------------------------------------------------------------
// Thresholds (stated, with reasons)
// ---------------------------------------------------------------------

/** Sustained beatmatch rates must sit inside this window (§3.3). */
export const RATE_FEASIBILITY_MIN = 0.92;
export const RATE_FEASIBILITY_MAX = 1.08;

/** Distant keys (keyFit compatible = false) cap blend overlaps here. */
export const DISTANT_KEY_BLEND_CAP_BEATS = 8;

/** A scratch window must be witnessed THIS quiet (graded mean). */
export const SCRATCH_VOCAL_MAX = 0.25;

/**
 * Transient-score floors per scratch technique (window evidence).
 *
 * Wave 7 recalibration, from measured evidence (see the addendum in
 * investigation/liverave-distribution-results.md): over the fixture
 * library's witnessed-quiet 8-beat windows (n=278, kernel
 * windowTransientScore), the score distribution is p50 0.31, p75
 * 0.40, p90 0.50, max 0.77; over the head-entry windows the authors
 * actually sample, the maximum is 0.454. The old floors for
 * transformer (0.55, ≈p94) and crab (0.60, ≈p96) sat above every
 * sampled window the library produces, so both techniques generated
 * zero candidates on real-shaped reads while saturating (≈1.0) on
 * the hand fixtures. The floors below sit at ≈p48 / p63 / p74 /
 * p86 / p90 of the measured witnessed-quiet distribution, in the
 * same technique order as before: genuine scratch-shaped evidence
 * (a quiet window with a transient attack) clears them, flat
 * material does not. The witnessed-quiet vocal gate itself
 * (SCRATCH_VOCAL_MAX) is unchanged.
 */
export const SCRATCH_TRANSIENT_FLOORS: Record<ScratchTechnique, number> = {
  baby: 0.3,
  chirp: 0.35,
  transformer: 0.45,
  flare: 0.4,
  crab: 0.5,
};

/** Window length floors per scratch technique, in beats. */
export const SCRATCH_WINDOW_BEATS: Record<ScratchTechnique, number> = {
  baby: 4,
  chirp: 4,
  transformer: 8,
  flare: 8,
  crab: 8,
};

/** Stop-exit shape lines, in beats of outgoing tail. */
export const BRAKE_MIN_TAIL_BEATS = 24;
export const SPINBACK_MIN_RUNWAY_BEATS = 12;

/**
 * Echo-out evidence lines (Wave 7). An echo-out repeats the
 * outgoing tail through its 12-beat overlap, so it is authored only
 * at an exit anchor where a tail worth echoing measurably exists:
 * at least the overlap's own length of track after the anchor,
 * carrying at least a quarter of the track's peak energy on
 * average. The anchor is SEARCHED over the exit phrases (latest
 * first), the same authoring pattern the blend geometry search
 * uses — Wave 5 authored one echo-out for EVERY pair at the last
 * phrase unconditionally and it won 46.3% of autonomous draws by
 * candidate volume (suitability 0.573, below blend's 0.767), and
 * gating it at the last phrase alone left most tracks' genuine
 * earlier tails unusable (measured last-phrase tails run 0.3–15
 * beats on the fixture library, while the phrase before typically
 * holds a full 16-beat phrase of material). If NO exit phrase
 * offers the tail, no echo-out is authored for the pair.
 */
export const ECHO_MIN_TAIL_BEATS = 12;
export const ECHO_MIN_TAIL_ENERGY = 0.25;

// ---------------------------------------------------------------------
// Internal draft (evidence assembled at finalise time)
// ---------------------------------------------------------------------

interface Draft {
  family: JoinFamily;
  technique?: ScratchTechnique;
  variant: string;
  exitAnchorMs: number;
  entryAnchorMs: number;
  overlapBeats: number;
  rates: JoinRecipe["rates"];
  curves: JoinCurves;
  blocks: JoinBlock[];
  notes: string[];
  phraseFit: number;
  structureFit: number;
  vocalSafety: number;
}

// ---------------------------------------------------------------------
// Curve builders (all points in overlap-relative beats, §ruling)
// ---------------------------------------------------------------------

function flatCurve(value: number): CurvePoint[] {
  return [{ atBeat: 0, value }];
}

function flatEq(): JoinCurves["eqA"] {
  return { low: flatCurve(1), mid: flatCurve(1), high: flatCurve(1) };
}

/** Blend curves with the bass swap crossing at the swap bar. */
function blendCurves(overlapBeats: number, swapBeat: number): JoinCurves {
  const swapLo = Math.min(Math.max(swapBeat - 2, 0), overlapBeats);
  const swapHi = Math.min(Math.max(swapBeat + 2, swapLo), overlapBeats);
  return {
    gainA: [
      { atBeat: 0, value: 1 },
      { atBeat: overlapBeats, value: 0 },
    ],
    gainB: [
      { atBeat: 0, value: 0 },
      { atBeat: overlapBeats, value: 1 },
    ],
    eqA: {
      // Linear multipliers (performer maps to dB): 0.04 is the full
      // bass cut at the bottom of the swap.
      low: [
        { atBeat: 0, value: 1 },
        { atBeat: swapLo, value: 1 },
        { atBeat: swapHi, value: 0.04 },
      ],
      mid: [
        { atBeat: 0, value: 1 },
        { atBeat: swapBeat, value: 0.85 },
      ],
      high: [
        { atBeat: 0, value: 1 },
        { atBeat: swapBeat, value: 0.9 },
      ],
    },
    eqB: {
      low: [
        { atBeat: 0, value: 0.04 },
        { atBeat: swapLo, value: 0.04 },
        { atBeat: swapHi, value: 1 },
      ],
      mid: [
        { atBeat: 0, value: 0.85 },
        { atBeat: swapBeat, value: 1 },
      ],
      high: [
        { atBeat: 0, value: 0.9 },
        { atBeat: swapBeat, value: 1 },
      ],
    },
    filterA: flatCurve(20_000),
    filterB: flatCurve(20_000),
  };
}

function cutCurves(overlapBeats: number, dropBeat: number): JoinCurves {
  const before = Math.max(0, dropBeat - 0.5);
  return {
    gainA: [
      { atBeat: 0, value: 1 },
      { atBeat: before, value: 1 },
      { atBeat: dropBeat, value: 0 },
    ],
    gainB: [
      { atBeat: 0, value: 0.12 },
      { atBeat: before, value: 0.12 },
      { atBeat: dropBeat, value: 1 },
      { atBeat: overlapBeats, value: 1 },
    ],
    eqA: flatEq(),
    eqB: flatEq(),
    filterA: flatCurve(20_000),
    filterB: flatCurve(20_000),
  };
}

function filterFadeCurves(overlapBeats: number): JoinCurves {
  return {
    gainA: [
      { atBeat: 0, value: 1 },
      { atBeat: overlapBeats, value: 0 },
    ],
    gainB: [
      { atBeat: 0, value: 0 },
      { atBeat: overlapBeats, value: 1 },
    ],
    eqA: flatEq(),
    eqB: flatEq(),
    filterA: [
      { atBeat: 0, value: 20_000 },
      { atBeat: overlapBeats, value: 350 },
    ],
    filterB: [
      { atBeat: 0, value: 350 },
      { atBeat: overlapBeats, value: 20_000 },
    ],
  };
}

function echoOutCurves(overlapBeats: number): JoinCurves {
  // A descending stair of echoes on A; B rises over the last bars.
  const gainA: CurvePoint[] = [];
  const steps = Math.max(2, Math.floor(overlapBeats / 2));
  for (let i = 0; i <= steps; i += 1) {
    gainA.push({
      atBeat: (overlapBeats * i) / steps,
      value: i === steps ? 0 : 1 - (0.75 * i) / steps,
      easing: i < steps ? "step" : "linear",
    });
  }
  const riseStart = Math.max(0, overlapBeats - 4);
  return {
    gainA,
    gainB: [
      { atBeat: 0, value: 0 },
      { atBeat: riseStart, value: 0 },
      { atBeat: overlapBeats, value: 1 },
    ],
    eqA: flatEq(),
    eqB: flatEq(),
    filterA: flatCurve(20_000),
    filterB: flatCurve(20_000),
  };
}

// ---------------------------------------------------------------------
// authorCandidates
// ---------------------------------------------------------------------

export function authorCandidates(
  factsA: TrackFacts,
  factsB: TrackFacts,
  ctx: AuthorContext,
): AuthorResult {
  const { shaping } = ctx;
  const arcPosition = clamp01(ctx.arcPosition);
  const candidates: JoinRecipe[] = [];
  const rejected: RejectedCandidate[] = [];
  let sequence = 0;

  // --- Pair-level evidence and feasibility --------------------------
  const bpmA = factsA.tempo.bpm;
  const bpmB = factsB.tempo.bpm;
  const pairTempoFit = tempoFit(bpmA, bpmB);
  const keyFit = factsA.keyFitTo(factsB);
  const pairKeyScore = keyFitScore(keyFit);
  const pairEnergyFit = energyArcFit(
    trackEnergyLevel(factsB),
    arcPosition,
    shaping.bends.arcSteepness,
  );
  const distantKeys = keyFit !== null && !keyFit.compatible;

  const msA = trackMsPerBeat(factsA) ?? 500;
  const msB = trackMsPerBeat(factsB) ?? 500;
  const durationA = factsA.durationMs;
  const durationB = factsB.durationMs;
  const minPlayA = factsA.minimumPlayMs ?? 0;

  const ratio = beatmatchRate(bpmA, bpmB);
  const trustedPair = factsA.beatmatchTrusted && factsB.beatmatchTrusted;
  const beatmatchedFeasible =
    trustedPair &&
    ratio !== null &&
    ratio >= RATE_FEASIBILITY_MIN &&
    ratio <= RATE_FEASIBILITY_MAX;
  const matchedRates: JoinRecipe["rates"] = beatmatchedFeasible
    ? { rateA: 1, rateB: ratio as number, beatmatched: true }
    : { rateA: 1, rateB: 1, beatmatched: false };
  const rate1Rates: JoinRecipe["rates"] = {
    rateA: 1,
    rateB: 1,
    beatmatched: false,
  };
  // Theatre/utility families ride the matched rates when the pair
  // supports them and rate 1 when it does not (§6 degradation).
  const utilityRates = beatmatchedFeasible ? matchedRates : rate1Rates;
  // Nudge bend: the residual drift correction IS the sustained rate
  // offset; only meaningful (and only ≠ 1) when tempos differ.
  const nudgeBend =
    beatmatchedFeasible && ratio !== null && ratio !== 1 ? ratio : null;

  const beatOf = (facts: TrackFacts, ms: number): number => {
    const beat = facts.beatAtMs(ms);
    if (beat !== null) return beat;
    const per = trackMsPerBeat(facts);
    return per === null ? 0 : ms / per;
  };
  const msAtBeat = (facts: TrackFacts, beat: number): number | null => {
    const ms = facts.timeAtBeatMs(beat);
    if (ms !== null) return ms;
    const per = trackMsPerBeat(facts);
    return per === null ? null : beat * per;
  };

  // --- Anchor geography ----------------------------------------------
  const exitPhrases = factsA.phrases.filter(
    (phrase) =>
      phrase.startMs >= minPlayA - 1 &&
      (durationA === null || phrase.endMs <= durationA + 1),
  );
  const outroA = factsA.outro;
  let defaultExitPhrase: FactPhrase | null = null;
  if (exitPhrases.length > 0) {
    if (outroA) {
      defaultExitPhrase =
        exitPhrases.find((p) => Math.abs(p.startMs - outroA.startMs) < 1) ??
        exitPhrases.find(
          (p) => outroA.startMs >= p.startMs && outroA.startMs < p.endMs,
        ) ??
        exitPhrases[exitPhrases.length - 1];
    } else {
      defaultExitPhrase = exitPhrases[exitPhrases.length - 1];
    }
  }
  const defaultExitMs =
    defaultExitPhrase?.startMs ??
    outroA?.startMs ??
    (durationA !== null ? durationA * 0.75 : 0);
  const defaultEntryPhrase = factsB.phrases[0] ?? null;
  const defaultEntryMs =
    defaultEntryPhrase?.startMs ?? factsB.intro?.startMs ?? 0;

  const tailBeatsAt = (exitMs: number): number =>
    durationA === null ? 64 : Math.max(0, (durationA - exitMs) / msA);
  const sectionAt = (facts: TrackFacts, ms: number) =>
    facts.sections.find((s) => ms >= s.startMs && ms < s.endMs) ?? null;

  // Exit heat: the energy of the body section that ends where the
  // exit begins, relative to the track's peak (a "hot" exit).
  const peakA = trackPeakEnergy(factsA);
  const bodySectionBefore = (ms: number) => {
    let best: TrackFacts["sections"][number] | null = null;
    for (const section of factsA.sections) {
      if (section.endMs <= ms + 1 && section.kind !== "outro") best = section;
    }
    return best;
  };
  const exitHeat = (exitMs: number): number => {
    const section = bodySectionBefore(exitMs);
    if (section && peakA > 0) return clamp01(section.energy / peakA);
    return relativeWindowEnergy(factsA, Math.max(0, exitMs - 8 * msA), exitMs);
  };
  const outroFalling = (exitMs: number): boolean => {
    if (!outroA) return false;
    const outroSection = sectionAt(factsA, outroA.startMs + 1);
    if (!outroSection) return false;
    // "Falling" is judged against the track's body level (the
    // strongest body section that ends before the outro), not the
    // immediately preceding section: an outro that follows a
    // breakdown still falls from the body of the track.
    let bodyPeak = 0;
    for (const section of factsA.sections) {
      if (section.endMs <= outroA.startMs + 1 && section.kind !== "outro") {
        bodyPeak = Math.max(bodyPeak, section.energy);
      }
    }
    if (bodyPeak <= 0) return false;
    return (
      outroSection.energy < bodyPeak * 0.85 &&
      exitMs >= outroA.startMs - 8 * msA
    );
  };
  const landingLevel = trackEnergyLevel(factsB);
  const hasLanding =
    landingLevel >= 0.45 ||
    factsB.drops.some(
      (drop) => durationB === null || drop.atMs <= durationB * 0.5,
    );

  // Overlap windows, per side, in that side's own track time. Under
  // matched rates both sides consume the overlap at A's tempo; at
  // rate 1 each side consumes it at its own tempo.
  const overlapWindowA = (exitMs: number, beats: number) => ({
    startMs: exitMs,
    endMs: exitMs + beats * msA,
  });
  const overlapWindowB = (
    entryMs: number,
    beats: number,
    matched: boolean,
  ) => ({
    startMs: entryMs,
    endMs: entryMs + beats * (matched ? msA : msB),
  });
  const safetyOver = (
    exitMs: number,
    entryMs: number,
    beats: number,
    matched: boolean,
  ): number => {
    const winA = overlapWindowA(exitMs, beats);
    const winB = overlapWindowB(entryMs, beats, matched);
    return vocalSafety(
      factsA.vocals.vocalActivityIn(winA.startMs, winA.endMs),
      factsB.vocals.vocalActivityIn(winB.startMs, winB.endMs),
    );
  };

  const phraseFitOf = (exitMs: number, entryMs: number): number =>
    clamp01(
      (phraseAlignmentScore(factsA, exitMs) +
        phraseAlignmentScore(factsB, entryMs)) /
        2,
    );
  const structureFitOf = (exitMs: number, entryMs: number): number => {
    const exitSection = sectionAt(factsA, exitMs + 1);
    const entrySection = sectionAt(factsB, entryMs + 1);
    const exitScore = !exitSection
      ? 0.6
      : exitSection.kind === "outro"
        ? 1
        : exitSection.kind === "chorus" || exitSection.kind === "drop"
          ? 0.8
          : 0.65;
    const entryScore = !entrySection
      ? 0.6
      : entrySection.kind === "intro"
        ? 1
        : 0.7;
    return clamp01((exitScore + entryScore) / 2);
  };

  function finalise(draft: Draft): JoinRecipe {
    sequence += 1;
    return {
      id: `join-${factsA.trackId}-${factsB.trackId}-${draft.family}-${draft.variant}-${sequence}`,
      family: draft.family,
      technique: draft.technique,
      outgoing: {
        trackId: factsA.trackId,
        audioHash: factsA.audioHash,
        exitAnchorMs: draft.exitAnchorMs,
        exitBeat: Math.max(0, beatOf(factsA, draft.exitAnchorMs)),
      },
      incoming: {
        trackId: factsB.trackId,
        audioHash: factsB.audioHash,
        entryAnchorMs: draft.entryAnchorMs,
        entryBeat: Math.max(0, beatOf(factsB, draft.entryAnchorMs)),
      },
      overlapBeats: draft.overlapBeats,
      rates: draft.rates,
      curves: draft.curves,
      blocks: draft.blocks,
      authored: {
        evidence: {
          tempoFit: pairTempoFit,
          keyFit: pairKeyScore,
          phraseFit: clamp01(draft.phraseFit),
          structureFit: clamp01(draft.structureFit),
          energyFit: pairEnergyFit,
          vocalSafety: clamp01(draft.vocalSafety),
        },
        notes: draft.notes,
      },
    };
  }

  // --- Blends ---------------------------------------------------------
  // Geometry search: for each size class, try the requested size,
  // then shorter sizes, across exit/entry phrase shifts, and keep
  // the geometry whose witnessed vocal windows collide least
  // (ties: requested size first, then smallest shift).
  interface BlendGeometryChoice {
    exitMs: number;
    entryMs: number;
    overlapBeats: number;
    swapBeat: number;
    safety: number;
  }
  function searchBlendGeometry(
    centreBeats: number,
  ): BlendGeometryChoice | null {
    if (!defaultExitPhrase && factsA.phrases.length > 0) return null;
    const beatsPerBar = Math.max(1, factsA.grid.beatsPerBar);
    const sizes: number[] = [];
    for (const size of [centreBeats, centreBeats - 4, 8]) {
      if (size >= 8 && !sizes.includes(size)) sizes.push(size);
    }
    const exitIndex = defaultExitPhrase
      ? exitPhrases.indexOf(defaultExitPhrase)
      : -1;
    const entryIndex = defaultEntryPhrase
      ? factsB.phrases.indexOf(defaultEntryPhrase)
      : -1;
    let best: BlendGeometryChoice | null = null;
    let bestScore = -Infinity;
    for (let s = 0; s < sizes.length; s += 1) {
      const geometry = blendGeometry({
        centreBeats: sizes[s],
        minBeats: 8,
        maxBeats: 32,
        beatsPerBar,
        capBeats: distantKeys ? DISTANT_KEY_BLEND_CAP_BEATS : undefined,
      });
      for (const exitShift of [0, -1, 1]) {
        const exitPhrase =
          exitIndex >= 0 ? exitPhrases[exitIndex + exitShift] : undefined;
        const exitMs = exitPhrase ? exitPhrase.startMs : defaultExitMs;
        if (exitIndex >= 0 && !exitPhrase) continue;
        for (const entryShift of [0, 1]) {
          const entryPhrase =
            entryIndex >= 0
              ? factsB.phrases[entryIndex + entryShift]
              : undefined;
          const entryMs = entryPhrase ? entryPhrase.startMs : defaultEntryMs;
          if (entryIndex >= 0 && !entryPhrase) continue;
          const safety = safetyOver(
            exitMs,
            entryMs,
            geometry.overlapBeats,
            true,
          );
          const score =
            safety * 10 -
            s * 0.5 -
            Math.abs(exitShift) * 0.25 -
            entryShift * 0.25;
          if (score > bestScore) {
            bestScore = score;
            best = {
              exitMs,
              entryMs,
              overlapBeats: geometry.overlapBeats,
              swapBeat: geometry.swapBeat,
              safety,
            };
          }
        }
      }
    }
    return best;
  }

  const bendRatio = shaping.bends.blendBeatsCentre / 16;
  const blendClasses: { label: string; centre: number }[] = [
    { label: "short", centre: 8 * bendRatio },
    { label: "standard", centre: 16 * bendRatio },
    { label: "long", centre: 28 * bendRatio },
  ];
  let standardBlend: Draft | null = null;

  if (!beatmatchedFeasible) {
    const reason = !trustedPair
      ? "beatmatch not trusted for this pair (tempo/grid confidence below the trust lines)"
      : "sustained rate ratio outside [0.92, 1.08]";
    rejected.push({ family: "blend", reason });
    rejected.push({ family: "loop-blend", reason });
    rejected.push({ family: "drop-cut", reason });
  } else {
    for (const blendClass of blendClasses) {
      const choice = searchBlendGeometry(blendClass.centre);
      if (!choice) {
        rejected.push({
          family: "blend",
          reason: `${blendClass.label} blend: no phrase at/after the minimum-play floor`,
        });
        continue;
      }
      const blocks: JoinBlock[] = [];
      const notes = [
        `${blendClass.label} blend, bass swap at beat ${choice.swapBeat}`,
        "phrase-aligned anchors; vocal-safe geometry chosen at authoring",
      ];
      if (distantKeys) notes.push("distant keys: overlap capped at 8 beats");
      // Nudge: drift correction rides long blends when the tempo
      // ratio implies one (bend = the ratio itself, in [0.92, 1.08]).
      if (blendClass.label === "long" && nudgeBend !== null) {
        const jog: JogBlock = {
          type: "jog",
          side: "B",
          kind: "nudge",
          atBeat: Math.floor(choice.overlapBeats / 2),
          beats: 4,
          bend: nudgeBend,
        };
        blocks.push(jog);
        notes.push("nudge jog: drift correction on the long blend");
      }
      const draft: Draft = {
        family: "blend",
        variant: blendClass.label,
        exitAnchorMs: choice.exitMs,
        entryAnchorMs: choice.entryMs,
        overlapBeats: choice.overlapBeats,
        rates: matchedRates,
        curves: blendCurves(choice.overlapBeats, choice.swapBeat),
        blocks,
        notes,
        phraseFit: phraseFitOf(choice.exitMs, choice.entryMs),
        structureFit: structureFitOf(choice.exitMs, choice.entryMs),
        vocalSafety: choice.safety,
      };
      if (blendClass.label === "standard") standardBlend = draft;
      candidates.push(finalise(draft));
    }

    // --- Loop-blend ---------------------------------------------------
    // Authored when the outro cannot host the long blend but a
    // loop span can stretch the exit (or the incoming intro).
    const longCentre = 28 * bendRatio;
    // The tail that matters is the OUTRO's own length: the loop
    // stretches the outro, so the "already fits" test must measure
    // the outro span, not the distance from the default exit phrase
    // (which can start a full phrase BEFORE the outro when the
    // phrase grid and the section boundary misalign — Wave 7
    // measurement: a 24-beat outro read as a 39-beat "tail" that
    // way, and loop-blend was rejected on a track it exists for).
    const tailBeats = outroA ? (outroA.endMs - outroA.startMs) / msA : 0;
    // Performer convention (see header): the loop span must sit
    // INSIDE the outgoing's outro, and the recipe's exit anchor is
    // the span's END — the performer sets the loop points ahead of
    // the exit and the playhead loops the span until it leaves at
    // its end, which is where the overlap begins.
    const loopSpanA = outroA
      ? factsA.loopSpans.find(
          (span) =>
            span.startMs >= outroA.startMs && span.endMs <= outroA.endMs,
        )
      : undefined;
    if (!loopSpanA) {
      rejected.push({
        family: "loop-blend",
        reason:
          "no loopable span (>= 8 beats) inside the outgoing track's outro",
      });
    } else if (tailBeats >= longCentre) {
      rejected.push({
        family: "loop-blend",
        reason: `outro (${Math.round(tailBeats)} beats) already fits the long blend; looping adds nothing`,
      });
    } else {
      const spanBeats = Math.max(
        1,
        Math.round((loopSpanA.endMs - loopSpanA.startMs) / msA),
      );
      const overlapBeats = 24;
      const wraps = Math.max(1, Math.ceil(overlapBeats / spanBeats));
      const exitMs = loopSpanA.endMs;
      const loopBlock: JoinBlock = {
        type: "loop",
        side: "A",
        startMs: loopSpanA.startMs,
        endMs: loopSpanA.endMs,
        wraps,
      };
      const geometry = blendGeometry({
        centreBeats: overlapBeats,
        minBeats: 8,
        maxBeats: 32,
        beatsPerBar: Math.max(1, factsA.grid.beatsPerBar),
        capBeats: distantKeys ? DISTANT_KEY_BLEND_CAP_BEATS : undefined,
      });
      const draft: Draft = {
        family: "loop-blend",
        variant: "outro-loop",
        exitAnchorMs: exitMs,
        entryAnchorMs: defaultEntryMs,
        overlapBeats: geometry.overlapBeats,
        rates: matchedRates,
        curves: blendCurves(geometry.overlapBeats, geometry.swapBeat),
        blocks: [loopBlock],
        notes: [
          `outro tail too short for the long blend; outro loop span wraps x${wraps}, exit anchor at the span's end`,
        ],
        phraseFit: phraseFitOf(exitMs, defaultEntryMs),
        structureFit: clamp01(0.6 + 0.4 * Math.min(1, spanBeats / 16)),
        vocalSafety: safetyOver(
          exitMs,
          defaultEntryMs,
          geometry.overlapBeats,
          true,
        ),
      };
      candidates.push(finalise(draft));
    }

    // --- Drop-cut -------------------------------------------------------
    const dropLeadBeats = 4;
    let dropAuthored = false;
    const sortedDrops = [...factsB.drops].sort(
      (a, z) => z.strength - a.strength,
    );
    for (const drop of sortedDrops) {
      const dropBeatB = beatOf(factsB, drop.atMs);
      const entryBeatB = dropBeatB - dropLeadBeats;
      if (entryBeatB < 0) continue;
      const entryMs = msAtBeat(factsB, entryBeatB);
      if (entryMs === null) continue;
      // The drop must land on an outgoing phrase end: exit is one
      // lead before the first phrase end at/after the default exit.
      const phraseEnd =
        factsA.phrases.find(
          (p) => p.endMs >= defaultExitMs && p.startMs >= minPlayA - 1,
        ) ?? null;
      if (!phraseEnd) continue;
      const exitMs = phraseEnd.endMs - dropLeadBeats * msA;
      if (exitMs < minPlayA) continue;
      const overlapBeats = 8;
      const draft: Draft = {
        family: "drop-cut",
        variant: "drop-landing",
        exitAnchorMs: exitMs,
        entryAnchorMs: entryMs,
        overlapBeats,
        rates: matchedRates,
        curves: cutCurves(overlapBeats, dropLeadBeats),
        blocks: [],
        notes: [
          `incoming drop (strength ${drop.strength.toFixed(1)}) lands on the outgoing phrase end at overlap beat ${dropLeadBeats}`,
        ],
        phraseFit: clamp01(
          (phraseAlignmentScore(factsA, phraseEnd.endMs) +
            phraseAlignmentScore(factsB, drop.atMs)) /
            2,
        ),
        structureFit: clamp01(0.45 + drop.strength / 6),
        vocalSafety: safetyOver(exitMs, entryMs, overlapBeats, true),
      };
      candidates.push(finalise(draft));
      dropAuthored = true;
      break;
    }
    if (!dropAuthored) {
      rejected.push({
        family: "drop-cut",
        reason:
          factsB.drops.length === 0
            ? "incoming track has no measured drop to land"
            : "no drop lands on an outgoing phrase end at/after the minimum-play floor",
      });
    }
  }

  // --- Filter-fade (always rate 1) + echo-out (rate 1, gated) --------
  // Filter-fade stays unconditional: it needs no tail evidence —
  // its filter sweep is the exit gesture. Echo-out is evidence-led
  // (ECHO_MIN_TAIL_* above): no measured tail, no echo.
  const utilityGeometry: { family: JoinFamily; overlapBeats: number }[] = [
    { family: "filter-fade", overlapBeats: 8 },
    { family: "echo-out", overlapBeats: 12 },
  ];
  // Echo anchor search (see ECHO_MIN_TAIL_* above): latest exit
  // phrase first; the default exit is the only candidate anchor
  // when the track has no usable phrases.
  const echoAnchors: number[] =
    exitPhrases.length > 0
      ? exitPhrases.map((phrase) => phrase.startMs)
      : [defaultExitMs];
  let echoExitMs: number | null = null;
  for (let i = echoAnchors.length - 1; i >= 0; i -= 1) {
    const anchor = echoAnchors[i];
    if (tailBeatsAt(anchor) < ECHO_MIN_TAIL_BEATS) continue;
    const windowEnd =
      durationA === null
        ? anchor + ECHO_MIN_TAIL_BEATS * msA
        : Math.min(durationA, anchor + ECHO_MIN_TAIL_BEATS * msA);
    if (
      relativeWindowEnergy(factsA, anchor, windowEnd) < ECHO_MIN_TAIL_ENERGY
    ) {
      continue;
    }
    echoExitMs = anchor;
    break;
  }
  const echoFeasible = echoExitMs !== null;
  if (!echoFeasible) {
    rejected.push({
      family: "echo-out",
      reason:
        `no exit phrase offers a tail worth echoing ` +
        `(needs >= ${ECHO_MIN_TAIL_BEATS} beats of tail at ` +
        `>= ${ECHO_MIN_TAIL_ENERGY} relative energy at the exit anchor)`,
    });
  }
  for (const utility of utilityGeometry) {
    if (utility.family === "echo-out" && !echoFeasible) continue;
    const exitMs =
      utility.family === "echo-out" ? (echoExitMs as number) : defaultExitMs;
    const draft: Draft = {
      family: utility.family,
      variant: "rate-1",
      exitAnchorMs: exitMs,
      entryAnchorMs: defaultEntryMs,
      overlapBeats: utility.overlapBeats,
      rates: rate1Rates,
      curves:
        utility.family === "filter-fade"
          ? filterFadeCurves(utility.overlapBeats)
          : echoOutCurves(utility.overlapBeats),
      blocks: [],
      notes: [
        "rate-1 join: no beatmatch sustained, so it competes on evidence for any pair",
      ],
      phraseFit: phraseFitOf(exitMs, defaultEntryMs),
      structureFit: clamp01(structureFitOf(exitMs, defaultEntryMs) * 0.92),
      vocalSafety: safetyOver(
        exitMs,
        defaultEntryMs,
        utility.overlapBeats,
        utilityRates.beatmatched,
      ),
    };
    candidates.push(finalise(draft));
  }

  // --- Stop exits -------------------------------------------------------
  // A falling-energy outro and a real incoming landing are required.
  // Brake for tails >= 24 beats; vinyl-stop for short tails;
  // spinback when runway and landing both exist.
  const stopExitMs = outroA
    ? Math.max(defaultExitMs, outroA.startMs)
    : defaultExitMs;
  const stopTailBeats = tailBeatsAt(stopExitMs);
  const stopDrafts: Draft[] = [];
  if (!outroA) {
    rejected.push({
      family: "stop-exit",
      reason: "no measured outro to stop out of",
    });
  } else if (!outroFalling(stopExitMs)) {
    rejected.push({
      family: "stop-exit",
      reason: "outro energy does not fall from the preceding body section",
    });
  } else if (!hasLanding) {
    rejected.push({
      family: "stop-exit",
      reason:
        "incoming track offers no real landing (weak body energy, no early drop)",
    });
  } else {
    const stopStructure = clamp01(
      0.35 +
        0.65 *
          (1 -
            (sectionAt(factsA, outroA.startMs + 1)?.energy ?? 0) /
              Math.max(
                0.01,
                bodySectionBefore(outroA.startMs)?.energy ?? 0.01,
              )),
    );
    const stopSafety = (overlapBeats: number) =>
      safetyOver(
        stopExitMs,
        defaultEntryMs,
        overlapBeats,
        utilityRates.beatmatched,
      );
    if (stopTailBeats >= BRAKE_MIN_TAIL_BEATS) {
      const jog: JogBlock = {
        type: "jog",
        side: "A",
        kind: "brake",
        atBeat: 0,
        beats: 8,
        peakRate: 0,
      };
      stopDrafts.push({
        family: "stop-exit",
        variant: "brake",
        exitAnchorMs: stopExitMs,
        entryAnchorMs: defaultEntryMs,
        overlapBeats: 12,
        rates: utilityRates,
        curves: {
          gainA: [
            { atBeat: 0, value: 1 },
            { atBeat: 8, value: 0.85 },
            { atBeat: 12, value: 0 },
          ],
          gainB: [
            { atBeat: 0, value: 0 },
            { atBeat: 4, value: 0 },
            { atBeat: 8, value: 1 },
            { atBeat: 12, value: 1 },
          ],
          eqA: flatEq(),
          eqB: flatEq(),
          filterA: flatCurve(20_000),
          filterB: flatCurve(20_000),
        },
        blocks: [jog],
        notes: [
          `brake stop: ${Math.round(stopTailBeats)}-beat falling outro tail wound down over 8 beats`,
        ],
        phraseFit: phraseFitOf(stopExitMs, defaultEntryMs),
        structureFit: stopStructure,
        vocalSafety: stopSafety(12),
      });
    } else {
      rejected.push({
        family: "stop-exit",
        reason: `brake needs a tail >= ${BRAKE_MIN_TAIL_BEATS} beats; this tail is ${Math.round(stopTailBeats)}`,
      });
    }
    if (stopTailBeats < BRAKE_MIN_TAIL_BEATS && stopTailBeats >= 4) {
      const jog: JogBlock = {
        type: "jog",
        side: "A",
        kind: "vinyl-stop",
        atBeat: 0,
        beats: 1.5,
        peakRate: 0,
      };
      stopDrafts.push({
        family: "stop-exit",
        variant: "vinyl-stop",
        exitAnchorMs: stopExitMs,
        entryAnchorMs: defaultEntryMs,
        overlapBeats: 4,
        rates: utilityRates,
        curves: {
          gainA: [
            { atBeat: 0, value: 1 },
            { atBeat: 1.5, value: 0.6 },
            { atBeat: 2, value: 0 },
          ],
          gainB: [
            { atBeat: 0, value: 0 },
            { atBeat: 2, value: 0 },
            { atBeat: 4, value: 1 },
          ],
          eqA: flatEq(),
          eqB: flatEq(),
          filterA: flatCurve(20_000),
          filterB: flatCurve(20_000),
        },
        blocks: [jog],
        notes: [
          `vinyl-stop: short ${Math.round(stopTailBeats)}-beat tail stopped dead in 1.5 beats`,
        ],
        phraseFit: phraseFitOf(stopExitMs, defaultEntryMs),
        structureFit: stopStructure,
        vocalSafety: stopSafety(4),
      });
    } else if (stopTailBeats >= BRAKE_MIN_TAIL_BEATS) {
      rejected.push({
        family: "stop-exit",
        reason: `vinyl-stop is for short tails; this tail is ${Math.round(stopTailBeats)} beats`,
      });
    }
    if (stopTailBeats >= SPINBACK_MIN_RUNWAY_BEATS) {
      const jog: JogBlock = {
        type: "jog",
        side: "A",
        kind: "spinback",
        atBeat: 0,
        beats: 3,
        peakRate: -1.6,
      };
      stopDrafts.push({
        family: "stop-exit",
        variant: "spinback",
        exitAnchorMs: stopExitMs,
        entryAnchorMs: defaultEntryMs,
        overlapBeats: 8,
        rates: utilityRates,
        curves: {
          gainA: [
            { atBeat: 0, value: 1 },
            { atBeat: 3, value: 0.4 },
            { atBeat: 4, value: 0 },
          ],
          gainB: [
            { atBeat: 0, value: 0 },
            { atBeat: 3, value: 0 },
            { atBeat: 5, value: 1 },
            { atBeat: 8, value: 1 },
          ],
          eqA: flatEq(),
          eqB: flatEq(),
          filterA: flatCurve(20_000),
          filterB: flatCurve(20_000),
        },
        blocks: [jog],
        notes: [
          `spinback (terminal on side A): the 3 beats behind the playhead rewound, ${Math.round(stopTailBeats)} beats of runway, into a real landing`,
        ],
        phraseFit: phraseFitOf(stopExitMs, defaultEntryMs),
        structureFit: stopStructure,
        vocalSafety: stopSafety(8),
      });
    } else {
      rejected.push({
        family: "stop-exit",
        reason: `spinback needs >= ${SPINBACK_MIN_RUNWAY_BEATS} beats of runway; this tail is ${Math.round(stopTailBeats)}`,
      });
    }
  }
  for (const draft of stopDrafts) candidates.push(finalise(draft));

  // Nudge as a standalone family member on the first stop join.
  if (nudgeBend !== null && stopDrafts.length > 0) {
    const host = stopDrafts[0];
    const jog: JogBlock = {
      type: "jog",
      side: "B",
      kind: "nudge",
      atBeat: Math.min(4, host.overlapBeats / 2),
      beats: 2,
      bend: nudgeBend,
    };
    candidates.push(
      finalise({
        ...host,
        variant: `${host.variant}-nudge`,
        blocks: [...host.blocks, jog],
        notes: [
          ...host.notes,
          "nudge jog: standalone drift correction on the stop join",
        ],
      }),
    );
  }

  // --- Scratch in / out --------------------------------------------------
  // Gate (the ONLY gate): the scratched window is witnessed-quiet
  // (witnessed && mean <= 0.25) and transient-rich. Technique
  // feasibility then reads window evidence alone: window length,
  // transient density, entry energy and drop landings.
  interface ScratchWindow {
    startMs: number;
    endMs: number;
    beats: number;
    vocalMean: number;
    witnessed: boolean;
    transient: number;
  }
  const scratchWindowOf = (
    facts: TrackFacts,
    startMs: number,
    beats: number,
  ): ScratchWindow => {
    const per = trackMsPerBeat(facts) ?? 500;
    const endMs = startMs + beats * per;
    const vocals = facts.vocals.vocalActivityIn(startMs, endMs);
    return {
      startMs,
      endMs,
      beats,
      vocalMean: vocals.mean,
      witnessed: vocals.witnessed,
      transient: windowTransientScore(facts, startMs, endMs),
    };
  };
  const windowQuiet = (window: ScratchWindow): boolean =>
    window.witnessed && window.vocalMean <= SCRATCH_VOCAL_MAX;

  // Scratch-in: B is scratched over A's exit. Head entry for most
  // techniques; flare rides a drop entry (the drop lands 8 beats
  // after the overlap starts, just past the scratch window).
  const scratchInHead = scratchWindowOf(factsB, defaultEntryMs, 8);
  const scratchOutWindow = scratchWindowOf(factsA, stopExitMs, 8);
  let firstScratchIn: Draft | null = null;

  function scratchDraft(args: {
    family: "scratch-in" | "scratch-out";
    technique: ScratchTechnique;
    window: ScratchWindow;
    exitMs: number;
    entryMs: number;
    entryIsDropLanding: boolean;
  }): Draft {
    const isIn = args.family === "scratch-in";
    const overlapBeats = args.window.beats + 4;
    const scratchBlock: ScratchBlock = {
      type: "scratch",
      side: isIn ? "B" : "A",
      technique: args.technique,
      atBeat: 0,
      beats: args.window.beats,
      windowStartMs: args.window.startMs,
      windowEndMs: args.window.endMs,
    };
    const otherSafety = isIn
      ? safetyOver(
          args.exitMs,
          args.entryMs,
          overlapBeats,
          utilityRates.beatmatched,
        )
      : safetyOver(
          args.exitMs,
          args.entryMs,
          overlapBeats,
          utilityRates.beatmatched,
        );
    return {
      family: args.family,
      technique: args.technique,
      variant: args.technique,
      exitAnchorMs: args.exitMs,
      entryAnchorMs: args.entryMs,
      overlapBeats,
      rates: utilityRates,
      curves: isIn
        ? {
            gainA: [
              { atBeat: 0, value: 1 },
              { atBeat: overlapBeats - 2, value: 0.6 },
              { atBeat: overlapBeats, value: 0 },
            ],
            gainB: [
              { atBeat: 0, value: 0.55 },
              { atBeat: args.window.beats, value: 0.8 },
              { atBeat: overlapBeats, value: 1 },
            ],
            eqA: flatEq(),
            eqB: flatEq(),
            filterA: flatCurve(20_000),
            filterB: flatCurve(20_000),
          }
        : {
            gainA: [
              { atBeat: 0, value: 0.9 },
              { atBeat: args.window.beats, value: 0.5 },
              { atBeat: overlapBeats, value: 0 },
            ],
            gainB: [
              { atBeat: 0, value: 0.25 },
              { atBeat: 2, value: 0.7 },
              { atBeat: overlapBeats, value: 1 },
            ],
            eqA: flatEq(),
            eqB: flatEq(),
            filterA: flatCurve(20_000),
            filterB: flatCurve(20_000),
          },
      blocks: [scratchBlock],
      notes: [
        `${args.technique} scratch over a witnessed-quiet, transient-rich window (transient ${args.window.transient.toFixed(2)})`,
        ...(args.entryIsDropLanding
          ? ["entry rides an incoming drop landing"]
          : []),
      ],
      phraseFit: phraseFitOf(args.exitMs, args.entryMs),
      structureFit: clamp01(0.4 + 0.6 * args.window.transient),
      vocalSafety: otherSafety,
    };
  }

  // scratch-in techniques over the head window
  if (!windowQuiet(scratchInHead)) {
    rejected.push({
      family: "scratch-in",
      reason: scratchInHead.witnessed
        ? `incoming entry window is vocal (mean ${scratchInHead.vocalMean.toFixed(2)} > ${SCRATCH_VOCAL_MAX}); scratching over a singing window is not authored`
        : "incoming entry window vocals are unwitnessed; scratch windows need witnessed evidence",
    });
  } else {
    for (const technique of SCRATCH_TECHNIQUES) {
      if (technique === "flare") continue; // flare authors below, on its landing
      const feasible =
        scratchInHead.beats >= SCRATCH_WINDOW_BEATS[technique] &&
        scratchInHead.transient >= SCRATCH_TRANSIENT_FLOORS[technique];
      if (!feasible) {
        rejected.push({
          family: "scratch-in",
          reason: `${technique}: window evidence insufficient (transient ${scratchInHead.transient.toFixed(2)} vs floor ${SCRATCH_TRANSIENT_FLOORS[technique]}, window ${scratchInHead.beats} beats)`,
        });
        continue;
      }
      const draft = scratchDraft({
        family: "scratch-in",
        technique,
        window: scratchInHead,
        exitMs: defaultExitMs,
        entryMs: defaultEntryMs,
        entryIsDropLanding: false,
      });
      if (firstScratchIn === null) firstScratchIn = draft;
      candidates.push(finalise(draft));
    }
    // Flare-in: needs a drop landing to click against.
    const flareDrop = factsB.drops.find((drop) => {
      const beat = beatOf(factsB, drop.atMs);
      return beat >= 8 && (durationB === null || drop.atMs <= durationB * 0.6);
    });
    if (!flareDrop) {
      rejected.push({
        family: "scratch-in",
        reason: "flare: no incoming drop landing to click against",
      });
    } else {
      const dropBeat = beatOf(factsB, flareDrop.atMs);
      const entryBeat = dropBeat - 8;
      const entryMs = msAtBeat(factsB, entryBeat);
      if (entryMs === null) {
        rejected.push({
          family: "scratch-in",
          reason: "flare: drop entry unmeasurable",
        });
      } else {
        const flareWindow = scratchWindowOf(factsB, entryMs, 8);
        if (
          windowQuiet(flareWindow) &&
          flareWindow.transient >= SCRATCH_TRANSIENT_FLOORS.flare
        ) {
          const draft = scratchDraft({
            family: "scratch-in",
            technique: "flare",
            window: flareWindow,
            exitMs: defaultExitMs,
            entryMs,
            entryIsDropLanding: true,
          });
          if (firstScratchIn === null) firstScratchIn = draft;
          candidates.push(finalise(draft));
        } else {
          rejected.push({
            family: "scratch-in",
            reason:
              "flare: the drop-entry window is not witnessed-quiet and transient-rich",
          });
        }
      }
    }
  }

  // Nudge as a standalone family member on the first scratch join.
  if (nudgeBend !== null && firstScratchIn !== null) {
    const host: Draft = firstScratchIn;
    const jog: JogBlock = {
      type: "jog",
      side: "B",
      kind: "nudge",
      atBeat: Math.min(4, host.overlapBeats / 2),
      beats: 2,
      bend: nudgeBend,
    };
    candidates.push(
      finalise({
        ...host,
        variant: `${host.variant}-nudge`,
        blocks: [...host.blocks, jog],
        notes: [
          ...host.notes,
          "nudge jog: standalone drift correction on the scratch join",
        ],
      }),
    );
  }

  // scratch-out techniques over the outgoing exit window
  if (!windowQuiet(scratchOutWindow)) {
    rejected.push({
      family: "scratch-out",
      reason: scratchOutWindow.witnessed
        ? `outgoing exit window is vocal (mean ${scratchOutWindow.vocalMean.toFixed(2)} > ${SCRATCH_VOCAL_MAX})`
        : "outgoing exit window vocals are unwitnessed; scratch windows need witnessed evidence",
    });
  } else {
    for (const technique of SCRATCH_TECHNIQUES) {
      // Flare-out clicks against the incoming landing instead of a
      // drop in the scratched window.
      const landingOk = technique !== "flare" || hasLanding;
      const feasible =
        landingOk &&
        scratchOutWindow.beats >= SCRATCH_WINDOW_BEATS[technique] &&
        scratchOutWindow.transient >= SCRATCH_TRANSIENT_FLOORS[technique];
      if (!feasible) {
        rejected.push({
          family: "scratch-out",
          reason:
            technique === "flare" && !hasLanding
              ? "flare: incoming track offers no landing to click against"
              : `${technique}: window evidence insufficient (transient ${scratchOutWindow.transient.toFixed(2)} vs floor ${SCRATCH_TRANSIENT_FLOORS[technique]})`,
        });
        continue;
      }
      const draft = scratchDraft({
        family: "scratch-out",
        technique,
        window: scratchOutWindow,
        exitMs: stopExitMs,
        entryMs: defaultEntryMs,
        entryIsDropLanding: technique === "flare",
      });
      candidates.push(finalise(draft));
    }
  }

  // --- Fx dressings -------------------------------------------------------
  // Dressings ride the standard blend ONLY. They are authored on
  // the blend's geometry (tail chains, entry washes, final-beat
  // chops all reference the blend's anchors), and each one is its
  // own candidate with the host's evidence — so a fallback host
  // multiplies that family's draw weight by candidate count with no
  // added evidence. Wave 5 let dressings ride the echo-out whenever
  // no blend was feasible: 303 of echo-out's 615 candidates were
  // dressed variants, the second half of its volume problem. When
  // no standard blend exists for a pair, no dressings are authored
  // for it (Wave 7).
  const dressingHost: Draft | null = standardBlend;
  if (dressingHost) {
    const host = dressingHost;
    const hostExitMs = host.exitAnchorMs;
    const hostEntryMs = host.entryAnchorMs;
    const hostOverlap = host.overlapBeats;
    const exitVocals = factsA.vocals.vocalActivityIn(
      hostExitMs,
      hostExitMs + hostOverlap * msA,
    );
    const hot = exitHeat(hostExitMs) >= 0.55;
    const exitWitnessed = exitVocals.witnessed;
    const hostTailBeats = tailBeatsAt(hostExitMs);
    const finalWindowTransient = windowTransientScore(
      factsA,
      hostExitMs + Math.max(0, hostOverlap - 4) * msA,
      hostExitMs + hostOverlap * msA,
    );
    const entryWindowRelative = relativeWindowEnergy(
      factsB,
      hostEntryMs,
      hostEntryMs + 4 * msB,
    );
    const entryVocals = factsB.vocals.vocalActivityIn(
      hostEntryMs,
      hostEntryMs + 4 * msB,
    );
    // GRIT's drop landing: a B drop landing at the join's end whose
    // own window is witnessed-quiet.
    const hostEntryBeat = beatOf(factsB, hostEntryMs);
    const gritDrop = factsB.drops.find((drop) => {
      const dropBeat = beatOf(factsB, drop.atMs);
      if (
        dropBeat < hostEntryBeat + hostOverlap - 4 ||
        dropBeat > hostEntryBeat + hostOverlap + 8
      ) {
        return false;
      }
      const window = factsB.vocals.vocalActivityIn(
        drop.atMs - 2 * msB,
        drop.atMs + 2 * msB,
      );
      return window.witnessed && window.mean <= SCRATCH_VOCAL_MAX;
    });

    interface Dressing {
      variant: string;
      note: string;
      feasible: boolean;
      reason: string;
      blocks: FxBlock[];
    }
    const dressings: Dressing[] = [
      {
        variant: "fx-tail-reverb",
        note: "fx-dressing: tail reverb on a hot witnessed exit",
        feasible: hot && exitWitnessed,
        reason: "tail reverb needs a hot, witnessed exit",
        blocks: [
          {
            type: "fx",
            side: "tail",
            kind: "reverb",
            atBeat: Math.max(0, hostOverlap - 2),
            beats: 6,
            params: { wet: 0.55, decay: 2.4 },
          },
        ],
      },
      {
        variant: "fx-tail-delay-reverb",
        note: "fx-dressing: delay into reverb tail chain (two blocks)",
        feasible: hot && exitWitnessed && hostTailBeats >= 16,
        reason:
          "delay->reverb chain needs a hot witnessed exit with >= 16 beats of tail",
        blocks: [
          {
            type: "fx",
            side: "tail",
            kind: "delay",
            atBeat: Math.max(0, hostOverlap - 2),
            beats: 4,
            params: { wet: 0.4, beats: 0.75, feedback: 0.45 },
          },
          {
            type: "fx",
            side: "tail",
            kind: "reverb",
            atBeat: hostOverlap,
            beats: 6,
            params: { wet: 0.5, decay: 2.8 },
          },
        ],
      },
      {
        variant: "fx-spiral",
        note: "fx-dressing: spiral on a hot witnessed exit",
        feasible: hot && exitWitnessed && outroA !== null,
        reason: "spiral needs a hot witnessed exit over an outro",
        blocks: [
          {
            type: "fx",
            side: "A",
            kind: "spiral",
            atBeat: Math.max(0, hostOverlap - 4),
            beats: 6,
            params: {
              wet: 0.5,
              beats: 1,
              feedbackMax: 0.6,
              freqStart: 500,
              freqEnd: 6000,
            },
          },
        ],
      },
      {
        variant: "fx-wash-flanger",
        note: "fx-dressing: flanger wash on a hot entry",
        feasible: landingLevel >= 0.7,
        reason: "flanger wash needs a hot incoming landing (body level >= 0.7)",
        blocks: [
          {
            type: "fx",
            side: "B",
            kind: "flanger",
            atBeat: 0,
            beats: 4,
            params: { wet: 0.45, rate: 0.25, depth: 0.6 },
          },
        ],
      },
      {
        variant: "fx-wash-phaser",
        note: "fx-dressing: phaser wash on a quiet entry",
        // Wave 7 recalibration: the old 0.35 line sat below EVERY
        // witnessed entry in the library (witnessed host entries
        // measure 0.461–0.758 relative; all 11 sub-0.35 entries are
        // unwitnessed, because a quiet window's vocal confidence is
        // low by construction — the two clauses could never hold
        // together). 0.55 is the measured median host-entry level:
        // the quieter half of entries, witness clause unchanged.
        feasible: entryWindowRelative <= 0.55 && entryVocals.witnessed,
        reason: "phaser wash needs a quiet, witnessed entry window",
        blocks: [
          {
            type: "fx",
            side: "B",
            kind: "phaser",
            atBeat: 0,
            beats: 4,
            params: { wet: 0.4, rate: 0.4, depth: 0.6 },
          },
        ],
      },
      {
        variant: "fx-chop-slip-roll",
        note: "fx-dressing: slip-roll chop on transient-rich final beats",
        // Wave 7 recalibration: over the library's blend hosts, the
        // final-4-beats transient score measures median 0.203 and
        // MAXIMUM 0.385 — the old 0.5 line sat above every host the
        // library produces (its single Wave 5 candidate rode a
        // fallback echo host). 0.35 is ≈ the top decile of measured
        // host final windows: the chop stays a transient-material
        // effect, on evidence that exists.
        feasible: finalWindowTransient >= 0.35,
        reason: "slip-roll chop needs transient-rich final beats (>= 0.35)",
        blocks: [
          {
            type: "fx",
            side: "A",
            kind: "slip-roll",
            atBeat: Math.max(0, hostOverlap - 4),
            beats: 4,
            params: { wet: 1, sliceBeats: 0.5 },
          },
        ],
      },
      {
        variant: "fx-chop-gating",
        note: "fx-dressing: gating chop on flat final material",
        feasible: finalWindowTransient <= 0.15,
        reason: "gating chop is for flat material (transient <= 0.15)",
        blocks: [
          {
            type: "fx",
            side: "A",
            kind: "gating",
            atBeat: Math.max(0, hostOverlap - 4),
            beats: 4,
            params: { wet: 0.9, division: 0.5, depth: 0.8, low: 0.04 },
          },
        ],
      },
      {
        variant: "fx-grit-saturation",
        note: "fx-dressing: saturation grit on a drop landing with witnessed-quiet vocals",
        feasible: gritDrop !== undefined,
        reason:
          "saturation grit needs a drop landing at the join's end with witnessed-quiet vocals",
        blocks: [
          {
            type: "fx",
            side: "B",
            kind: "saturation",
            atBeat: Math.max(0, hostOverlap - 2),
            beats: 4,
            params: { drive: 0.6, wet: 0.5 },
          },
        ],
      },
    ];
    for (const dressing of dressings) {
      if (!dressing.feasible) {
        rejected.push({ family: host.family, reason: dressing.reason });
        continue;
      }
      candidates.push(
        finalise({
          ...host,
          variant: dressing.variant,
          blocks: [...host.blocks, ...dressing.blocks],
          notes: [...host.notes, dressing.note],
        }),
      );
    }
  }

  return { candidates, rejected };
}
