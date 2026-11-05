// facts.ts — the liveRave facts layer (Wave 1 foundation).
//
// Pure analysis consumption for the NEW engine. This module defines
// the new engine's own analysis-result type, `TrackRead` — the
// document a fresh analyser (built separately) produces per track —
// and derives `TrackFacts` from it: the normalised, helper-carrying
// view the authors, brain and session read.
//
// HARD RULES honoured here:
// - No imports from src/features/mixer/engine/ at all. The old
//   analysis layer is being purged and rewritten; nothing in this
//   file touches it. Key-fit is computed here, fresh, from standard
//   Camelot-wheel semantics over the read's camelot/tonic/mode
//   fields.
// - Environment-pure: no DOM, no storage, no worker globals. Plain
//   data in, plain data out, so the identical code can run in the
//   app, in a worker, or on a server.
// - Never throws. A null read (or a read full of holes) yields a
//   facts object with everything unknown/unwitnessed, so callers
//   degrade honestly instead of crashing.

// ---------------------------------------------------------------------
// TrackRead — the new engine's analysis-result type (input contract)
// ---------------------------------------------------------------------

export type AnalysisDepth = "fast" | "deep";

export type SectionKind =
  "intro" | "verse" | "chorus" | "breakdown" | "bridge" | "outro" | "drop";

export interface TrackReadKey {
  /** Tonic pitch class: 0 = C, 1 = C#, …, 11 = B. */
  tonic: number;
  mode: "major" | "minor";
  /** Camelot wheel label, e.g. "8B" for C major, "8A" for A minor. */
  camelot: string;
  /** 0..1 — how decisive the key evidence was. */
  confidence: number;
}

export interface TrackReadGrid {
  /** Beat times in track milliseconds, ascending. */
  beatsMs: number[];
  /** Downbeat times in track milliseconds, ascending. */
  downbeatsMs: number[];
  beatsPerBar: number;
  /** 0..1 — how strongly the grid evidence agreed. */
  confidence: number;
}

export interface TrackReadSection {
  kind: SectionKind;
  startMs: number;
  endMs: number;
  /** Mean energy across the span (absolute RMS scale of the contour). */
  meanEnergy: number;
}

export interface TrackReadEnergyBin {
  atMs: number;
  rms: number;
}

export interface TrackReadVocalWindow {
  startMs: number;
  endMs: number;
  /** 0..1 — how vocal this window measures. */
  activity: number;
  /** 0..1 — how decisive the evidence behind `activity` was. */
  confidence: number;
}

export interface TrackReadDrop {
  atMs: number;
  /** Graded strength: after-level divided by before-level. */
  strength: number;
}

/**
 * One track's analysis, as produced by the fresh analyser. All times
 * are track milliseconds. Arrays may be empty when a pass could not
 * measure them; consumers must treat absence as "unknown", never as
 * "zero evidence against".
 */
export interface TrackRead {
  audioHash: string;
  analysisVersion: number;
  depth: AnalysisDepth;
  durationSec: number;
  bpm: number;
  /** 0..1 — how strongly the winning tempo stood out. */
  tempoConfidence: number;
  grid: TrackReadGrid;
  key: TrackReadKey | null;
  sections: TrackReadSection[];
  /** Loudness over time, one entry per second, normalised 0..1. */
  energyCurvePerSec: number[];
  /** Sub-second energy contour: absolute RMS per ~0.25 s bin. */
  energyContour: TrackReadEnergyBin[];
  /** Graded vocal activity windows with per-window confidence. */
  vocalActivity: TrackReadVocalWindow[];
  drops: TrackReadDrop[];
  /** Whole-track RMS loudness, absolute. */
  loudnessRms: number;
}

// ---------------------------------------------------------------------
// Key fit — fresh Camelot-wheel math over TrackReadKey fields
// ---------------------------------------------------------------------

export type KeyRelation =
  | "same"
  | "relative"
  | "adjacent"
  | "diagonal"
  | "parallel"
  | "near"
  | "distant";

export interface KeyFit {
  /** 0..1 — 1 is a perfect harmonic match. */
  score: number;
  relation: KeyRelation;
  /** True when a blend is harmonically safe (score at least 0.6). */
  compatible: boolean;
}

export const KEY_COMPATIBLE_THRESHOLD = 0.6;

function camelotParts(key: TrackReadKey): { number: number; letter: string } {
  const match = /^(\d{1,2})([AB])$/.exec(key.camelot);
  if (!match) return { number: 0, letter: "" };
  return { number: parseInt(match[1], 10), letter: match[2] };
}

function wheelDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 12;
  return Math.min(diff, 12 - diff);
}

/**
 * How well two keys sit together, by standard Camelot-wheel practice:
 * same key 1.0; relative major/minor (same number, other letter) 0.9;
 * one step around the wheel in the same mode 0.85; one step plus the
 * other letter ("diagonal") 0.6; parallel key (same tonic, other
 * mode) 0.5; two steps in the same mode 0.35; anything further 0.1.
 * Returns null when either key is unknown — unknown is not a clash.
 */
export function keyFitBetween(
  a: TrackReadKey | null,
  b: TrackReadKey | null,
): KeyFit | null {
  if (!a || !b) return null;

  if (a.tonic === b.tonic && a.mode === b.mode) {
    return { score: 1, relation: "same", compatible: true };
  }
  // Same tonic, other mode: the parallel key.
  if (a.tonic === b.tonic) {
    return { score: 0.5, relation: "parallel", compatible: false };
  }

  const pa = camelotParts(a);
  const pb = camelotParts(b);
  const distance = wheelDistance(pa.number, pb.number);
  const sameLetter = pa.letter === pb.letter;

  if (distance === 0) {
    // Same number, other letter, different tonic: the relative.
    return { score: 0.9, relation: "relative", compatible: true };
  }
  if (distance === 1 && sameLetter) {
    return { score: 0.85, relation: "adjacent", compatible: true };
  }
  if (distance === 1) {
    return { score: 0.6, relation: "diagonal", compatible: true };
  }
  if (distance === 2 && sameLetter) {
    return { score: 0.35, relation: "near", compatible: false };
  }
  return { score: 0.1, relation: "distant", compatible: false };
}

// ---------------------------------------------------------------------
// TrackFacts — the derived, helper-carrying view (output)
// ---------------------------------------------------------------------

export interface FactSection {
  kind: SectionKind;
  startMs: number;
  endMs: number;
  /** Mean energy across the span (the read's meanEnergy). */
  energy: number;
}

export interface FactPhrase {
  startMs: number;
  endMs: number;
  /** Beat index of the phrase start, counted from beat 0. */
  startBeat: number;
  endBeat: number;
}

export interface FactSpan {
  startMs: number;
  endMs: number;
}

export interface VocalWindowResult {
  /** Overlap-weighted mean graded vocal activity, 0..1. */
  mean: number;
  /** Overlap-weighted mean confidence of the covering windows, 0..1. */
  confidence: number;
  /**
   * True when the window was actually measured: enough of it is
   * covered by vocal windows AND their confidence clears
   * VOCAL_WITNESS_MIN_CONFIDENCE. Unwitnessed means UNKNOWN — authors
   * treat it conservatively; it is not evidence of silence.
   */
  witnessed: boolean;
}

export interface EnergyContourAccess {
  bins: TrackReadEnergyBin[];
  /** Energy (absolute RMS) at a track time; 0 when unmeasured. */
  energyAt(ms: number): number;
  /** Mean energy across [aMs, bMs]; 0 when unmeasured. */
  windowMeanEnergy(aMs: number, bMs: number): number;
}

export interface VocalAccess {
  windows: TrackReadVocalWindow[];
  /** Graded vocal evidence across [aMs, bMs]. */
  vocalActivityIn(aMs: number, bMs: number): VocalWindowResult;
}

export interface EvidenceQuality {
  /** 0..1 — plain mean of the five evidence shares below. */
  score: number;
  tempoConfidence: number;
  gridConfidence: number;
  /** Share of the track's duration covered by typed sections, 0..1. */
  sectionCoverage: number;
  /** Share of the track's duration covered by vocal windows, 0..1. */
  vocalCoverage: number;
  /** The key estimate's confidence; 0 when there is no key. */
  keyConfidence: number;
  depth: AnalysisDepth | null;
  beatmatchTrusted: boolean;
}

export interface TrackFacts {
  trackId: string;
  /** Authoritative duration when known; null only when unknown. */
  durationMs: number | null;
  audioHash: string | null;
  analysisVersion: number | null;
  depth: AnalysisDepth | null;
  tempo: {
    /** Beats per minute; null when no read measured one. */
    bpm: number | null;
    confidence: number;
  };
  grid: {
    beatMs: number[];
    downbeatMs: number[];
    beatsPerBar: number;
    confidence: number;
  };
  phrases: FactPhrase[];
  sections: FactSection[];
  key: TrackReadKey | null;
  /** Harmonic fit of this track's key against another track's facts. */
  keyFitTo(other: TrackFacts): KeyFit | null;
  energyContour: EnergyContourAccess;
  vocals: VocalAccess;
  /** Drop points in chronological order. */
  drops: { atMs: number; strength: number }[];
  intro: FactSpan | null;
  outro: FactSpan | null;
  /**
   * Note 33 floor semantics: the DJ may not move on before this much
   * of the track has played (the floor binds the DJ, never the user).
   * Genuine section-based floor when the section evidence is
   * witnessed; otherwise the derived floor (duration/4, capped at
   * 90_000). A genuine floor computed under 10_000 is raised to the
   * derived floor. Null ONLY when the duration is unknown.
   */
  minimumPlayMs: number | null;
  /** Loopable spans: breakdown/outro sections at least 8 beats long. */
  loopSpans: FactSpan[];
  /** tempoConf >= 0.12 && gridConf >= 0.15. */
  beatmatchTrusted: boolean;
  loudnessRms: number | null;
  evidenceQuality: EvidenceQuality;
  /** Fractional beat index at a track time; null when no grid. */
  beatAtMs(ms: number): number | null;
  /** Track time at a (fractional) beat index; null when no grid. */
  timeAtBeatMs(beat: number): number | null;
}

// ---------------------------------------------------------------------
// Thresholds (stated, with their reasons)
// ---------------------------------------------------------------------

/** Beatmatch trust lines (design §3.1): tempo evidence floor. */
export const TEMPO_TRUST_MIN = 0.12;
/** Beatmatch trust lines (design §3.1): grid evidence floor. */
export const GRID_TRUST_MIN = 0.15;

/**
 * Vocal witness confidence line. The graded vocal measurement stamps
 * confidence as energyFactor × (0.35 + 0.65 × marginDecisiveness):
 * 0.35 is the indecision floor (a window whose margins straddle their
 * thresholds, however loud, is a guess), and 1.0 is a loud window
 * whose margins are fully decisive. 0.5 sits clearly above the guess
 * floor — it requires both real energy in the window and margins at
 * least moderately decisive — while remaining reachable by honest
 * mid-scale evidence. Below it, a window's activity is reported but
 * NOT witnessed: authors may not spend it as proof either way.
 */
export const VOCAL_WITNESS_MIN_CONFIDENCE = 0.5;

/**
 * Vocal witness coverage line. Each vocal window stands for the span
 * until the next window starts (sampled-curve semantics, so a fast
 * pass measuring alternate windows still tiles the track); a query
 * span is witnessed only when at least three quarters of it is
 * covered by such spans.
 */
export const VOCAL_WITNESS_MIN_COVERAGE = 0.75;

/**
 * Section witness lines for the genuine minimum-play floor: at least
 * two typed sections jointly covering at least 60% of the track. One
 * section spanning everything, or fragments covering a sliver, is
 * thin evidence and the floor derives instead.
 */
export const SECTION_WITNESS_MIN_COUNT = 2;
export const SECTION_WITNESS_MIN_COVERAGE = 0.6;

/** Derived floor cap and the genuine-floor lower bound (Note 33). */
export const DERIVED_FLOOR_CAP_MS = 90_000;
export const MINIMUM_FLOOR_MS = 10_000;

/** Loopable spans must run at least this many beats. */
export const LOOP_SPAN_MIN_BEATS = 8;

/** Bars per phrase for phrase derivation. */
export const BARS_PER_PHRASE = 4;

// ---------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function cleanTimes(values: number[] | undefined): number[] {
  if (!values) return [];
  const out: number[] = [];
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out.push(v);
  }
  out.sort((a, z) => a - z);
  return out.filter((v, i) => i === 0 || v !== out[i - 1]);
}

// ---------------------------------------------------------------------
// buildTrackFacts
// ---------------------------------------------------------------------

export function buildTrackFacts(
  trackId: string,
  read: TrackRead | null,
  durationMs: number | null,
): TrackFacts {
  // Effective duration: the caller's duration wins when supplied;
  // otherwise the read's own duration; otherwise unknown.
  const readDurationMs =
    read && Number.isFinite(read.durationSec) && read.durationSec > 0
      ? read.durationSec * 1000
      : null;
  const effectiveDurationMs =
    durationMs !== null &&
    durationMs !== undefined &&
    Number.isFinite(durationMs) &&
    durationMs > 0
      ? durationMs
      : readDurationMs;

  const tempoConfidence = read ? clamp01(finiteOr(read.tempoConfidence, 0)) : 0;
  const gridConfidence = read ? clamp01(finiteOr(read.grid?.confidence, 0)) : 0;
  const bpm =
    read && Number.isFinite(read.bpm) && read.bpm > 0 ? read.bpm : null;

  const beatMs = cleanTimes(read?.grid?.beatsMs);
  const downbeatMs = cleanTimes(read?.grid?.downbeatsMs);
  const beatsPerBar =
    read && Number.isFinite(read.grid?.beatsPerBar) && read.grid.beatsPerBar > 0
      ? Math.round(read.grid.beatsPerBar)
      : 4;

  const beatmatchTrusted =
    tempoConfidence >= TEMPO_TRUST_MIN && gridConfidence >= GRID_TRUST_MIN;

  // --- Beat <-> time interpolation over the read's grid -------------
  function beatAtMs(ms: number): number | null {
    if (beatMs.length === 0 || !Number.isFinite(ms)) return null;
    if (beatMs.length === 1) return ms <= beatMs[0] ? 0 : null;
    if (ms <= beatMs[0]) {
      const spb = beatMs[1] - beatMs[0];
      return spb > 0 ? (ms - beatMs[0]) / spb : 0;
    }
    const last = beatMs.length - 1;
    if (ms >= beatMs[last]) {
      const spb = beatMs[last] - beatMs[last - 1];
      return spb > 0 ? last + (ms - beatMs[last]) / spb : last;
    }
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (beatMs[mid] <= ms) lo = mid;
      else hi = mid;
    }
    const span = beatMs[hi] - beatMs[lo];
    return span > 0 ? lo + (ms - beatMs[lo]) / span : lo;
  }

  function timeAtBeatMs(beat: number): number | null {
    if (beatMs.length === 0 || !Number.isFinite(beat)) return null;
    if (beatMs.length === 1) return beat === 0 ? beatMs[0] : null;
    const last = beatMs.length - 1;
    if (beat <= 0) {
      const spb = beatMs[1] - beatMs[0];
      return beatMs[0] + beat * spb;
    }
    if (beat >= last) {
      const spb = beatMs[last] - beatMs[last - 1];
      return beatMs[last] + (beat - last) * spb;
    }
    const lo = Math.floor(beat);
    const hi = lo + 1;
    return beatMs[lo] + (beat - lo) * (beatMs[hi] - beatMs[lo]);
  }

  // --- Sections ------------------------------------------------------
  const sections: FactSection[] = [];
  if (read?.sections) {
    for (const s of read.sections) {
      if (!s || !Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) {
        continue;
      }
      let startMs = Math.max(0, s.startMs);
      let endMs = s.endMs;
      if (effectiveDurationMs !== null) {
        startMs = Math.min(startMs, effectiveDurationMs);
        endMs = Math.min(endMs, effectiveDurationMs);
      }
      if (endMs <= startMs) continue;
      sections.push({
        kind: s.kind,
        startMs,
        endMs,
        energy: finiteOr(s.meanEnergy, 0),
      });
    }
    sections.sort((a, z) => a.startMs - z.startMs);
  }

  const sectionCoverage =
    effectiveDurationMs !== null && effectiveDurationMs > 0
      ? clamp01(
          sections.reduce((sum, s) => sum + (s.endMs - s.startMs), 0) /
            effectiveDurationMs,
        )
      : 0;

  const introSection = sections.find((s) => s.kind === "intro");
  const intro: FactSpan | null = introSection
    ? { startMs: introSection.startMs, endMs: introSection.endMs }
    : null;
  let outro: FactSpan | null = null;
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (sections[i].kind === "outro") {
      outro = { startMs: sections[i].startMs, endMs: sections[i].endMs };
      break;
    }
  }

  // --- Phrases: 4-bar groups from the grid, split where a section --
  // --- starts exactly on a downbeat. -------------------------------
  const phrases: FactPhrase[] = [];
  if (beatMs.length > 0) {
    const phraseBeats = beatsPerBar * BARS_PER_PHRASE;
    const boundaries = new Set<number>();
    for (let b = 0; b < beatMs.length; b += phraseBeats) boundaries.add(b);
    boundaries.add(beatMs.length);
    for (const s of sections) {
      const beat = beatAtMs(s.startMs);
      if (beat === null) continue;
      const rounded = Math.round(beat);
      if (
        Math.abs(beat - rounded) < 0.01 &&
        rounded % beatsPerBar === 0 &&
        rounded > 0 &&
        rounded < beatMs.length
      ) {
        boundaries.add(rounded);
      }
    }
    const sorted = [...boundaries].sort((a, z) => a - z);
    for (let i = 0; i + 1 < sorted.length; i += 1) {
      const startBeat = sorted[i];
      const endBeat = sorted[i + 1];
      const startMs = timeAtBeatMs(startBeat);
      const endMs =
        endBeat >= beatMs.length
          ? (effectiveDurationMs ?? timeAtBeatMs(endBeat))
          : timeAtBeatMs(endBeat);
      if (startMs === null || endMs === null || endMs <= startMs) continue;
      phrases.push({ startMs, endMs, startBeat, endBeat });
    }
  }

  // --- Energy contour -------------------------------------------------
  const bins: TrackReadEnergyBin[] = [];
  if (read?.energyContour) {
    for (const bin of read.energyContour) {
      if (!bin || !Number.isFinite(bin.atMs) || !Number.isFinite(bin.rms)) {
        continue;
      }
      bins.push({ atMs: Math.max(0, bin.atMs), rms: Math.max(0, bin.rms) });
    }
    bins.sort((a, z) => a.atMs - z.atMs);
  }
  const perSec: number[] =
    read?.energyCurvePerSec?.filter(
      (v) => typeof v === "number" && Number.isFinite(v),
    ) ?? [];

  function energyAt(ms: number): number {
    if (!Number.isFinite(ms)) return 0;
    if (bins.length > 0) {
      let value = bins[0].rms;
      for (const bin of bins) {
        if (bin.atMs <= ms) value = bin.rms;
        else break;
      }
      return value;
    }
    if (perSec.length > 0) {
      const idx = Math.min(
        perSec.length - 1,
        Math.max(0, Math.floor(ms / 1000)),
      );
      return perSec[idx];
    }
    return 0;
  }

  function windowMeanEnergy(aMs: number, bMs: number): number {
    if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return 0;
    const lo = Math.min(aMs, bMs);
    const hi = Math.max(aMs, bMs);
    if (hi <= lo) return energyAt(lo);
    const inside = bins.filter((bin) => bin.atMs >= lo && bin.atMs < hi);
    if (inside.length > 0) {
      return inside.reduce((sum, bin) => sum + bin.rms, 0) / inside.length;
    }
    if (bins.length === 0 && perSec.length > 0) {
      const from = Math.max(0, Math.floor(lo / 1000));
      const to = Math.min(perSec.length, Math.ceil(hi / 1000));
      if (to > from) {
        let sum = 0;
        for (let i = from; i < to; i += 1) sum += perSec[i];
        return sum / (to - from);
      }
    }
    return energyAt((lo + hi) / 2);
  }

  // --- Vocals ----------------------------------------------------------
  const windows: TrackReadVocalWindow[] = [];
  if (read?.vocalActivity) {
    for (const w of read.vocalActivity) {
      if (!w || !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) {
        continue;
      }
      if (w.endMs <= w.startMs) continue;
      windows.push({
        startMs: Math.max(0, w.startMs),
        endMs: w.endMs,
        activity: clamp01(finiteOr(w.activity, 0)),
        confidence: clamp01(finiteOr(w.confidence, 0)),
      });
    }
    windows.sort((a, z) => a.startMs - z.startMs);
  }
  // Each window stands for the span until the next window starts —
  // sampled-curve semantics, so a sparser (fast) pass still tiles.
  const effectiveEnds = windows.map((w, i) =>
    i + 1 < windows.length
      ? Math.max(w.endMs, windows[i + 1].startMs)
      : w.endMs,
  );

  const vocalCoverage =
    effectiveDurationMs !== null && effectiveDurationMs > 0
      ? clamp01(
          windows.reduce(
            (sum, w, i) => sum + Math.max(0, effectiveEnds[i] - w.startMs),
            0,
          ) / effectiveDurationMs,
        )
      : 0;

  function vocalActivityIn(aMs: number, bMs: number): VocalWindowResult {
    if (!Number.isFinite(aMs) || !Number.isFinite(bMs) || bMs <= aMs) {
      return { mean: 0, confidence: 0, witnessed: false };
    }
    let coveredMs = 0;
    let activitySum = 0;
    let confidenceSum = 0;
    for (let i = 0; i < windows.length; i += 1) {
      const start = Math.max(aMs, windows[i].startMs);
      const end = Math.min(bMs, effectiveEnds[i]);
      if (end <= start) continue;
      const overlap = end - start;
      coveredMs += overlap;
      activitySum += windows[i].activity * overlap;
      confidenceSum += windows[i].confidence * overlap;
    }
    if (coveredMs <= 0) return { mean: 0, confidence: 0, witnessed: false };
    const mean = activitySum / coveredMs;
    const confidence = confidenceSum / coveredMs;
    const coverage = coveredMs / (bMs - aMs);
    return {
      mean,
      confidence,
      witnessed:
        coverage >= VOCAL_WITNESS_MIN_COVERAGE &&
        confidence >= VOCAL_WITNESS_MIN_CONFIDENCE,
    };
  }

  // --- Drops -----------------------------------------------------------
  const drops: { atMs: number; strength: number }[] = [];
  if (read?.drops) {
    for (const d of read.drops) {
      if (!d || !Number.isFinite(d.atMs) || !Number.isFinite(d.strength)) {
        continue;
      }
      drops.push({ atMs: Math.max(0, d.atMs), strength: d.strength });
    }
    drops.sort((a, z) => a.atMs - z.atMs);
  }

  // --- Minimum play (Note 33) ------------------------------------------
  let minimumPlayMs: number | null = null;
  if (effectiveDurationMs !== null) {
    const derivedFloor = Math.min(
      effectiveDurationMs / 4,
      DERIVED_FLOOR_CAP_MS,
    );
    const sectionsWitnessed =
      sections.length >= SECTION_WITNESS_MIN_COUNT &&
      sectionCoverage >= SECTION_WITNESS_MIN_COVERAGE;
    let genuineFloor: number | null = null;
    if (sectionsWitnessed) {
      // The musically meaningful point: the end of the first body
      // section (the first section that is not an intro). The track
      // must be allowed to reach the end of its first real statement.
      const firstBody = sections.find((s) => s.kind !== "intro");
      if (firstBody && firstBody.endMs < effectiveDurationMs) {
        genuineFloor = firstBody.endMs;
      }
    }
    if (genuineFloor !== null && genuineFloor >= MINIMUM_FLOOR_MS) {
      minimumPlayMs = genuineFloor;
    } else {
      // Thin evidence — or a genuine floor so small it would let the
      // DJ bail almost immediately — falls back to the derived floor.
      minimumPlayMs = derivedFloor;
    }
  }

  // --- Loop spans --------------------------------------------------------
  const msPerBeat =
    bpm !== null
      ? 60_000 / bpm
      : beatMs.length >= 2
        ? (beatMs[beatMs.length - 1] - beatMs[0]) / (beatMs.length - 1)
        : null;
  const loopSpans: FactSpan[] = [];
  if (msPerBeat !== null && msPerBeat > 0) {
    for (const s of sections) {
      if (s.kind !== "breakdown" && s.kind !== "outro") continue;
      const beats = (s.endMs - s.startMs) / msPerBeat;
      if (beats >= LOOP_SPAN_MIN_BEATS) {
        loopSpans.push({ startMs: s.startMs, endMs: s.endMs });
      }
    }
  }

  // --- Key ----------------------------------------------------------------
  const key: TrackReadKey | null =
    read?.key &&
    Number.isFinite(read.key.tonic) &&
    typeof read.key.camelot === "string"
      ? {
          tonic: read.key.tonic,
          mode: read.key.mode === "minor" ? "minor" : "major",
          camelot: read.key.camelot,
          confidence: clamp01(finiteOr(read.key.confidence, 0)),
        }
      : null;

  const evidenceQuality: EvidenceQuality = {
    score:
      (tempoConfidence +
        gridConfidence +
        sectionCoverage +
        vocalCoverage +
        (key ? key.confidence : 0)) /
      5,
    tempoConfidence,
    gridConfidence,
    sectionCoverage,
    vocalCoverage,
    keyConfidence: key ? key.confidence : 0,
    depth: read?.depth ?? null,
    beatmatchTrusted,
  };

  const facts: TrackFacts = {
    trackId,
    durationMs: effectiveDurationMs,
    audioHash: read?.audioHash ?? null,
    analysisVersion: read?.analysisVersion ?? null,
    depth: read?.depth ?? null,
    tempo: { bpm, confidence: tempoConfidence },
    grid: { beatMs, downbeatMs, beatsPerBar, confidence: gridConfidence },
    phrases,
    sections,
    key,
    keyFitTo(other: TrackFacts): KeyFit | null {
      return keyFitBetween(facts.key, other?.key ?? null);
    },
    energyContour: { bins, energyAt, windowMeanEnergy },
    vocals: { windows, vocalActivityIn },
    drops,
    intro,
    outro,
    minimumPlayMs,
    loopSpans,
    beatmatchTrusted,
    loudnessRms:
      read && Number.isFinite(read.loudnessRms) ? read.loudnessRms : null,
    evidenceQuality,
    beatAtMs,
    timeAtBeatMs,
  };
  return facts;
}
