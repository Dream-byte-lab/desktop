import { beatsAtTime, timeAtBeat, type BeatMap } from "./beatMap";
import { detectKey, type KeyEstimate } from "./detectKey";
import {
  detectVocalActivity,
  meanVocalActivity,
  vocalRangesFromActivity,
  type VocalActivityCurve,
  type VocalRange,
} from "./detectVocals";
import { buildBeatGrid } from "./gridTrack";

// The analyser: listens to a track's raw audio and writes down what the
// mixer needs to know. Version one fed the decider five coarse facts —
// one whole-track tempo, one rigid grid, phrase-boundary drop guesses,
// a first-45-seconds key, binary vocal ranges, a self-normalised
// 1-sample-per-second energy curve — and the Note 4 investigation
// proved that ceiling is what made the mixing formulaic: two different
// real pairs whose five facts looked alike were, to that code, the
// same pair.
//
// Version 2 (Step 5, slice S5-1) reads STRUCTURE instead:
//
// - tempo is still summarised by one number (for display and scoring),
//   but the beat grid now BENDS: gridTrack anchors beats to real
//   onsets and tracks drift, and every span of the grid carries its
//   own local tempo and confidence;
// - sections are musical events found from a sub-second energy
//   contour and novelty boundaries — intro, verse, chorus, breakdown,
//   bridge, drop, outro — each with absolute loudness and graded
//   vocal activity; intro and outro bounds are explicit fields;
// - drops are events anywhere in the track (a strong, sustained
//   energy onset with a graded strength), not a jump test that only
//   looks at 16-beat boundaries and only fires after quiet;
// - vocals are a graded activity curve with a confidence per window
//   (detectVocals v2), from which the v1 ranges are derived;
// - the key is read over several windows (opening/body/closing) and
//   the windows' agreement is folded into the reported confidence;
// - every analysis carries a version and a fingerprint of the audio
//   it was computed from, so the analysis cache can trust a stored
//   analysis only when both match the audio actually decoded.
//
// The v1 fields keep their exact meanings and stay populated — the
// current session and planner run on v2 data unchanged until their
// own slices replace them. The v2 fields are optional in the type
// only so v1-shaped fixtures keep compiling; the analyser and the
// cache always populate them.
//
// It works on plain samples rather than an AudioBuffer so it can be
// tested on synthetic songs whose true structure is known exactly.
// All passes run wherever the caller runs them — in the app that is
// the Step 2 worker, never the UI thread.

export const ANALYSIS_VERSION = 2;

export interface DropCandidate {
  /** Track time where the drop lands (snapped to the beat grid). */
  timeSec: number;
  /** Beat index of the drop, counted from the first downbeat. */
  beat: number;
  /** How hard the energy jumps: after-level divided by before-level. */
  strength: number;
}

export type SectionKind =
  "intro" | "verse" | "chorus" | "breakdown" | "bridge" | "outro" | "drop";

export interface TrackSection {
  kind: SectionKind;
  startSec: number;
  endSec: number;
  startBeat: number;
  endBeat: number;
  /** Mean absolute RMS across the span — comparable between tracks. */
  meanRms: number;
  /** Mean graded vocal activity (0..1) across the span. */
  vocalActivity: number;
  /** 0..1 — how decisive the boundary evidence around this span was. */
  confidence: number;
}

export interface SectionBounds {
  startSec: number;
  endSec: number;
  startBeat: number;
  endBeat: number;
}

export interface KeyWindows {
  opening: KeyEstimate | null;
  body: KeyEstimate | null;
  closing: KeyEstimate | null;
}

export type AnalysisDepth = "fast" | "deep";

export interface TrackAnalysis {
  beatMap: BeatMap;
  /** 0..1 — how strongly the winning tempo stood out. */
  tempoConfidence: number;
  /** Loudness over time, one entry per second, normalised to 0..1. */
  energyCurve: { timeSec: number; energy: number }[];
  /** Likely drop points, strongest first. */
  drops: DropCandidate[];
  /** Estimated musical key (Camelot-labelled), for harmonic mixing. */
  key: KeyEstimate | null;
  /** Where someone is singing — the planner must not overlap two of these. */
  vocalRanges: VocalRange[];
  /**
   * The track's overall loudness: RMS across the whole track, absolute
   * (not normalised). This is what lets the session level-match tracks
   * against each other, so a quiet master doesn't sound like the party
   * suddenly lost its energy.
   */
  loudness: number;

  // ---- analysis v2 (always populated by the analyser and the cache) ----

  /** Analysis format version — ANALYSIS_VERSION for anything v2 wrote. */
  analysisVersion?: number;
  /** Coarse fingerprint of the decoded audio this analysis describes. */
  audioHash?: string;
  /** The depth this analysis was computed at (see AnalyseOptions.depth). */
  depth?: AnalysisDepth;
  /** Labelled musical sections, in track order. */
  sections?: TrackSection[];
  /** Explicit intro bounds, when the track has one. */
  intro?: SectionBounds | null;
  /** Explicit outro bounds, when the track has one. */
  outro?: SectionBounds | null;
  /** Sub-second energy contour: absolute RMS per 0.25 s bin. */
  energyContour?: { timeSec: number; rms: number }[];
  /** Graded vocal activity with per-window confidence. */
  vocalActivity?: VocalActivityCurve;
  /** The per-window key reads, before agreement was folded in. */
  keyWindows?: KeyWindows;
}

export interface AnalyseOptions {
  /** Tempo search range. Defaults to 70–180 bpm. */
  minBpm?: number;
  maxBpm?: number;
  beatsPerBar?: number;
  /**
   * Progressive depth. "deep" (the default) is the full read:
   * multi-window key, vocal activity at full resolution. "fast" is
   * the pass that must be sufficient for the imminent pair: same
   * tempo/grid/contour/sections/drops, key from the opening window
   * only, vocal activity measured on alternate windows. A fast
   * analysis says so in its `depth` field, and its confidences are
   * the fast pass's own — a consumer must not spend them as deep.
   */
  depth?: AnalysisDepth;
}

const FRAME_SIZE = 1024;
const HOP_SIZE = 512;
const CONTOUR_BIN_SEC = 0.25;

/** Per-frame loudness (RMS), one entry per hop. */
function frameEnergies(samples: Float32Array): Float32Array {
  const frameCount = Math.max(
    0,
    Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE) + 1,
  );
  const energy = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    const start = f * HOP_SIZE;
    let sum = 0;
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      const v = samples[start + i];
      sum += v * v;
    }
    energy[f] = Math.sqrt(sum / FRAME_SIZE);
  }
  return energy;
}

/** The onset envelope: how much each frame is louder than the one before. */
function onsetEnvelope(energy: Float32Array): Float32Array {
  const onsets = new Float32Array(energy.length);
  for (let f = 1; f < energy.length; f += 1) {
    onsets[f] = Math.max(0, energy[f] - energy[f - 1]);
  }
  return onsets;
}

interface TempoResult {
  bpm: number;
  periodFrames: number;
  confidence: number;
}

function estimateTempo(
  onsets: Float32Array,
  framesPerSecond: number,
  minBpm: number,
  maxBpm: number,
): TempoResult | null {
  const minLag = Math.max(2, Math.floor((60 / maxBpm) * framesPerSecond));
  const maxLag = Math.min(
    onsets.length - 1,
    Math.ceil((60 / minBpm) * framesPerSecond),
  );
  if (maxLag <= minLag) return null;

  let zeroLag = 0;
  for (let i = 0; i < onsets.length; i += 1) zeroLag += onsets[i] * onsets[i];
  if (zeroLag === 0) return null;

  const scores = new Float64Array(maxLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < onsets.length; i += 1) {
      sum += onsets[i] * onsets[i + lag];
    }
    scores[lag] = sum / (onsets.length - lag);
    if (scores[lag] > best) best = scores[lag];
  }
  if (best === 0) return null;

  // Prefer the shortest period that is nearly as strong as the best —
  // a click pattern correlates with its own double period almost as
  // well, and the faster reading is the beat a dancer feels.
  let chosenLag = maxLag;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    if (scores[lag] >= 0.9 * best) {
      chosenLag = lag;
      break;
    }
  }

  const bpm = 60 / (chosenLag / framesPerSecond);
  return {
    bpm,
    periodFrames: chosenLag,
    confidence: Math.min(1, (scores[chosenLag] * onsets.length) / zeroLag),
  };
}

/** Slides a beat grid with the given period across the onsets and returns the offset with the strongest total onset support. */
function estimatePhase(onsets: Float32Array, periodFrames: number): number {
  let bestOffset = 0;
  let bestScore = -1;
  for (let offset = 0; offset < periodFrames; offset += 1) {
    let score = 0;
    for (let f = offset; f < onsets.length; f += periodFrames) {
      score += onsets[Math.round(f)];
    }
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

/**
 * A coarse fingerprint of the decoded audio: length, rate, and the
 * shape of its loudness across 64 chunks, hashed FNV-1a. Two decodes
 * of the same audio produce the same fingerprint; a different edit,
 * remaster or rip of the track produces a different one — which is
 * all the analysis cache asks of it. Chunk levels are quantised
 * coarsely so decoder rounding cannot split identical audio.
 */
export function audioFingerprint(
  samples: Float32Array,
  sampleRate: number,
): string {
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    hash ^= value & 0xffffffff;
    hash = Math.imul(hash, 0x01000193);
  };
  mix(samples.length);
  mix(sampleRate);
  const chunks = 64;
  const chunkLen = Math.max(1, Math.floor(samples.length / chunks));
  for (let c = 0; c < chunks; c += 1) {
    const start = c * chunkLen;
    const end = Math.min(samples.length, start + chunkLen);
    let sum = 0;
    let count = 0;
    // Strided sampling: the fingerprint needs the chunk's shape, not
    // another full pass over every sample.
    for (let i = start; i < end; i += 16) {
      sum += samples[i] * samples[i];
      count += 1;
    }
    const rms = count > 0 ? Math.sqrt(sum / count) : 0;
    mix(Math.round(rms * 4096));
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Mean of a contour slice, guarded against empty ranges. */
function meanOf(values: ArrayLike<number>, from: number, to: number): number {
  const lo = Math.max(0, from);
  const hi = Math.min(values.length, to);
  if (hi <= lo) return 0;
  let sum = 0;
  for (let i = lo; i < hi; i += 1) sum += values[i];
  return sum / (hi - lo);
}

/**
 * Drop events: a strong, sustained energy onset, anywhere in the
 * track. "Strong" is a level ratio (after ÷ before over 1 s windows),
 * "sustained" is the after-level holding a real share of the track's
 * peak, and the strength reported is the graded ratio itself — a
 * loud-after-loud surge is a drop with a modest strength, not an
 * absence. Events are spaced at least 2 s apart (the strongest wins).
 */
function findDropEvents(
  contour: Float32Array,
  beatMap: BeatMap,
): DropCandidate[] {
  const binsPerSecond = Math.round(1 / CONTOUR_BIN_SEC);
  let peak = 0;
  for (let i = 0; i < contour.length; i += 1) {
    if (contour[i] > peak) peak = contour[i];
  }
  if (peak <= 0) return [];

  interface RawEvent {
    bin: number;
    strength: number;
  }
  const raw: RawEvent[] = [];
  for (let i = binsPerSecond; i + binsPerSecond <= contour.length; i += 1) {
    const before = meanOf(contour, i - binsPerSecond, i);
    const after = meanOf(contour, i, i + binsPerSecond);
    if (before < 0.02 * peak) continue;
    if (after < 0.3 * peak) continue;
    const strength = after / before;
    if (strength < 1.5) continue;
    raw.push({ bin: i, strength });
  }
  // Local maxima over ±0.5 s, then the 2 s separation, strongest first.
  const localMaxima = raw.filter((event) => {
    for (const other of raw) {
      if (
        other !== event &&
        Math.abs(other.bin - event.bin) <= binsPerSecond / 2 &&
        other.strength > event.strength
      ) {
        return false;
      }
    }
    return true;
  });
  localMaxima.sort((a, z) => z.strength - a.strength);
  const kept: RawEvent[] = [];
  for (const event of localMaxima) {
    if (kept.every((k) => Math.abs(k.bin - event.bin) >= 2 * binsPerSecond)) {
      kept.push(event);
    }
  }
  return kept.map((event) => {
    const beat = Math.round(beatsAtTime(beatMap, event.bin * CONTOUR_BIN_SEC));
    return {
      timeSec: timeAtBeat(beatMap, beat),
      beat,
      strength: event.strength,
    };
  });
}

interface RawSpan {
  startBin: number;
  endBin: number;
  meanRms: number;
}

/**
 * Sections from the contour: persistent level changes (found on a
 * 1 s-smoothed level, refined to the sharpest nearby step) plus drop
 * events give the boundaries; position, level and drop evidence label
 * the spans; boundaries snap to the beat grid so the bounds a decider
 * reads are musical, not arithmetic. The labelling rules are plain
 * and stated in the code — a span the evidence can't characterise is
 * a verse, which is what a mid-level interior span in a song most
 * often is, and its confidence says how little that claim rests on.
 */
function findSections(
  contour: Float32Array,
  durationSec: number,
  beatMap: BeatMap,
  dropEvents: DropCandidate[],
  vocalActivity: VocalActivityCurve,
): {
  sections: TrackSection[];
  intro: SectionBounds | null;
  outro: SectionBounds | null;
} {
  const n = contour.length;
  if (n === 0) return { sections: [], intro: null, outro: null };
  let peak = 0;
  for (let i = 0; i < n; i += 1) if (contour[i] > peak) peak = contour[i];
  if (peak <= 0) return { sections: [], intro: null, outro: null };

  // Smoothed level (1 s centred moving average) for boundary hunting.
  const level = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    level[i] = meanOf(contour, i - 2, i + 2);
  }

  const binsPerSecond = Math.round(1 / CONTOUR_BIN_SEC);
  const windowBins = 2 * binsPerSecond; // 2 s before/after
  interface Boundary {
    bin: number;
    contrast: number;
  }
  const candidates: Boundary[] = [];
  for (let i = windowBins; i + windowBins <= n; i += 1) {
    const before = meanOf(level, i - windowBins, i);
    const after = meanOf(level, i, i + windowBins);
    const step = Math.abs(after - before);
    if (step < 0.1 * peak) continue;
    const ratio = after / Math.max(before, 1e-6);
    if (ratio < 1.35 && ratio > 1 / 1.35) continue;
    candidates.push({ bin: i, contrast: step / peak });
  }
  // Keep only local maxima (over ±1 s) of the step size.
  const steps = candidates.filter((c) => {
    for (const other of candidates) {
      if (
        other !== c &&
        Math.abs(other.bin - c.bin) <= binsPerSecond &&
        other.contrast > c.contrast
      ) {
        return false;
      }
    }
    return true;
  });
  // Refine each boundary to the sharpest single-bin step nearby —
  // the smoothed windows locate a change, the raw contour dates it.
  const refined: Boundary[] = [];
  for (const step of steps) {
    let bestBin = step.bin;
    let bestJump = 0;
    const from = Math.max(1, step.bin - binsPerSecond);
    const to = Math.min(n - 1, step.bin + binsPerSecond);
    for (let j = from; j <= to; j += 1) {
      const jump = Math.abs(contour[j] - contour[j - 1]);
      if (jump > bestJump) {
        bestJump = jump;
        bestBin = j;
      }
    }
    refined.push({ bin: bestBin, contrast: step.contrast });
  }
  // Drop events are boundaries too (a drop is a section start by
  // definition); add any the level hunt missed.
  for (const event of dropEvents) {
    const bin = Math.round(event.timeSec / CONTOUR_BIN_SEC);
    if (!refined.some((b) => Math.abs(b.bin - bin) <= 2)) {
      refined.push({ bin, contrast: 0.5 });
    }
  }
  refined.sort((a, z) => a.bin - z.bin);
  // Enforce a 2 s minimum span, keeping the stronger boundary.
  const boundaries: Boundary[] = [];
  for (const b of refined) {
    const prev = boundaries[boundaries.length - 1];
    if (prev && b.bin - prev.bin < 2 * binsPerSecond) {
      if (b.contrast > prev.contrast) boundaries[boundaries.length - 1] = b;
      continue;
    }
    boundaries.push(b);
  }

  const edges = [0, ...boundaries.map((b) => b.bin), n];
  const spans: RawSpan[] = [];
  for (let k = 0; k + 1 < edges.length; k += 1) {
    spans.push({
      startBin: edges[k],
      endBin: edges[k + 1],
      meanRms: meanOf(contour, edges[k], edges[k + 1]),
    });
  }
  if (spans.length === 0) return { sections: [], intro: null, outro: null };

  const peakSpan = Math.max(...spans.map((s) => s.meanRms));
  const firstFull = spans.findIndex((s) => s.meanRms >= 0.7 * peakSpan);
  let lastFull = -1;
  for (let k = spans.length - 1; k >= 0; k -= 1) {
    if (spans[k].meanRms >= 0.7 * peakSpan) {
      lastFull = k;
      break;
    }
  }
  const dropBins = new Set(
    dropEvents.map((e) => Math.round(e.timeSec / CONTOUR_BIN_SEC)),
  );

  // The intro is the quiet run BEFORE the body starts — but capped:
  // energy alone cannot tell a long intro from a quiet verse that
  // precedes the first chorus, and a "verse" the length of a fifth
  // of the track is a verse. Leading spans are intro only while
  // their total stays within a fifth of the track; beyond that the
  // interior rules label them (usually verse).
  let introCount = 0;
  if (firstFull > 0) {
    let acc = 0;
    for (let k = 0; k < firstFull; k += 1) {
      const spanSec = (spans[k].endBin - spans[k].startBin) * CONTOUR_BIN_SEC;
      if (acc + spanSec > 0.2 * durationSec) break;
      acc += spanSec;
      introCount = k + 1;
    }
  }

  const kinds: SectionKind[] = spans.map((span, k) => {
    if (k < introCount) return "intro";
    if (lastFull >= 0 && k > lastFull) return "outro";
    const startBin = span.startBin;
    const hasDrop = [...dropBins].some(
      (bin) => bin >= startBin && bin < startBin + 2,
    );
    const prevLevel = k > 0 ? spans[k - 1].meanRms : span.meanRms;
    if (hasDrop && span.meanRms >= 1.35 * prevLevel && k > 0) return "drop";
    const neighbours: number[] = [];
    if (k > 0) neighbours.push(spans[k - 1].meanRms);
    if (k + 1 < spans.length) neighbours.push(spans[k + 1].meanRms);
    const neighbourMean =
      neighbours.length > 0
        ? neighbours.reduce((a, b) => a + b, 0) / neighbours.length
        : span.meanRms;
    const spanSec = (span.endBin - span.startBin) * CONTOUR_BIN_SEC;
    if (span.meanRms <= 0.55 * neighbourMean && spanSec >= 2) {
      return "breakdown";
    }
    if (span.meanRms >= 0.85 * peakSpan) return "chorus";
    const nextKindHigh =
      k + 1 < spans.length && spans[k + 1].meanRms >= 0.85 * peakSpan;
    const sawHighBefore = spans
      .slice(0, k)
      .some((s) => s.meanRms >= 0.85 * peakSpan);
    if (span.meanRms <= 0.65 * peakSpan && nextKindHigh && sawHighBefore) {
      return "bridge";
    }
    return "verse";
  });

  // Convert spans to sections, snapping interior boundaries to beats
  // and merging adjacent spans that earned the same label.
  const contrastAt = (bin: number): number => {
    const b = boundaries.find((x) => x.bin === bin);
    return b ? Math.min(1, 0.3 + b.contrast) : 0.8;
  };
  const sections: TrackSection[] = [];
  for (let k = 0; k < spans.length; k += 1) {
    const span = spans[k];
    const rawStart = span.startBin * CONTOUR_BIN_SEC;
    const rawEnd = Math.min(durationSec, span.endBin * CONTOUR_BIN_SEC);
    const startBeat = k === 0 ? 0 : Math.round(beatsAtTime(beatMap, rawStart));
    const endBeat =
      k === spans.length - 1
        ? Math.round(beatsAtTime(beatMap, durationSec))
        : Math.round(beatsAtTime(beatMap, rawEnd));
    const startSec = k === 0 ? 0 : timeAtBeat(beatMap, startBeat);
    const endSec =
      k === spans.length - 1 ? durationSec : timeAtBeat(beatMap, endBeat);
    const confidence =
      k === 0 || k === spans.length - 1
        ? Math.min(contrastAt(span.startBin), 0.8)
        : Math.min(contrastAt(span.startBin), contrastAt(span.endBin));
    const section: TrackSection = {
      kind: kinds[k],
      startSec,
      endSec,
      startBeat,
      endBeat,
      meanRms: span.meanRms,
      vocalActivity: meanVocalActivity(vocalActivity, rawStart, rawEnd),
      confidence,
    };
    const prev = sections[sections.length - 1];
    if (prev && prev.kind === section.kind) {
      const totalSec =
        prev.endSec - prev.startSec + (section.endSec - section.startSec);
      prev.meanRms =
        totalSec > 0
          ? (prev.meanRms * (prev.endSec - prev.startSec) +
              section.meanRms * (section.endSec - section.startSec)) /
            totalSec
          : section.meanRms;
      prev.vocalActivity =
        totalSec > 0
          ? (prev.vocalActivity * (prev.endSec - prev.startSec) +
              section.vocalActivity * (section.endSec - section.startSec)) /
            totalSec
          : section.vocalActivity;
      prev.endSec = section.endSec;
      prev.endBeat = section.endBeat;
      prev.confidence = Math.min(prev.confidence, section.confidence);
    } else {
      sections.push(section);
    }
  }

  const boundsOf = (s: TrackSection): SectionBounds => ({
    startSec: s.startSec,
    endSec: s.endSec,
    startBeat: s.startBeat,
    endBeat: s.endBeat,
  });
  const intro =
    sections.length > 0 && sections[0].kind === "intro"
      ? boundsOf(sections[0])
      : null;
  const last = sections[sections.length - 1];
  const outro = last && last.kind === "outro" ? boundsOf(last) : null;
  return { sections, intro, outro };
}

/**
 * Folds the per-window key reads into the one reported key: the
 * reading the windows agree on wins, and agreement itself is folded
 * into the confidence — three windows naming the same key is stronger
 * evidence than one window naming it alone, and a lone dissenting
 * read is discounted rather than hidden.
 */
function combineKeyWindows(
  windows: (KeyEstimate | null)[],
): KeyEstimate | null {
  const present = windows.filter((w): w is KeyEstimate => w !== null);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  const groups = new Map<string, KeyEstimate[]>();
  for (const estimate of present) {
    const group = groups.get(estimate.camelot) ?? [];
    group.push(estimate);
    groups.set(estimate.camelot, group);
  }
  let bestGroup: KeyEstimate[] = present.slice(0, 1);
  for (const group of groups.values()) {
    const groupBest = Math.max(...group.map((g) => g.confidence));
    const bestBest = Math.max(...bestGroup.map((g) => g.confidence));
    if (
      group.length > bestGroup.length ||
      (group.length === bestGroup.length && groupBest > bestBest)
    ) {
      bestGroup = group;
    }
  }
  const winner = bestGroup.reduce((a, b) =>
    b.confidence > a.confidence ? b : a,
  );
  const agreement = bestGroup.length / present.length;
  return {
    ...winner,
    confidence: winner.confidence * (0.5 + 0.5 * agreement),
  };
}

export function analyseTrack(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyseOptions = {},
): TrackAnalysis | null {
  const minBpm = options.minBpm ?? 70;
  const maxBpm = options.maxBpm ?? 180;
  const beatsPerBar = options.beatsPerBar ?? 4;
  const depth: AnalysisDepth = options.depth ?? "deep";
  const durationSec = samples.length / sampleRate;
  const framesPerSecond = sampleRate / HOP_SIZE;

  const energies = frameEnergies(samples);
  if (energies.length === 0) return null;
  const onsets = onsetEnvelope(energies);

  const tempo = estimateTempo(onsets, framesPerSecond, minBpm, maxBpm);
  if (!tempo) return null;

  const spb = 60 / tempo.bpm;
  const phaseFrames = estimatePhase(onsets, tempo.periodFrames);
  const gridStartSec = (phaseFrames * HOP_SIZE) / sampleRate;

  // Beat strengths along the rigid grid, then the downbeat rotation:
  // the beat position within the bar whose onsets are strongest on
  // average. (Unchanged from v1 — the rotation is about bars, not
  // about tempo, and the bending grid inherits its numbering.)
  const totalBeats = Math.floor((durationSec - gridStartSec) / spb);
  if (totalBeats < beatsPerBar * 2) return null;
  const beatStrength = new Float64Array(totalBeats);
  for (let b = 0; b < totalBeats; b += 1) {
    const frame = Math.round(
      ((gridStartSec + b * spb) * sampleRate) / HOP_SIZE,
    );
    beatStrength[b] = frame < onsets.length ? onsets[frame] : 0;
  }
  let downbeatShift = 0;
  let bestRotation = -1;
  for (let r = 0; r < beatsPerBar; r += 1) {
    let sum = 0;
    let count = 0;
    for (let b = r; b < totalBeats; b += beatsPerBar) {
      sum += beatStrength[b];
      count += 1;
    }
    const mean = count > 0 ? sum / count : 0;
    if (mean > bestRotation) {
      bestRotation = mean;
      downbeatShift = r;
    }
  }
  const firstBeatSec = gridStartSec + downbeatShift * spb;

  // The bending grid: anchors walked from the rigid grid's origin,
  // following the track's actual onsets (gridTrack.ts).
  const grid = buildBeatGrid({
    onsets,
    framesPerSecond,
    firstBeatSec,
    bpm: tempo.bpm,
    durationSec,
  });

  const beatMap: BeatMap = {
    bpm: tempo.bpm,
    firstBeatSec,
    beatsPerBar,
    durationSec,
    grid,
  };

  // Overall loudness: one absolute RMS pass over the whole track.
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sumSquares += samples[i] * samples[i];
  }
  const loudness = Math.sqrt(sumSquares / Math.max(1, samples.length));

  // Sub-second energy contour: mean frame RMS per 0.25 s bin,
  // ABSOLUTE — cross-track comparisons (set energy, drop evidence)
  // read this, not the normalised curve below.
  const binCount = Math.max(1, Math.floor(durationSec / CONTOUR_BIN_SEC));
  const contour = new Float32Array(binCount);
  {
    const framesPerBin = CONTOUR_BIN_SEC * framesPerSecond;
    const counts = new Float32Array(binCount);
    for (let f = 0; f < energies.length; f += 1) {
      const bin = Math.min(binCount - 1, Math.floor(f / framesPerBin));
      contour[bin] += energies[f];
      counts[bin] += 1;
    }
    for (let b = 0; b < binCount; b += 1) {
      if (counts[b] > 0) contour[b] /= counts[b];
    }
  }
  const energyContour = Array.from(contour, (rms, b) => ({
    timeSec: b * CONTOUR_BIN_SEC,
    rms,
  }));

  // The v1 energy curve, kept with its exact meaning (one entry per
  // second, peak-normalised) — now derived from the contour's true
  // per-second means instead of a single sampled frame per second.
  const energyCurve: { timeSec: number; energy: number }[] = [];
  {
    const perSecond: number[] = [];
    let peak = 0;
    for (let s = 0; s < Math.floor(durationSec); s += 1) {
      const e = meanOf(contour, s * 4, s * 4 + 4);
      perSecond.push(e);
      if (e > peak) peak = e;
    }
    for (let s = 0; s < perSecond.length; s += 1) {
      energyCurve.push({
        timeSec: s,
        energy: peak > 0 ? perSecond[s] / peak : 0,
      });
    }
  }

  const drops = findDropEvents(contour, beatMap);

  // Graded vocals. The fast pass measures alternate windows — the
  // activity curve is smooth at that scale, and the ranges the old
  // decider reads are derived from whatever curve was measured.
  const vocalActivity = detectVocalActivity(
    samples,
    sampleRate,
    depth === "fast" ? { stepSec: 0.5 } : {},
  );
  const vocalRanges = vocalRangesFromActivity(vocalActivity);

  // Key: the opening window always (v1's read). The deep pass adds
  // the closing stretch and the middle of long tracks, and folds the
  // windows' agreement into the reported key's confidence.
  const openingSamples = samples.subarray(
    0,
    Math.min(samples.length, Math.floor(45 * sampleRate)),
  );
  const openingKey = detectKey(openingSamples, sampleRate);
  let keyWindows: KeyWindows = {
    opening: openingKey,
    body: null,
    closing: null,
  };
  let key = openingKey;
  if (depth === "deep") {
    let bodyKey: KeyEstimate | null = null;
    let closingKey: KeyEstimate | null = null;
    if (durationSec >= 70) {
      const closingStart = Math.floor((durationSec - 30) * sampleRate);
      closingKey = detectKey(samples.subarray(closingStart), sampleRate);
    }
    if (durationSec >= 120) {
      const bodyStart = Math.floor(((durationSec - 30) / 2) * sampleRate);
      bodyKey = detectKey(
        samples.subarray(bodyStart, bodyStart + Math.floor(30 * sampleRate)),
        sampleRate,
      );
    }
    keyWindows = { opening: openingKey, body: bodyKey, closing: closingKey };
    key = combineKeyWindows([openingKey, bodyKey, closingKey]);
  }

  const { sections, intro, outro } = findSections(
    contour,
    durationSec,
    beatMap,
    drops,
    vocalActivity,
  );

  return {
    beatMap,
    tempoConfidence: tempo.confidence,
    energyCurve,
    drops,
    key,
    vocalRanges,
    loudness,
    analysisVersion: ANALYSIS_VERSION,
    audioHash: audioFingerprint(samples, sampleRate),
    depth,
    sections,
    intro,
    outro,
    energyContour,
    vocalActivity,
    keyWindows,
  };
}

/** Mixes an AudioBuffer down to mono samples. */
export function mixdownToMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < buffer.length; i += 1) mono[i] += data[i];
  }
  if (buffer.numberOfChannels > 1) {
    for (let i = 0; i < mono.length; i += 1) {
      mono[i] /= buffer.numberOfChannels;
    }
  }
  return mono;
}

/** Mixes an AudioBuffer down to mono samples and analyses them. */
export function analyseAudioBuffer(
  buffer: AudioBuffer,
  options: AnalyseOptions = {},
): TrackAnalysis | null {
  return analyseTrack(mixdownToMono(buffer), buffer.sampleRate, options);
}
