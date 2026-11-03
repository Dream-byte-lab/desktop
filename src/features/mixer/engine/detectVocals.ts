// Vocal detection: where in a track someone is singing — and how sure
// the measurement is.
//
// The referee's hardest rule is "never overlap two vocals" — two
// voices singing over each other is the one blend mistake every
// listener hears. The planner can only honour it if the analyser
// marks where the vocals are, which is this module's one job.
//
// Method (unchanged from version one — the two tests were never the
// problem): the track is scanned in short windows, and each window is
// measured on two axes:
//
// - how *voiced* it is — strongly periodic at a pitch a voice can
//   make (75–400 Hz), measured by autocorrelation. Noise, drums and
//   cymbals fail this; a sung note passes it;
// - where its energy lives — what share of its spectral energy falls
//   in the 200 Hz – 3.4 kHz band where voices live. Bass and kicks
//   fail this however periodic they are.
//
// What version 2 changes is the VERDICT. V1 thresholded both margins
// into a binary vocal/not-vocal range map. That threw the margins
// away — and the margins were the information. A lead instrument that
// sings (electric guitar line, synth lead) passes both tests partway:
// under v1 it became a full "vocal" and forbade blends outright,
// funnelling pair after pair into echo-out (the Note 4 investigation
// proved this was one of the formula's engines). V2 keeps the margins:
//
// - `activity` (0..1) says how vocal the window measures, combining
//   how far each margin clears its threshold — a clear sung note is
//   near 1, a sung-like synth lead lands mid-scale, noise and kicks
//   sit at 0;
// - `confidence` (0..1) says how decisive the evidence was — margins
//   far from their thresholds and a window with real energy in it
//   are confident; a window whose margins straddle the thresholds is
//   reported as the guess it is.
//
// Ranges are still derivable at any threshold (the referee's
// successor integrates the graded curve instead of obeying a binary
// map), and the v1 range API below is preserved on top of the curve
// so existing consumers keep their exact semantics.

export interface VocalRange {
  startSec: number;
  endSec: number;
}

export interface VocalActivityPoint {
  /** Window start, in track seconds. */
  timeSec: number;
  /** 0..1 — how vocal this window measures (see header). */
  activity: number;
  /** 0..1 — how decisive the evidence behind `activity` was. */
  confidence: number;
}

export interface VocalActivityCurve {
  /** Length of each measurement window, in seconds. */
  windowSec: number;
  /** Distance between successive window starts, in seconds. */
  stepSec: number;
  points: VocalActivityPoint[];
}

const WINDOW_SEC = 0.25;
// From just above the kick/bass fundamental zone up to the top of the
// voice's formant range. A sung note's fundamental (75–300 Hz) and its
// harmonics live in here; a kick's energy sits below it.
const BAND_LOW_HZ = 150;
const BAND_HIGH_HZ = 3400;
const MIN_PITCH_HZ = 75;
const MAX_PITCH_HZ = 400;
const VOICED_THRESHOLD = 0.6;
const BAND_SHARE_THRESHOLD = 0.5;
const MIN_RANGE_SEC = 1;

// The margin ramps: how far a raw margin must travel past (or fail
// to reach) its v1 threshold before the graded score saturates. A
// margin sitting exactly ON its threshold scores 0.5 of its ramp —
// the honest middle.
const VOICED_RAMP_LOW = 0.35;
const VOICED_RAMP_HIGH = 0.75;
const BAND_RAMP_LOW = 0.3;
const BAND_RAMP_HIGH = 0.7;
/** Below this band share the window cannot be vocal at all (its band score is 0). */
const BAND_FLOOR = 0.3;
/** Window RMS at which the energy factor saturates — quieter windows are guesses. */
const CONFIDENT_ENERGY = 0.03;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function ramp(value: number, low: number, high: number): number {
  return clamp01((value - low) / (high - low));
}

/** Frequencies sampled for the band test: log-spaced inside and outside the vocal band. */
function probeFrequencies(): { freq: number; inBand: boolean }[] {
  const probes: { freq: number; inBand: boolean }[] = [];
  const logSpaced = (
    low: number,
    high: number,
    count: number,
    inBand: boolean,
  ) => {
    for (let i = 0; i < count; i += 1) {
      probes.push({
        freq: low * Math.pow(high / low, i / (count - 1)),
        inBand,
      });
    }
  };
  logSpaced(55, 140, 5, false);
  logSpaced(BAND_LOW_HZ, BAND_HIGH_HZ, 14, true);
  logSpaced(3500, 9000, 5, false);
  return probes;
}

function goertzelMagnitude(
  samples: Float32Array,
  start: number,
  length: number,
  coeff: number,
): number {
  let s1 = 0;
  let s2 = 0;
  const end = Math.min(samples.length, start + length);
  for (let i = start; i < end; i += 1) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
}

/** Strongest normalised autocorrelation in the vocal pitch range. */
function voicedness(
  samples: Float32Array,
  start: number,
  length: number,
  sampleRate: number,
): number {
  const end = Math.min(samples.length, start + length);
  const n = end - start;
  if (n < 512) return 0;
  let energy = 0;
  for (let i = start; i < end; i += 1) energy += samples[i] * samples[i];
  if (energy === 0) return 0;

  const minLag = Math.floor(sampleRate / MAX_PITCH_HZ);
  const maxLag = Math.min(
    Math.ceil(sampleRate / MIN_PITCH_HZ),
    Math.floor(n / 2),
  );
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = start; i + lag < end; i += 1) {
      sum += samples[i] * samples[i + lag];
    }
    const normalised = sum / energy;
    if (normalised > best) best = normalised;
  }
  return best;
}

export interface VocalActivityOptions {
  /**
   * Distance between successive window starts, in seconds. Defaults
   * to the window length (every window measured). A larger step
   * measures alternate windows — the analysis fast pass's saving —
   * and the curve's points simply land further apart.
   */
  stepSec?: number;
}

/**
 * Measures the graded vocal-activity curve of a track. Same two tests
 * as v1, margins kept: see the module header for exactly what the
 * activity and confidence numbers mean.
 */
export function detectVocalActivity(
  samples: Float32Array,
  sampleRate: number,
  options: VocalActivityOptions = {},
): VocalActivityCurve {
  const windowSize = Math.floor(WINDOW_SEC * sampleRate);
  const stepSec = options.stepSec ?? WINDOW_SEC;
  const stepSize = Math.max(1, Math.floor(stepSec * sampleRate));
  const curve: VocalActivityCurve = {
    windowSec: WINDOW_SEC,
    stepSec,
    points: [],
  };
  if (samples.length < windowSize * 2) return curve;
  const probes = probeFrequencies().map((p) => ({
    ...p,
    coeff: 2 * Math.cos((2 * Math.PI * p.freq) / sampleRate),
  }));

  const raw: VocalActivityPoint[] = [];
  for (let start = 0; start + windowSize <= samples.length; start += stepSize) {
    let inBandEnergy = 0;
    let totalEnergy = 0;
    for (const probe of probes) {
      const magnitude = goertzelMagnitude(
        samples,
        start,
        windowSize,
        probe.coeff,
      );
      const energy = magnitude * magnitude;
      totalEnergy += energy;
      if (probe.inBand) inBandEnergy += energy;
    }
    if (totalEnergy === 0) {
      raw.push({ timeSec: start / sampleRate, activity: 0, confidence: 0 });
      continue;
    }
    const bandShare = inBandEnergy / totalEnergy;

    let sumSquares = 0;
    for (let i = start; i < start + windowSize; i += 1) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / windowSize);
    const energyFactor = clamp01(rms / CONFIDENT_ENERGY);

    const bandScore = ramp(bandShare, BAND_RAMP_LOW, BAND_RAMP_HIGH);
    const bandDecisiveness = clamp01(
      Math.abs(bandShare - BAND_SHARE_THRESHOLD) / 0.3,
    );

    let activity: number;
    let confidence: number;
    if (bandShare <= BAND_FLOOR) {
      // The band margin alone pins this window at "not vocal": the
      // band score is 0, so the combined activity is 0 whatever the
      // voicedness would say — it is not measured, and the band
      // margin's decisiveness carries the confidence on its own.
      activity = 0;
      confidence = energyFactor * (0.35 + 0.65 * bandDecisiveness);
    } else {
      const voice = voicedness(samples, start, windowSize, sampleRate);
      const voiceScore = ramp(voice, VOICED_RAMP_LOW, VOICED_RAMP_HIGH);
      const voiceDecisiveness = clamp01(
        Math.abs(voice - VOICED_THRESHOLD) / 0.3,
      );
      // Geometric mean: BOTH margins must be present for a window to
      // measure as vocal, and a partway margin yields a partway score
      // — that is the whole point of keeping them.
      activity = Math.sqrt(voiceScore * bandScore);
      confidence =
        energyFactor *
        (0.35 + 0.65 * Math.min(voiceDecisiveness, bandDecisiveness));
    }
    raw.push({ timeSec: start / sampleRate, activity, confidence });
  }

  // A three-point smoothing on activity only: a single window's flicker
  // is measurement noise, not a singer starting and stopping. Confidence
  // stays as measured per window.
  for (let i = 0; i < raw.length; i += 1) {
    const prev = raw[Math.max(0, i - 1)].activity;
    const next = raw[Math.min(raw.length - 1, i + 1)].activity;
    curve.points.push({
      timeSec: raw[i].timeSec,
      activity: (prev + raw[i].activity + next) / 3,
      confidence: raw[i].confidence,
    });
  }
  return curve;
}

/**
 * Derives vocal ranges from an activity curve at a threshold — the
 * v1 question ("where is someone singing?") answered from the graded
 * measurement. A run of windows at or above the threshold becomes a
 * range; runs shorter than a second are dropped, as in v1.
 */
export function vocalRangesFromActivity(
  curve: VocalActivityCurve,
  threshold = 0.5,
  minRangeSec = MIN_RANGE_SEC,
): VocalRange[] {
  const ranges: VocalRange[] = [];
  let runStart = -1;
  const points = curve.points;
  for (let i = 0; i <= points.length; i += 1) {
    const active = i < points.length && points[i].activity >= threshold;
    if (active && runStart < 0) runStart = i;
    if (!active && runStart >= 0) {
      const startSec = points[runStart].timeSec;
      const endSec = points[i - 1].timeSec + curve.windowSec;
      if (endSec - startSec >= minRangeSec) {
        ranges.push({ startSec, endSec });
      }
      runStart = -1;
    }
  }
  return ranges;
}

/** Mean graded vocal activity across a time span (0 when nothing was measured there). */
export function meanVocalActivity(
  curve: VocalActivityCurve,
  startSec: number,
  endSec: number,
): number {
  let sum = 0;
  let count = 0;
  for (const point of curve.points) {
    if (point.timeSec >= startSec && point.timeSec < endSec) {
      sum += point.activity;
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * The v1 range API, preserved: ranges are the activity curve read at
 * the threshold the referee always used.
 */
export function detectVocalRanges(
  samples: Float32Array,
  sampleRate: number,
): VocalRange[] {
  return vocalRangesFromActivity(detectVocalActivity(samples, sampleRate));
}

/** True when the given time span touches any vocal range. */
export function overlapsVocals(
  ranges: VocalRange[],
  startSec: number,
  endSec: number,
): boolean {
  return ranges.some((r) => r.startSec < endSec && r.endSec > startSec);
}
