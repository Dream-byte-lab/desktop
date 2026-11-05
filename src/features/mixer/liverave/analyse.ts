// analyse.ts — the fresh liveRave analysis layer (Wave 1.5).
//
// Written from first principles and the design's attribute list
// (§3.0). No old analyser was consulted. Environment-pure: no DOM,
// no storage, no worker globals — plain samples in, plain data out,
// so the same code runs on the main thread (fallback), in a worker,
// or on a server.
//
// What a read contains and how each part is measured here:
// - fingerprint: length + sample rate + a quantised loudness shape
//   over 64 chunks, mixed with FNV-style hashing (constants ours).
// - energy: frame RMS → energyCurvePerSec (1 s means, normalised to
//   the loudest second) + energyContour (0.25 s bins, absolute RMS).
// - tempo: onset envelope + autocorrelation over 60–180 BPM,
//   the autocorrelation run on a lightly smoothed copy of the
//   envelope so periods near a half-integer frame count keep one
//   whole fundamental peak (see measureTempo).
//   Onset envelope choice (documented simplification): "spectral-
//   flux-lite" — positive frame-RMS differences at a 5 ms frame
//   step. It cannot see a pitch change at constant loudness, but it
//   reads percussive grids exactly, which is what tempo needs.
// - grid: beat phase anchored to onset peaks by exhaustive phase
//   search; downbeat phase chosen by onset weight on every 4th
//   beat; beatsPerBar is 4 unless the onset evidence strongly
//   prefers 3 (it rarely will — the search is honest about that).
// - sections: boundaries where the 2 s energy means before/after a
//   point change decisively (novelty segmentation over the 0.25 s
//   contour), typed by the heuristic table in `classifySections`.
// - drops: 1 s-after vs 1 s-before contour surges (ratio ≥ 1.9).
// - key: chromagram from ~0.74 s FFT windows (magnitude² mapped
//   to pitch classes — the window is long enough that a semitone
//   stays resolvable down to the 50 Hz floor, see measureKey),
//   correlated against major/minor key profiles for all 24 keys;
//   the best correlation wins, confidence blends the winning
//   correlation with its margin over the runner-up.
// - vocals: per-second windows; vocal-band (≈300 Hz–3.4 kHz) share
//   of FFT energy grades `activity`; `confidence` follows the
//   stamp described in facts.ts: energyFactor × (0.35 + 0.65 ×
//   marginDecisiveness) — a quiet or borderline window is a guess
//   and says so.
// - loudnessRms: whole-track absolute RMS.
//
// Depths: "deep" measures everything over the whole track.
// "fast" keeps the cheap passes (energy, onset, tempo, grid,
// sections, drops) whole-track — they are O(n) frame sums — and
// coarsens the spectral passes: key from windows sampled over the
// opening ~30 s only, vocals on alternate (2 s-step) windows.
// The returned TrackRead shape is identical.

import type {
  AnalysisDepth,
  SectionKind,
  TrackRead,
  TrackReadDrop,
  TrackReadKey,
  TrackReadSection,
  TrackReadVocalWindow,
} from "./facts";

export const ANALYSIS_VERSION = 1;

// ---------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Iterative radix-2 FFT (in place, power-of-two length). */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = (-2 * Math.PI) / size;
    for (let base = 0; base < n; base += size) {
      for (let k = 0; k < half; k += 1) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const even = base + k;
        const odd = even + half;
        const xr = re[odd] * wr - im[odd] * wi;
        const xi = re[odd] * wi + im[odd] * wr;
        re[odd] = re[even] - xr;
        im[odd] = im[even] - xi;
        re[even] += xr;
        im[even] += xi;
      }
    }
  }
}

function largestPow2AtMost(value: number): number {
  let size = 1;
  while (size * 2 <= value) size *= 2;
  return size;
}

/** Hann-windowed FFT magnitude² spectrum of samples[start, start+size). */
function powerSpectrum(
  samples: Float32Array,
  start: number,
  size: number,
): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const available = Math.min(size, samples.length - start);
  for (let i = 0; i < available; i += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    re[i] = samples[start + i] * hann;
  }
  fftInPlace(re, im);
  const half = size / 2;
  const power = new Float64Array(half);
  for (let k = 0; k < half; k += 1) {
    power[k] = re[k] * re[k] + im[k] * im[k];
  }
  return power;
}

// ---------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------

/**
 * Content fingerprint for a mono buffer: sample count, sample rate,
 * and a quantised loudness shape (RMS of 64 equal chunks, each
 * quantised on a log scale to 0–63), folded through two FNV-style
 * mixes with different seeds so shape collisions are unlikely.
 * Identical audio at an identical rate fingerprints identically;
 * a re-encode with a different loudness shape does not.
 */
export function audioFingerprint(
  samples: Float32Array,
  sampleRate: number,
): string {
  const chunks = 64;
  const bytes: number[] = [];
  bytes.push(samples.length & 0xff, (samples.length >> 8) & 0xff);
  bytes.push((samples.length >> 16) & 0xff, (samples.length >> 24) & 0xff);
  bytes.push(sampleRate & 0xff, (sampleRate >> 8) & 0xff);
  for (let c = 0; c < chunks; c += 1) {
    const from = Math.floor((c * samples.length) / chunks);
    const to = Math.max(
      from + 1,
      Math.floor(((c + 1) * samples.length) / chunks),
    );
    let sum = 0;
    let count = 0;
    for (let i = from; i < to && i < samples.length; i += 1) {
      const v = samples[i];
      if (Number.isFinite(v)) {
        sum += v * v;
        count += 1;
      }
    }
    const rms = count > 0 ? Math.sqrt(sum / count) : 0;
    // Log quantisation: silence ≈ 0, full scale ≈ 63.
    const q = clamp(Math.round((Math.log10(rms + 1e-6) + 6) * 10.5), 0, 63);
    bytes.push(q);
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x9e3779b9;
  for (const b of bytes) {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (b + 0x5a), 0x85ebca6b) >>> 0;
  }
  const hex = (h: number) => h.toString(16).padStart(8, "0");
  return `lr1.${samples.length}.${sampleRate}.${hex(h1)}${hex(h2)}`;
}

/** Decoder discipline: stereo → mono by (L + R) / 2. */
export function mixdownToMono(
  left: Float32Array,
  right: Float32Array,
): Float32Array {
  const length = Math.min(left.length, right.length);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (left[i] + right[i]) / 2;
  }
  return out;
}

// ---------------------------------------------------------------------
// Energy
// ---------------------------------------------------------------------

interface EnergyResult {
  /** Normalised 0..1 loudness per second. */
  perSec: number[];
  /** Absolute RMS per 0.25 s bin. */
  contour: { atMs: number; rms: number }[];
  contourBinMs: number;
  loudnessRms: number;
}

function measureEnergy(
  samples: Float32Array,
  sampleRate: number,
): EnergyResult {
  const binSamples = Math.max(1, Math.round(sampleRate * 0.25));
  const binCount = Math.max(1, Math.ceil(samples.length / binSamples));
  const contour: { atMs: number; rms: number }[] = [];
  let totalSquare = 0;
  for (let b = 0; b < binCount; b += 1) {
    const from = b * binSamples;
    const to = Math.min(samples.length, from + binSamples);
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
    totalSquare += sum;
    contour.push({
      atMs: Math.round((from / sampleRate) * 1000),
      rms: Math.sqrt(sum / Math.max(1, to - from)),
    });
  }
  const perSecCount = Math.max(1, Math.ceil(contour.length / 4));
  const rawPerSec: number[] = [];
  for (let s = 0; s < perSecCount; s += 1) {
    let sumSquares = 0;
    let n = 0;
    for (let b = s * 4; b < Math.min(contour.length, s * 4 + 4); b += 1) {
      sumSquares += contour[b].rms * contour[b].rms;
      n += 1;
    }
    rawPerSec.push(n > 0 ? Math.sqrt(sumSquares / n) : 0);
  }
  const peak = Math.max(...rawPerSec, 0);
  const perSec = rawPerSec.map((v) => (peak > 0 ? clamp01(v / peak) : 0));
  return {
    perSec,
    contour,
    contourBinMs: (binSamples / sampleRate) * 1000,
    loudnessRms: Math.sqrt(totalSquare / Math.max(1, samples.length)),
  };
}

// ---------------------------------------------------------------------
// Tempo + grid (onset autocorrelation)
// ---------------------------------------------------------------------

interface TempoResult {
  bpm: number;
  tempoConfidence: number;
  beatsMs: number[];
  downbeatsMs: number[];
  beatsPerBar: number;
  gridConfidence: number;
}

const MIN_BPM = 60;
const MAX_BPM = 180;

function measureTempo(
  samples: Float32Array,
  sampleRate: number,
  durationMs: number,
): TempoResult {
  const empty: TempoResult = {
    bpm: 0,
    tempoConfidence: 0,
    beatsMs: [],
    downbeatsMs: [],
    beatsPerBar: 4,
    gridConfidence: 0,
  };
  // 5 ms frames: fine enough that parabolic peak refinement lands
  // the period within ~1 BPM across the whole 60–180 range.
  const frameSamples = Math.max(32, Math.round(sampleRate * 0.005));
  const frameMs = (frameSamples / sampleRate) * 1000;
  const frameCount = Math.floor(samples.length / frameSamples);
  if (frameCount < 200) return empty; // under ~1 s: no honest tempo

  const rms = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    const from = f * frameSamples;
    let sum = 0;
    for (let i = 0; i < frameSamples; i += 1) {
      const v = samples[from + i];
      sum += v * v;
    }
    rms[f] = Math.sqrt(sum / frameSamples);
  }
  const onset = new Float64Array(frameCount);
  for (let f = 1; f < frameCount; f += 1) {
    onset[f] = Math.max(0, rms[f] - rms[f - 1]);
  }
  let onsetSum = 0;
  for (const v of onset) onsetSum += v;
  const onsetMean = onsetSum / frameCount;
  if (onsetMean <= 0) return empty;
  let variance = 0;
  for (const v of onset) variance += (v - onsetMean) * (v - onsetMean);
  variance /= frameCount;
  if (variance <= 0) return empty;

  // Period selection works on a lightly smoothed copy of the onset
  // envelope: each onset is spread over its neighbouring frames
  // with a [¼, ½, ¼] kernel before autocorrelation. Why: the raw
  // envelope's onsets are single-frame impulses, so an integer lag
  // only credits beat pairs whose spacing rounds to exactly that
  // lag. When the true period sits near a half-integer frame count,
  // consecutive-beat spacings split between the two neighbouring
  // integer lags (96 and 97 frames, say), each lag collects only
  // its share of the pairs, and the fundamental peak splits in
  // two — while the doubled period, whose fractional part lands
  // near an integer again, keeps one concentrated peak and wins,
  // reading the track at exactly half tempo. Spreading each onset
  // over ±1 frame makes a beat pair credit lags within a frame of
  // its true spacing, so the fundamental peak stays whole at any
  // fractional period. The raw envelope is kept untouched for the
  // phase anchoring and grid scoring below, where the sharp
  // impulses are the evidence.
  const corr = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    const prev = f > 0 ? onset[f - 1] : 0;
    const next = f + 1 < frameCount ? onset[f + 1] : 0;
    corr[f] = 0.25 * prev + 0.5 * onset[f] + 0.25 * next;
  }
  let corrSum = 0;
  for (const v of corr) corrSum += v;
  const corrMean = corrSum / frameCount;
  let corrVariance = 0;
  for (const v of corr) corrVariance += (v - corrMean) * (v - corrMean);
  corrVariance /= frameCount;
  if (corrVariance <= 0) return empty;

  // Normalised autocorrelation over the lag range for 60–180 BPM.
  const lagMin = Math.max(2, Math.floor(60_000 / MAX_BPM / frameMs));
  const lagMax = Math.min(
    frameCount - 2,
    Math.ceil(60_000 / MIN_BPM / frameMs),
  );
  if (lagMax <= lagMin) return empty;
  const scores = new Float64Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    let sum = 0;
    const n = frameCount - lag;
    for (let i = 0; i < n; i += 1) {
      sum += (corr[i] - corrMean) * (corr[i + lag] - corrMean);
    }
    scores[lag] = sum / (n * corrVariance);
  }
  let bestLag = lagMin;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    if (scores[lag] > bestScore) {
      bestScore = scores[lag];
      bestLag = lag;
    }
  }
  if (!(bestScore > 0)) return empty;

  // Half/double-time disambiguation (documented rule): multiples of
  // the true period also correlate strongly, so the FUNDAMENTAL is
  // the smallest lag that is a local peak of the autocorrelation
  // and reaches 80% of the best peak's score. The local-peak
  // condition matters on the smoothed envelope: the fundamental's
  // peak has shoulders a frame either side that can also clear
  // 80%, and picking a shoulder would bias the period by a frame
  // before refinement even starts. A spurious half-period peak
  // would need onsets genuinely landing on the off-beats at ≥80%
  // strength — i.e. the track really does pulse twice as fast — so
  // the smallest-qualifying-peak rule is the honest one. If no
  // local peak qualifies (a monotone edge at the range boundary),
  // the best lag stands.
  let chosenLag = bestLag;
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    if (scores[lag] < 0.8 * bestScore) continue;
    const left = lag > lagMin ? scores[lag - 1] : -Infinity;
    const right = lag < lagMax ? scores[lag + 1] : -Infinity;
    if (scores[lag] >= left && scores[lag] >= right) {
      chosenLag = lag;
      break;
    }
  }
  // Parabolic refinement around the chosen lag.
  let refinedLag = chosenLag;
  if (chosenLag > lagMin && chosenLag < lagMax) {
    const a = scores[chosenLag - 1];
    const b = scores[chosenLag];
    const c = scores[chosenLag + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) {
      refinedLag = chosenLag + clamp(0.5 * ((a - c) / denom), -0.5, 0.5);
    }
  }
  const periodFrames = refinedLag;
  const periodMs = periodFrames * frameMs;
  const bpm = 60_000 / periodMs;

  // Confidence: the winning correlation's prominence over the
  // median autocorrelation in range (the "noise floor" of lags).
  const sortedScores = Array.from(scores.slice(lagMin, lagMax + 1)).sort(
    (x, y) => x - y,
  );
  const medianScore = sortedScores[Math.floor(sortedScores.length / 2)] ?? 0;
  const chosenScore = scores[chosenLag];
  const tempoConfidence = clamp01(
    (chosenScore - medianScore) / Math.max(0.25, 1 - medianScore),
  );

  // Beat phase: exhaustive search over one period, scoring the
  // onset envelope summed at beat positions.
  const periodInt = Math.max(2, Math.round(periodFrames));
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  for (let phase = 0; phase < periodInt; phase += 1) {
    let score = 0;
    for (let t = phase; t < frameCount; t += periodFrames) {
      const idx = Math.round(t);
      if (idx < frameCount) score += onset[idx];
    }
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = phase;
    }
  }
  const firstBeatMs = bestPhase * frameMs;
  const beatsMs: number[] = [];
  for (let t = firstBeatMs; t <= durationMs; t += periodMs) {
    beatsMs.push(Math.round(t));
  }
  if (beatsMs.length < 2) return { ...empty, bpm, tempoConfidence };

  // Grid confidence: how much stronger onsets are ON the beats than
  // on average. Aligned beats over impulse-like onsets give a large
  // ratio; a phase that means nothing gives ≈1.
  let beatOnsetSum = 0;
  for (const beatMs of beatsMs) {
    const idx = clamp(Math.round(beatMs / frameMs), 0, frameCount - 1);
    beatOnsetSum += onset[idx];
  }
  const beatOnsetMean = beatOnsetSum / beatsMs.length;
  const ratio = beatOnsetMean / Math.max(onsetMean, 1e-9);
  const alignmentScore = clamp01(1 - 1 / Math.sqrt(Math.max(1, ratio)));
  const gridConfidence = clamp01(0.5 * tempoConfidence + 0.5 * alignmentScore);

  // Downbeat phase and bars-per-bar: try 4 (and, honestly, 3) —
  // choose the grouping whose every-nth beats carry the most onset
  // weight. 4 wins ties by a wide prior margin: the challenger must
  // beat it by 15% to displace it.
  function downbeatScore(beatsPerBar: number, shift: number): number {
    let sum = 0;
    let n = 0;
    for (let i = shift; i < beatsMs.length; i += beatsPerBar) {
      const idx = clamp(Math.round(beatsMs[i] / frameMs), 0, frameCount - 1);
      sum += onset[idx];
      n += 1;
    }
    return n > 0 ? sum / n : 0;
  }
  let beatsPerBar = 4;
  let bestShift = 0;
  let bestDownScore = -Infinity;
  for (let s = 0; s < 4; s += 1) {
    const score = downbeatScore(4, s);
    if (score > bestDownScore) {
      bestDownScore = score;
      bestShift = s;
    }
  }
  let best3 = -Infinity;
  for (let s = 0; s < 3; s += 1) {
    best3 = Math.max(best3, downbeatScore(3, s));
  }
  if (best3 > bestDownScore * 1.15) {
    beatsPerBar = 3;
    bestShift = 0;
    let sc = -Infinity;
    for (let s = 0; s < 3; s += 1) {
      const v = downbeatScore(3, s);
      if (v > sc) {
        sc = v;
        bestShift = s;
      }
    }
  }
  const downbeatsMs: number[] = [];
  for (let i = bestShift; i < beatsMs.length; i += beatsPerBar) {
    downbeatsMs.push(beatsMs[i]);
  }

  return {
    bpm,
    tempoConfidence,
    beatsMs,
    downbeatsMs,
    beatsPerBar,
    gridConfidence,
  };
}

// ---------------------------------------------------------------------
// Drops + sections (contour segmentation)
// ---------------------------------------------------------------------

function detectDrops(
  contour: { atMs: number; rms: number }[],
  binMs: number,
): TrackReadDrop[] {
  if (contour.length < 9) return [];
  const maxRms = Math.max(...contour.map((b) => b.rms), 0);
  if (maxRms <= 0) return [];
  const windowBins = Math.max(1, Math.round(1000 / binMs)); // 1 s
  interface Candidate {
    atMs: number;
    strength: number;
  }
  const candidates: Candidate[] = [];
  for (let i = windowBins; i + windowBins <= contour.length; i += 1) {
    let before = 0;
    let after = 0;
    for (let b = i - windowBins; b < i; b += 1) before += contour[b].rms;
    for (let b = i; b < i + windowBins; b += 1) after += contour[b].rms;
    before /= windowBins;
    after /= windowBins;
    const strength = after / Math.max(before, 1e-6);
    if (strength >= 1.9 && after >= 0.3 * maxRms) {
      candidates.push({ atMs: contour[i].atMs, strength });
    }
  }
  candidates.sort((a, z) => z.strength - a.strength);
  const chosen: Candidate[] = [];
  for (const c of candidates) {
    if (chosen.every((o) => Math.abs(o.atMs - c.atMs) >= 2000)) {
      chosen.push(c);
    }
  }
  chosen.sort((a, z) => a.atMs - z.atMs);
  return chosen.map((c) => ({
    atMs: c.atMs,
    strength: Math.round(c.strength * 100) / 100,
  }));
}

/**
 * Section typing heuristic table (honest heuristics, labelled):
 * Boundaries come from contour novelty; kinds are then assigned in
 * this order —
 *  1. a non-first segment that STARTS on a detected drop and is
 *     among the loudest segments → "drop";
 *  2. the first segment → "intro" (a lone segment → "verse");
 *  3. the last segment → "outro" (by position);
 *  4. an interior segment whose mean energy is ≤55% of the median
 *     segment energy or of its neighbours' mean → "breakdown"
 *     (energy collapse);
 *  5. an interior segment at ≥85% of the loudest segment's energy
 *     → "chorus" (high-energy body);
 *  6. an interior moderate segment right after a chorus →
 *     "bridge" (connective contrast);
 *  7. any other interior segment → "verse".
 */
function classifySections(
  contour: { atMs: number; rms: number }[],
  binMs: number,
  durationMs: number,
  drops: TrackReadDrop[],
): TrackReadSection[] {
  if (contour.length === 0 || durationMs <= 0) return [];
  const windowBins = Math.max(2, Math.round(2000 / binMs)); // 2 s
  interface Boundary {
    atMs: number;
    novelty: number;
  }
  const boundaries: Boundary[] = [];
  for (let i = windowBins; i + windowBins <= contour.length; i += 1) {
    let before = 0;
    let after = 0;
    for (let b = i - windowBins; b < i; b += 1) before += contour[b].rms;
    for (let b = i; b < i + windowBins; b += 1) after += contour[b].rms;
    before /= windowBins;
    after /= windowBins;
    const novelty = Math.abs(after - before) / Math.max(after + before, 1e-9);
    if (novelty < 0.38) continue;
    // Local maximum within ±1 s.
    let isMax = true;
    for (
      let j = Math.max(windowBins, i - 4);
      j <= Math.min(contour.length - windowBins, i + 4);
      j += 1
    ) {
      if (j === i) continue;
      let b2 = 0;
      let a2 = 0;
      for (let b = j - windowBins; b < j; b += 1) b2 += contour[b].rms;
      for (let b = j; b < j + windowBins; b += 1) a2 += contour[b].rms;
      const n2 = Math.abs(a2 - b2) / Math.max(a2 + b2, 1e-9);
      if (n2 > novelty) {
        isMax = false;
        break;
      }
    }
    if (isMax) boundaries.push({ atMs: contour[i].atMs, novelty });
  }
  // Greedy by strength, ≥3 s apart.
  boundaries.sort((a, z) => z.novelty - a.novelty);
  const keptMs: number[] = [];
  for (const b of boundaries) {
    if (keptMs.every((t) => Math.abs(t - b.atMs) >= 3000)) keptMs.push(b.atMs);
  }
  keptMs.sort((a, z) => a - z);

  const cuts = [
    0,
    ...keptMs.filter((t) => t > 0 && t < durationMs),
    durationMs,
  ];
  interface Segment {
    startMs: number;
    endMs: number;
    meanEnergy: number;
  }
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const startMs = cuts[i];
    const endMs = cuts[i + 1];
    const inside = contour.filter((b) => b.atMs >= startMs && b.atMs < endMs);
    const meanEnergy =
      inside.length > 0
        ? inside.reduce((s, b) => s + b.rms, 0) / inside.length
        : 0;
    segments.push({ startMs, endMs, meanEnergy });
  }
  // Merge segments shorter than 3 s into the previous segment
  // (or the next, for a short first segment).
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments.length <= 1) break;
    if (segments[i].endMs - segments[i].startMs >= 3000) continue;
    if (i > 0) {
      const prev = segments[i - 1];
      const cur = segments[i];
      prev.meanEnergy =
        (prev.meanEnergy * (prev.endMs - prev.startMs) +
          cur.meanEnergy * (cur.endMs - cur.startMs)) /
        (cur.endMs - prev.startMs);
      prev.endMs = cur.endMs;
      segments.splice(i, 1);
    } else {
      const cur = segments[0];
      const next = segments[1];
      next.meanEnergy =
        (cur.meanEnergy * (cur.endMs - cur.startMs) +
          next.meanEnergy * (next.endMs - next.startMs)) /
        (next.endMs - cur.startMs);
      next.startMs = cur.startMs;
      segments.splice(0, 1);
    }
  }
  if (segments.length === 0) return [];

  const means = segments.map((s) => s.meanEnergy).sort((a, z) => a - z);
  const medianMean = means[Math.floor(means.length / 2)] ?? 0;
  const maxMean = means[means.length - 1] ?? 0;

  const sections: TrackReadSection[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    let kind: SectionKind;
    const startsDrop =
      i > 0 &&
      seg.meanEnergy >= 0.8 * maxMean &&
      drops.some((d) => Math.abs(d.atMs - seg.startMs) <= 600);
    if (segments.length === 1) kind = "verse";
    else if (startsDrop) kind = "drop";
    else if (i === 0) kind = "intro";
    else if (i === segments.length - 1) kind = "outro";
    else {
      const neighbours =
        (segments[i - 1].meanEnergy + segments[i + 1].meanEnergy) / 2;
      if (
        seg.meanEnergy <= 0.55 * Math.max(medianMean, 1e-9) ||
        seg.meanEnergy <= 0.55 * Math.max(neighbours, 1e-9)
      ) {
        kind = "breakdown";
      } else if (seg.meanEnergy >= 0.85 * maxMean) {
        kind = "chorus";
      } else if (sections[i - 1]?.kind === "chorus") {
        kind = "bridge";
      } else {
        kind = "verse";
      }
    }
    sections.push({
      kind,
      startMs: Math.round(seg.startMs),
      endMs: Math.round(seg.endMs),
      meanEnergy: seg.meanEnergy,
    });
  }
  return sections;
}

// ---------------------------------------------------------------------
// Key (chromagram)
// ---------------------------------------------------------------------

// Key profiles (Krumhansl–Kessler probe-tone ratings — the standard
// published weights for major/minor key profiles, used as data).
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

/** Camelot code computed from tonic + mode (wheel semantics). */
export function camelotFor(tonic: number, mode: "major" | "minor"): string {
  // Circle of fifths position: C major = 8B. Each +7 semitones moves
  // one number up the wheel; the relative minor shares the number.
  const fifthSteps = (((tonic * 7) % 12) + 12) % 12;
  if (mode === "major") {
    const number = ((8 - 1 + fifthSteps) % 12) + 1;
    return `${number}B`;
  }
  // Minor tonic sits a minor third below its relative major, whose
  // fifth-steps are (tonic+3)*7; the number is the relative's.
  const relFifthSteps = ((((tonic + 3) * 7) % 12) + 12) % 12;
  const number = ((8 - 1 + relFifthSteps) % 12) + 1;
  return `${number}A`;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    num += (a[i] - meanA) * (b[i] - meanB);
    denA += (a[i] - meanA) * (a[i] - meanA);
    denB += (b[i] - meanB) * (b[i] - meanB);
  }
  if (denA <= 0 || denB <= 0) return 0;
  return num / Math.sqrt(denA * denB);
}

function measureKey(
  samples: Float32Array,
  sampleRate: number,
  depth: AnalysisDepth,
): TrackReadKey | null {
  // Window length sets the chroma's frequency resolution. At
  // ~0.37 s (16 384 samples @ 44.1 kHz) a bin is 2.69 Hz wide: a
  // semitone down at ~78 Hz spans only ~1.7 bins, so a Hann main
  // lobe (±2 bins) is wider than a pitch class and a low tonic's
  // energy smears into its semitone neighbours before the key
  // profiles ever see it — the lowest-pitched keys are hit worst
  // (an Eb stack, bass root ~78 Hz and pad root ~156 Hz, bled
  // into D / E / A and read as anything but Eb). A ~0.74 s window
  // halves the bin width to ~1.35 Hz: a semitone is ≥2 bins even
  // at the 50 Hz floor and ~3.4 bins at 78 Hz, so a tone's main
  // lobe stays inside its own pitch class at any tonic. Buffers
  // shorter than the full window use the largest power-of-two
  // window that fits, rather than reporting no key at all.
  const desiredFftSize = largestPow2AtMost(
    Math.max(1024, Math.round(sampleRate * 0.74)),
  );
  const fftSize = Math.min(desiredFftSize, largestPow2AtMost(samples.length));
  if (fftSize < 1024) return null;
  const maxStart = samples.length - fftSize;
  // Deep: up to 48 windows spread over the whole track. Fast: up to
  // 16 windows over the opening ~30 s only.
  const windowCount = depth === "deep" ? 48 : 16;
  const spanEnd =
    depth === "deep"
      ? maxStart
      : Math.min(maxStart, Math.round(sampleRate * 30));
  const chroma = new Float64Array(12);
  let windowsUsed = 0;
  for (let w = 0; w < windowCount; w += 1) {
    const start =
      spanEnd <= 0
        ? 0
        : Math.floor((w * spanEnd) / Math.max(1, windowCount - 1));
    const power = powerSpectrum(samples, start, fftSize);
    let windowTotal = 0;
    const windowChroma = new Float64Array(12);
    for (let k = 1; k < power.length; k += 1) {
      const freq = (k * sampleRate) / fftSize;
      if (freq < 50 || freq > 4200) continue;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const nearest = Math.round(midi);
      if (Math.abs(midi - nearest) > 0.5) continue;
      const pc = ((nearest % 12) + 12) % 12;
      windowChroma[pc] += power[k];
      windowTotal += power[k];
    }
    if (windowTotal <= 0) continue;
    for (let pc = 0; pc < 12; pc += 1) {
      chroma[pc] += windowChroma[pc] / windowTotal;
    }
    windowsUsed += 1;
  }
  if (windowsUsed === 0) return null;
  const chromaArr = Array.from(chroma, (v) => v / windowsUsed);
  if (chromaArr.every((v) => v === 0)) return null;

  interface Scored {
    tonic: number;
    mode: "major" | "minor";
    corr: number;
  }
  const scored: Scored[] = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const mode of ["major", "minor"] as const) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = Array.from(
        { length: 12 },
        (_, pc) => profile[(((pc - tonic) % 12) + 12) % 12],
      );
      scored.push({ tonic, mode, corr: pearson(chromaArr, rotated) });
    }
  }
  scored.sort((a, z) => z.corr - a.corr);
  const best = scored[0];
  const second = scored[1];
  if (!best || best.corr <= 0) return null;
  const margin = best.corr - (second ? second.corr : 0);
  const confidence = clamp01(best.corr * 0.75 + margin * 0.85);
  return {
    tonic: best.tonic,
    mode: best.mode,
    camelot: camelotFor(best.tonic, best.mode),
    confidence,
  };
}

// ---------------------------------------------------------------------
// Vocals (vocal-band energy share)
// ---------------------------------------------------------------------

/**
 * Vocal heuristic table (honest heuristic, labelled):
 * Per window, FFT energy share in ≈300 Hz–3.4 kHz vs 50 Hz–Nyquist:
 *   share ≤ 0.30 → activity 0 (band nearly empty of the window's
 *     energy — e.g. sub-heavy or broadband-flat content sits here);
 *   share ≥ 0.70 → activity 1 (the window's energy lives in the
 *     vocal band — sustained pitched midrange, voice-like);
 *   linear between. Broadband transients (clicks/hats spread flat
 *   across the spectrum) land near share ≈ 0.28 at 22.05 kHz, i.e.
 *   activity ≈ 0 — percussive is not vocal under this measure, and
 *   sustained midrange instruments WILL read as vocal-ish: that is
 *   the known limit of a band-share heuristic, stated plainly.
 * Confidence = energyFactor × (0.35 + 0.65 × decisiveness), where
 * energyFactor scales with the window's RMS against the track's,
 * and decisiveness is the share's distance from the 0.5 midpoint.
 */
function measureVocals(
  samples: Float32Array,
  sampleRate: number,
  durationMs: number,
  loudnessRms: number,
  depth: AnalysisDepth,
): TrackReadVocalWindow[] {
  const windowMs = 1000;
  const stepMs = depth === "deep" ? 1000 : 2000;
  const windows: TrackReadVocalWindow[] = [];
  const nyquist = sampleRate / 2;
  const bandHi = Math.min(3400, nyquist);
  for (let startMs = 0; startMs < durationMs; startMs += stepMs) {
    const startSample = Math.floor((startMs / 1000) * sampleRate);
    const endSample = Math.min(
      samples.length,
      Math.floor(((startMs + windowMs) / 1000) * sampleRate),
    );
    const segment = endSample - startSample;
    if (segment < Math.round(sampleRate * 0.25)) continue;
    let sum = 0;
    for (let i = startSample; i < endSample; i += 1) {
      sum += samples[i] * samples[i];
    }
    const windowRms = Math.sqrt(sum / segment);
    const fftSize = clamp(largestPow2AtMost(segment), 1024, 8192);
    const power = powerSpectrum(samples, startSample, fftSize);
    let bandEnergy = 0;
    let totalEnergy = 0;
    for (let k = 1; k < power.length; k += 1) {
      const freq = (k * sampleRate) / fftSize;
      if (freq < 50) continue;
      totalEnergy += power[k];
      if (freq >= 300 && freq <= bandHi) bandEnergy += power[k];
    }
    const share = totalEnergy > 0 ? bandEnergy / totalEnergy : 0;
    const activity = clamp01((share - 0.3) / 0.4);
    const decisiveness = clamp01(Math.abs(share - 0.5) / 0.35);
    const energyFactor = clamp01(windowRms / Math.max(0.12, loudnessRms * 1.2));
    const confidence = energyFactor * (0.35 + 0.65 * decisiveness);
    windows.push({
      startMs,
      endMs: Math.min(durationMs, startMs + windowMs),
      activity,
      confidence: clamp01(confidence),
    });
  }
  return windows;
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

export interface AnalyseOptions {
  depth: AnalysisDepth;
}

/** Near-silence floor: below this RMS a buffer is unreadable. */
export const SILENCE_RMS_FLOOR = 1e-4;

/**
 * Analyse mono samples into a TrackRead. Returns null only when
 * the audio is unreadable: degenerate input (no samples, bad rate)
 * or near-silence (whole-buffer RMS below SILENCE_RMS_FLOOR).
 * Individual passes that cannot measure anything report empty /
 * zero-confidence fields rather than failing the whole read.
 */
export function analyseSamples(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalyseOptions,
): TrackRead | null {
  if (
    !samples ||
    samples.length < 256 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return null;
  }
  let finite = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (Number.isFinite(samples[i])) finite += 1;
  }
  if (finite < samples.length * 0.9) return null;

  const energy = measureEnergy(samples, sampleRate);
  if (energy.loudnessRms < SILENCE_RMS_FLOOR) return null;

  const durationSec = samples.length / sampleRate;
  const durationMs = Math.round(durationSec * 1000);
  const depth = opts.depth === "fast" ? "fast" : "deep";

  const tempo = measureTempo(samples, sampleRate, durationMs);
  const drops = detectDrops(energy.contour, energy.contourBinMs);
  const sections = classifySections(
    energy.contour,
    energy.contourBinMs,
    durationMs,
    drops,
  );
  const key = measureKey(samples, sampleRate, depth);
  const vocalActivity = measureVocals(
    samples,
    sampleRate,
    durationMs,
    energy.loudnessRms,
    depth,
  );

  return {
    audioHash: audioFingerprint(samples, sampleRate),
    analysisVersion: ANALYSIS_VERSION,
    depth,
    durationSec,
    bpm: Math.round(tempo.bpm * 10) / 10,
    tempoConfidence: tempo.tempoConfidence,
    grid: {
      beatsMs: tempo.beatsMs,
      downbeatsMs: tempo.downbeatsMs,
      beatsPerBar: tempo.beatsPerBar,
      confidence: tempo.gridConfidence,
    },
    key,
    sections,
    energyCurvePerSec: energy.perSec,
    energyContour: energy.contour,
    vocalActivity,
    drops,
    loudnessRms: energy.loudnessRms,
  };
}
