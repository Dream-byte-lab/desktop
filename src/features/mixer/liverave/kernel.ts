// kernel.ts — the liveRave compute kernel seam (design §9.2).
//
// Pure math the authors call: tempo/key fits, phrase alignment,
// vocal-safety integrals, energy-arc fit, transient measurement and
// blend geometry. Derived from first principles (log-tempo distance,
// the Camelot scores facts.ts already assigns, overlap integrals
// over the graded vocal windows, peak/mean transient ratios) — no
// other engine code is consulted or imported.
//
// The TypeScript implementations in this module ARE the shipped
// kernel semantics: they stand on their own tests and are the
// permanent fallback + parity oracle. Since the §9.5 adoption
// (Wave 2.5), four of the pure-arithmetic functions — tempoFit, the
// keyFitScore numeric core, vocalSafety and blendGeometry — are
// ALSO compiled from C++ (cpp-spike/kernel_shipped.cpp, a port of
// the formulas below) into the committed kernel.wasm asset, loaded
// by kernelWasm.ts. The exported wrappers delegate to the wasm
// kernel while it is live and compute in TypeScript otherwise;
// results are identical either way (parity-gated at ≤1e-6 relative,
// measured ~1e-14), and call sites do not change. Everything else
// in this file stays TypeScript by decision: the remaining exports
// are thin adapters over facts-level objects (they walk phrase
// lists, section lists and contour bins, or call back into
// TrackFacts accessors), so marshalling them to wasm would cost
// more than the arithmetic saves and they are not hot.
//
// The TypeScript math here stays environment-pure: no DOM, no
// storage, no worker globals. (The wasm loader it registers with
// is the separate kernelWasm.ts module.)

import type { KeyFit, TrackFacts, VocalWindowResult } from "./facts";
import {
  ensureKernelWasm,
  getWasmKernel,
  registerKernelTsReference,
} from "./kernelWasm";

// ---------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isUsableBpm(bpm: number | null | undefined): bpm is number {
  return typeof bpm === "number" && Number.isFinite(bpm) && bpm > 0;
}

// ---------------------------------------------------------------------
// Tempo fit — log-distance with half/double-time equivalence
// ---------------------------------------------------------------------

/**
 * Tempo fit in [0, 1]. Two tempos fit by their log2 ratio: a 2:1 or
 * 1:2 relation (double/half time) is a perfect fit, because the
 * grids still lock bar-for-bar. Distance is the smallest
 * |log2(bpmA/bpmB) + k| over k ∈ {-1, 0, 1}; the score is a Gaussian
 * falloff with σ = 0.09 in log2 space (≈ 6.4 % tempo difference),
 * so a 1–2 % pair scores ≈ 0.97, a 6 % pair ≈ 0.65, and a 12 %+ pair
 * fades toward 0. Unknown tempo on either side is neutral 0.5 —
 * unknown is not a mismatch.
 */
function tempoFitTs(
  bpmA: number | null | undefined,
  bpmB: number | null | undefined,
): number {
  if (!isUsableBpm(bpmA) || !isUsableBpm(bpmB)) return 0.5;
  const logRatio = Math.log2(bpmA / bpmB);
  let distance = Math.abs(logRatio);
  for (const k of [-1, 1]) {
    distance = Math.min(distance, Math.abs(logRatio + k));
  }
  const sigma = 0.09;
  return clamp01(Math.exp(-0.5 * (distance / sigma) * (distance / sigma)));
}

export function tempoFit(
  bpmA: number | null | undefined,
  bpmB: number | null | undefined,
): number {
  const wasm = getWasmKernel();
  if (wasm) return wasm.tempoFit(bpmA, bpmB);
  return tempoFitTs(bpmA, bpmB);
}

/**
 * The sustained rate that beatmatches B onto A: rateB = bpmA / bpmB,
 * considering only the literal ratio (half/double-time matching is a
 * fit judgement in tempoFit, not a rate this engine sustains).
 * Returns null when either tempo is unknown.
 */
export function beatmatchRate(
  bpmA: number | null | undefined,
  bpmB: number | null | undefined,
): number | null {
  if (!isUsableBpm(bpmA) || !isUsableBpm(bpmB)) return null;
  return bpmA / bpmB;
}

/** Milliseconds per beat for a track (grid-derived when bpm is absent). */
export function trackMsPerBeat(facts: TrackFacts): number | null {
  if (isUsableBpm(facts.tempo.bpm)) return 60_000 / facts.tempo.bpm;
  const beats = facts.grid.beatMs;
  if (beats.length >= 2) {
    const span = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
    return span > 0 ? span : null;
  }
  return null;
}

// ---------------------------------------------------------------------
// Key fit
// ---------------------------------------------------------------------

/**
 * Numeric key fit from a facts-level KeyFit. A known fit scores
 * itself; an unknown key (null) is neutral 0.65 — better than a
 * known clash (0.1–0.5), worse than a known match (0.85–1): the
 * engine neither punishes nor rewards what it cannot hear.
 */
/** The pure-arithmetic core of keyFitScore (the wasm-ported part). */
function keyFitScoreCoreTs(hasFit: boolean, score: number): number {
  if (!hasFit) return 0.65;
  return clamp01(score);
}

function keyFitScoreTs(fit: KeyFit | null): number {
  return keyFitScoreCoreTs(fit !== null, fit?.score ?? 0);
}

export function keyFitScore(fit: KeyFit | null): number {
  const wasm = getWasmKernel();
  if (wasm) return wasm.keyFitScoreCore(fit !== null, fit?.score ?? 0);
  return keyFitScoreTs(fit);
}

// ---------------------------------------------------------------------
// Phrase alignment (phrases are 4-bar groups; see facts.ts)
// ---------------------------------------------------------------------

export function phraseLengthBeats(facts: TrackFacts): number {
  return Math.max(1, facts.grid.beatsPerBar) * 4;
}

/** Fractional beat index at a track time; null when unmeasurable. */
function beatAt(facts: TrackFacts, atMs: number): number | null {
  const beat = facts.beatAtMs(atMs);
  if (beat !== null) return beat;
  const msPerBeat = trackMsPerBeat(facts);
  if (msPerBeat === null || facts.grid.beatMs.length === 0) return null;
  return atMs / msPerBeat;
}

/**
 * Beats from atMs until the next phrase boundary. Prefers the
 * derived phrase list (which also splits at downbeat-aligned
 * section starts); falls back to modulo arithmetic on the beat
 * index. Returns 0 exactly on a boundary, null when the track has
 * no usable grid.
 */
export function beatsUntilNextPhraseBoundary(
  facts: TrackFacts,
  atMs: number,
): number | null {
  const beat = beatAt(facts, atMs);
  if (beat === null) return null;
  for (const phrase of facts.phrases) {
    if (atMs >= phrase.startMs && atMs < phrase.endMs) {
      // Standing on the boundary itself: the next boundary is here.
      if (Math.abs(beat - phrase.startBeat) < 1e-6) return 0;
      return Math.max(0, phrase.endBeat - beat);
    }
  }
  const length = phraseLengthBeats(facts);
  const into = ((beat % length) + length) % length;
  return into === 0 ? 0 : length - into;
}

/** Beats from the current phrase's start to atMs (0 on a boundary). */
export function beatsSincePhraseStart(
  facts: TrackFacts,
  atMs: number,
): number | null {
  const beat = beatAt(facts, atMs);
  if (beat === null) return null;
  for (const phrase of facts.phrases) {
    if (atMs >= phrase.startMs && atMs < phrase.endMs) {
      return Math.max(0, beat - phrase.startBeat);
    }
  }
  const length = phraseLengthBeats(facts);
  return ((beat % length) + length) % length;
}

/** Track time of the next phrase boundary at/after atMs. */
export function nextPhraseBoundaryMs(
  facts: TrackFacts,
  atMs: number,
): number | null {
  const until = beatsUntilNextPhraseBoundary(facts, atMs);
  if (until === null) return null;
  const beat = beatAt(facts, atMs);
  if (beat === null) return null;
  const at = facts.timeAtBeatMs(beat + until);
  if (at !== null) return at;
  const msPerBeat = trackMsPerBeat(facts);
  return msPerBeat === null ? null : atMs + until * msPerBeat;
}

/**
 * Phrase-alignment score in [0, 1] for a track time: 1 exactly on a
 * phrase boundary, decaying linearly to 0 at a quarter-phrase (one
 * bar) away from the nearest boundary. Gridless tracks score the
 * neutral 0.5.
 */
export function phraseAlignmentScore(facts: TrackFacts, atMs: number): number {
  const until = beatsUntilNextPhraseBoundary(facts, atMs);
  if (until === null) return 0.5;
  const since = beatsSincePhraseStart(facts, atMs) ?? until;
  const distance = Math.min(until, since);
  const bar = Math.max(1, facts.grid.beatsPerBar);
  return clamp01(1 - distance / bar);
}

// ---------------------------------------------------------------------
// Vocal safety — collision risk over a pair of windows
// ---------------------------------------------------------------------

/**
 * Vocal safety in [0, 1] for two simultaneous windows (one per
 * track), from their vocalActivityIn results. When both windows are
 * witnessed, safety = 1 − meanA × meanB: the collision risk is the
 * product of the two activities (both singing at once is the harm;
 * one loud voice over a quiet bed is safe). When a window is
 * unwitnessed its evidence is shrunk toward the uninformative
 * middle (activity 0.5) in proportion to how much of the pair is
 * unwitnessed, so unknown windows land mid-scale — never spent as
 * proof of silence, never treated as a certain clash.
 */
function vocalSafetyTs(
  windowA: VocalWindowResult,
  windowB: VocalWindowResult,
): number {
  const witnessedCount =
    (windowA.witnessed ? 1 : 0) + (windowB.witnessed ? 1 : 0);
  if (witnessedCount === 2) {
    return clamp01(1 - windowA.mean * windowB.mean);
  }
  if (witnessedCount === 0) return 0.5;
  const witnessed = windowA.witnessed ? windowA : windowB;
  const other = windowA.witnessed ? windowB : windowA;
  const shrunkOther = 0.5 * other.mean + 0.5 * 0.5;
  const base = 1 - witnessed.mean * shrunkOther;
  return clamp01(0.5 * base + 0.5 * 0.5);
}

export function vocalSafety(
  windowA: VocalWindowResult,
  windowB: VocalWindowResult,
): number {
  const wasm = getWasmKernel();
  if (wasm) {
    return wasm.vocalSafety(
      windowA.mean,
      windowA.witnessed,
      windowB.mean,
      windowB.witnessed,
    );
  }
  return vocalSafetyTs(windowA, windowB);
}

/** Convenience: vocal safety between two track spans directly. */
export function vocalSafetyIn(
  factsA: TrackFacts,
  aStartMs: number,
  aEndMs: number,
  factsB: TrackFacts,
  bStartMs: number,
  bEndMs: number,
): number {
  return vocalSafety(
    factsA.vocals.vocalActivityIn(aStartMs, aEndMs),
    factsB.vocals.vocalActivityIn(bStartMs, bEndMs),
  );
}

// ---------------------------------------------------------------------
// Energy — arc fit, relative levels, transient measurement
// ---------------------------------------------------------------------

/**
 * The set-arc target energy at a position in [0, 1]: a gentle climb
 * from 0.30 (opening) toward 1.0 (peak/late), target(p) =
 * 0.30 + 0.70 × p^0.8. Steepness (the shaping bend) rescales how far
 * along that climb a given position sits: steepness > 1 reaches
 * late-arc targets earlier in the set.
 */
export function arcTargetEnergy(arcPosition: number, steepness = 1): number {
  const position = clamp01(arcPosition);
  const effective = clamp01(position * (steepness > 0 ? steepness : 1));
  return clamp01(0.3 + 0.7 * Math.pow(effective, 0.8));
}

/**
 * How well a candidate's (normalised 0..1) energy fits the set arc
 * at a position: 1 when it lands on the arc target, falling linearly
 * to 0 at a distance of 2/3 of the scale.
 */
export function energyArcFit(
  candidateEnergy: number,
  arcPosition: number,
  steepness = 1,
): number {
  const target = arcTargetEnergy(arcPosition, steepness);
  return clamp01(1 - 1.5 * Math.abs(clamp01(candidateEnergy) - target));
}

/** Peak contour energy of a track (0 when unmeasured). */
export function trackPeakEnergy(facts: TrackFacts): number {
  let peak = 0;
  for (const bin of facts.energyContour.bins) peak = Math.max(peak, bin.rms);
  return peak;
}

/**
 * A track's musical energy level in [0, 1]: the mean energy of its
 * strongest body section relative to its contour peak. Falls back
 * to the loudness/peak ratio when no sections were measured.
 */
export function trackEnergyLevel(facts: TrackFacts): number {
  const peak = trackPeakEnergy(facts);
  if (peak <= 0) return 0.5;
  let body = 0;
  for (const section of facts.sections) {
    if (section.kind !== "intro" && section.kind !== "outro") {
      body = Math.max(body, section.energy);
    }
  }
  if (body > 0) return clamp01(body / peak);
  if (facts.loudnessRms !== null && facts.loudnessRms > 0) {
    return clamp01(facts.loudnessRms / peak);
  }
  return 0.5;
}

/**
 * Mean energy of a window relative to the track's peak, in [0, 1].
 * 0 when the window or the contour is unmeasured.
 */
export function relativeWindowEnergy(
  facts: TrackFacts,
  aMs: number,
  bMs: number,
): number {
  const peak = trackPeakEnergy(facts);
  if (peak <= 0) return 0;
  return clamp01(facts.energyContour.windowMeanEnergy(aMs, bMs) / peak);
}

/**
 * Transient score of a window in [0, 1], from the energy contour's
 * peak/mean ratio: a flat window (peak = mean) scores 0; a window
 * whose peak is 2.5× its mean or more scores 1. Silence scores 0 —
 * a spike needs real energy behind it, not just a ratio.
 */
export function windowTransientScore(
  facts: TrackFacts,
  aMs: number,
  bMs: number,
): number {
  const lo = Math.min(aMs, bMs);
  const hi = Math.max(aMs, bMs);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return 0;
  const mean = facts.energyContour.windowMeanEnergy(lo, hi);
  let peak = 0;
  for (const bin of facts.energyContour.bins) {
    if (bin.atMs >= lo && bin.atMs < hi) peak = Math.max(peak, bin.rms);
  }
  if (peak === 0) {
    // No contour bins: sample the accessor on a coarse grid.
    const steps = 16;
    for (let i = 0; i <= steps; i += 1) {
      peak = Math.max(
        peak,
        facts.energyContour.energyAt(lo + ((hi - lo) * i) / steps),
      );
    }
  }
  if (peak < 0.01 || mean <= 0) return 0;
  const ratio = peak / mean;
  return clamp01((ratio - 1) / 1.5);
}

// ---------------------------------------------------------------------
// Blend geometry
// ---------------------------------------------------------------------

export interface BlendGeometryConstraints {
  /** Desired overlap centre, in beats. */
  centreBeats: number;
  /** Hard minimum overlap, in beats (default 4). */
  minBeats?: number;
  /** Hard maximum overlap, in beats (default 32). */
  maxBeats?: number;
  /** Beats per bar for bar rounding (default 4). */
  beatsPerBar?: number;
  /** Extra cap (e.g. the distant-key 8-beat cap), in beats. */
  capBeats?: number;
}

export interface BlendGeometry {
  overlapBeats: number;
  /** Bar nearest the middle of the overlap — the bass-swap point. */
  swapBeat: number;
}

/**
 * Chooses an overlap length from a centre plus constraints: the
 * centre is clamped to [min, max] and to any cap, then rounded to a
 * whole number of bars (at least one bar, never past the cap). The
 * swap beat is the bar nearest the overlap's midpoint, kept strictly
 * inside the overlap (for a one-bar overlap it is the half-bar).
 */
function blendGeometryTs(constraints: BlendGeometryConstraints): BlendGeometry {
  const beatsPerBar = Math.max(
    1,
    Math.round(constraints.beatsPerBar ?? 4) || 4,
  );
  const minBeats = Math.max(beatsPerBar, constraints.minBeats ?? 4);
  let maxBeats = Math.max(minBeats, constraints.maxBeats ?? 32);
  if (constraints.capBeats !== undefined) {
    maxBeats = Math.min(maxBeats, Math.max(minBeats, constraints.capBeats));
  }
  const centre = clamp(
    Number.isFinite(constraints.centreBeats) ? constraints.centreBeats : 16,
    minBeats,
    maxBeats,
  );
  let bars = Math.max(1, Math.round(centre / beatsPerBar));
  let overlapBeats = bars * beatsPerBar;
  if (overlapBeats > maxBeats) {
    bars = Math.max(1, Math.floor(maxBeats / beatsPerBar));
    overlapBeats = bars * beatsPerBar;
  }
  let swapBeat: number;
  if (bars <= 1) {
    swapBeat = overlapBeats / 2;
  } else {
    // Bar nearest the midpoint; an exact tie takes the earlier bar,
    // so the swap has completed by the middle of the overlap.
    const rawBar = overlapBeats / 2 / beatsPerBar;
    let middleBar = Math.floor(rawBar);
    if (rawBar - middleBar > 0.5) middleBar += 1;
    swapBeat = clamp(
      middleBar * beatsPerBar,
      beatsPerBar,
      overlapBeats - beatsPerBar,
    );
  }
  return { overlapBeats, swapBeat };
}

export function blendGeometry(
  constraints: BlendGeometryConstraints,
): BlendGeometry {
  const wasm = getWasmKernel();
  if (wasm) return wasm.blendGeometry(constraints);
  return blendGeometryTs(constraints);
}

// ---------------------------------------------------------------------
// C++ wasm adoption (§9.5): register the TypeScript implementations
// above as the loader's self-check reference, then start the lazy
// async load. Until it lands — and forever if it fails — the
// exported wrappers compute in TypeScript. Auto-init is skipped
// under vitest (MODE === "test"): the parity tests inject the
// committed wasm bytes explicitly instead of fetching asset URLs,
// which vitest rewrites (the spike's G2 lesson).
// ---------------------------------------------------------------------

registerKernelTsReference({
  tempoFit: tempoFitTs,
  keyFitScoreCore: keyFitScoreCoreTs,
  vocalSafety: (meanA, witnessedA, meanB, witnessedB) =>
    vocalSafetyTs(
      { mean: meanA, confidence: 0, witnessed: witnessedA },
      { mean: meanB, confidence: 0, witnessed: witnessedB },
    ),
  blendGeometry: blendGeometryTs,
});

if (import.meta.env.MODE !== "test") {
  void ensureKernelWasm();
}
