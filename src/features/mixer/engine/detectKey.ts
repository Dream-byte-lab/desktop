// Key detection: which key a track is in, expressed the way DJs use it.
//
// Harmonic mixing — playing songs whose keys agree — is part of what
// makes a blend sound intentional instead of accidental, so the
// analyser needs a key for every track, and the planner will later use
// it to score whether two tracks can sit together.
//
// Method, kept deliberately plain: build a pitch-class profile (how
// much energy the track spends on each of the twelve notes, summed
// across octaves) by measuring the signal at each semitone frequency,
// then compare that profile against the standard Krumhansl–Schmuckler
// major and minor key profiles for all twelve tonics. The key whose
// profile correlates best is the estimate; the correlation is the
// confidence. The Camelot label (8B, 5A, …) is the DJ-facing name of
// the same key — neighbouring numbers on the Camelot wheel mix well.
//
// Pure tones and silent tracks return null rather than a guess.

export interface KeyEstimate {
  /** Tonic note name, e.g. "C", "F#", "Bb". */
  tonic: string;
  mode: "major" | "minor";
  /** Tonic pitch class: 0 = C, 1 = C#, …, 11 = B. */
  pitchClass: number;
  /** Camelot wheel label, e.g. "8B" for C major, "8A" for A minor. */
  camelot: string;
  /** 0..1 — Pearson correlation of the winning key profile. */
  confidence: number;
}

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
];

// Krumhansl–Schmuckler key profiles, indexed by semitones above tonic.
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

// Camelot labels by tonic pitch class (0 = C … 11 = B).
const CAMELOT_MAJOR = [
  "8B",
  "3B",
  "10B",
  "5B",
  "12B",
  "7B",
  "2B",
  "9B",
  "4B",
  "11B",
  "6B",
  "1B",
];
const CAMELOT_MINOR = [
  "5A",
  "12A",
  "7A",
  "2A",
  "9A",
  "4A",
  "11A",
  "6A",
  "1A",
  "8A",
  "3A",
  "10A",
];

const LOWEST_MIDI = 48; // C3 — lower notes are too close together to separate reliably
const HIGHEST_MIDI = 83; // B5
const WINDOW = 8192;
// Non-overlapping windows: a track's key does not change window to
// window, and halving the frames halves the cost of this pass.
const HOP = 8192;

function midiFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Goertzel magnitude of one frequency in one windowed frame. */
function goertzel(
  samples: Float32Array,
  start: number,
  length: number,
  coeff: number,
): number {
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i += 1) {
    const idx = start + i;
    if (idx >= samples.length) break;
    // Hann window, applied inline.
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    const s0 = samples[idx] * w + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
}

function pitchClassProfile(
  samples: Float32Array,
  sampleRate: number,
): Float64Array | null {
  const chroma = new Float64Array(12);
  const coeffs: number[] = [];
  for (let midi = LOWEST_MIDI; midi <= HIGHEST_MIDI; midi += 1) {
    coeffs.push(2 * Math.cos((2 * Math.PI * midiFrequency(midi)) / sampleRate));
  }
  let total = 0;
  for (let start = 0; start + WINDOW <= samples.length; start += HOP) {
    for (let n = 0; n < coeffs.length; n += 1) {
      const magnitude = goertzel(samples, start, WINDOW, coeffs[n]);
      const pitchClass = (LOWEST_MIDI + n) % 12;
      chroma[pitchClass] += magnitude;
      total += magnitude;
    }
  }
  if (total === 0) return null;
  for (let pc = 0; pc < 12; pc += 1) chroma[pc] /= total;
  return chroma;
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

export function detectKey(
  samples: Float32Array,
  sampleRate: number,
): KeyEstimate | null {
  const chroma = pitchClassProfile(samples, sampleRate);
  if (!chroma) return null;

  let best: KeyEstimate | null = null;
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const mode of ["major", "minor"] as const) {
      const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = new Float64Array(12);
      for (let pc = 0; pc < 12; pc += 1) {
        rotated[pc] = profile[(pc - tonic + 12) % 12];
      }
      const confidence = pearson(chroma, rotated);
      if (!best || confidence > best.confidence) {
        best = {
          tonic: NOTE_NAMES[tonic],
          mode,
          pitchClass: tonic,
          camelot:
            mode === "major" ? CAMELOT_MAJOR[tonic] : CAMELOT_MINOR[tonic],
          confidence,
        };
      }
    }
  }
  if (!best || best.confidence <= 0) return null;
  return best;
}
