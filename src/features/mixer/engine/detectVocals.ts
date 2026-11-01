// Vocal detection: where in a track someone is singing.
//
// The referee's hardest rule is "never overlap two vocals" — two
// voices singing over each other is the one blend mistake every
// listener hears. The planner can only honour it if the analyser
// marks where the vocals are, which is this module's one job.
//
// Method (version one, deliberately plain): the track is scanned in
// short windows, and a window counts as vocal when BOTH of these hold:
//
// - the sound is *voiced* — strongly periodic at a pitch a voice can
//   make (75–400 Hz), measured by autocorrelation. Noise, drums and
//   cymbals fail this; a sung note passes it;
// - its energy lives where voices live — the majority of its spectral
//   energy falls in the 200 Hz – 3.4 kHz band. Bass and kicks fail
//   this however periodic they are.
//
// Vocal windows are merged into ranges; very short blips are dropped.
//
// Known limits, stated plainly: lead instruments that sing — electric
// guitar lines, synth leads — can pass both tests and be marked as
// vocal. That fails safe for the referee's purpose (the planner just
// avoids blending there), but it is an approximation, not a truth
// machine, and it will be tuned against real songs.

export interface VocalRange {
  startSec: number;
  endSec: number;
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

export function detectVocalRanges(
  samples: Float32Array,
  sampleRate: number,
): VocalRange[] {
  const windowSize = Math.floor(WINDOW_SEC * sampleRate);
  if (samples.length < windowSize * 2) return [];
  const probes = probeFrequencies().map((p) => ({
    ...p,
    coeff: 2 * Math.cos((2 * Math.PI * p.freq) / sampleRate),
  }));

  const windowCount = Math.floor(samples.length / windowSize);
  const vocal = Array.from({ length: windowCount }, () => false);
  for (let w = 0; w < windowCount; w += 1) {
    const start = w * windowSize;
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
    if (totalEnergy === 0) continue;
    const bandShare = inBandEnergy / totalEnergy;
    if (bandShare < BAND_SHARE_THRESHOLD) continue;
    const voice = voicedness(samples, start, windowSize, sampleRate);
    vocal[w] = voice >= VOICED_THRESHOLD;
  }

  const ranges: VocalRange[] = [];
  let runStart = -1;
  for (let w = 0; w <= windowCount; w += 1) {
    const isVocal = w < windowCount ? vocal[w] : false;
    if (isVocal && runStart < 0) runStart = w;
    if (!isVocal && runStart >= 0) {
      const startSec = runStart * WINDOW_SEC;
      const endSec = w * WINDOW_SEC;
      if (endSec - startSec >= MIN_RANGE_SEC) {
        ranges.push({ startSec, endSec });
      }
      runStart = -1;
    }
  }
  return ranges;
}

/** True when the given time span touches any vocal range. */
export function overlapsVocals(
  ranges: VocalRange[],
  startSec: number,
  endSec: number,
): boolean {
  return ranges.some((r) => r.startSec < endSec && r.endSec > startSec);
}
