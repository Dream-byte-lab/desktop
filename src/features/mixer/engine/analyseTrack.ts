import type { BeatMap } from "./beatMap";
import { detectKey, type KeyEstimate } from "./detectKey";
import { detectVocalRanges, type VocalRange } from "./detectVocals";

// The analyser: listens to a track's raw audio and writes down what the
// mixer needs to know — its tempo, where the first downbeat falls, how its
// energy moves, and where its drops are. Version one is deliberately
// simple and honest about it:
//
// - tempo comes from the repeating pattern of onsets (the moments sound
//   starts — kicks, hats, hits), found by autocorrelation;
// - the beat grid is aligned to those onsets, and the downbeat is chosen
//   by which beat of each bar carries the strongest onsets;
// - drops are phrase boundaries where the energy jumps from quiet to loud.
//
// It works on plain samples rather than an AudioBuffer so it can be
// tested on synthetic songs whose true tempo and drop are known exactly.
// Real-world accuracy (rubato, weak drums, tempo drift) is future work;
// what matters here is a correct, testable foundation.

export interface DropCandidate {
  /** Track time where the drop lands. */
  timeSec: number;
  /** Beat index of the drop, counted from the first downbeat. */
  beat: number;
  /** How hard the energy jumps: after-level divided by before-level. */
  strength: number;
}

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
}

export interface AnalyseOptions {
  /** Tempo search range. Defaults to 70–180 bpm. */
  minBpm?: number;
  maxBpm?: number;
  beatsPerBar?: number;
}

const FRAME_SIZE = 1024;
const HOP_SIZE = 512;

/** Per-frame loudness, then the onset envelope: how much each frame is louder than the one before. */
function onsetEnvelope(samples: Float32Array): Float32Array {
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
  const onsets = new Float32Array(frameCount);
  for (let f = 1; f < frameCount; f += 1) {
    onsets[f] = Math.max(0, energy[f] - energy[f - 1]);
  }
  return onsets;
}

function frameEnergyAt(samples: Float32Array, frameIndex: number): number {
  const start = Math.max(
    0,
    Math.min(samples.length - 1, frameIndex * HOP_SIZE),
  );
  let sum = 0;
  let count = 0;
  for (let i = 0; i < FRAME_SIZE && start + i < samples.length; i += 1) {
    const v = samples[start + i];
    sum += v * v;
    count += 1;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
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

export function analyseTrack(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyseOptions = {},
): TrackAnalysis | null {
  const minBpm = options.minBpm ?? 70;
  const maxBpm = options.maxBpm ?? 180;
  const beatsPerBar = options.beatsPerBar ?? 4;
  const durationSec = samples.length / sampleRate;
  const framesPerSecond = sampleRate / HOP_SIZE;

  const onsets = onsetEnvelope(samples);
  if (onsets.length === 0) return null;

  const tempo = estimateTempo(onsets, framesPerSecond, minBpm, maxBpm);
  if (!tempo) return null;

  const spb = 60 / tempo.bpm;
  const phaseFrames = estimatePhase(onsets, tempo.periodFrames);
  const gridStartSec = (phaseFrames * HOP_SIZE) / sampleRate;

  // Beat strengths along the grid, then the downbeat rotation: the beat
  // position within the bar whose onsets are strongest on average.
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

  const beatMap: BeatMap = {
    bpm: tempo.bpm,
    firstBeatSec,
    beatsPerBar,
    durationSec,
  };

  // Energy curve: one loudness reading per second, normalised.
  const energyCurve: { timeSec: number; energy: number }[] = [];
  let peak = 0;
  const rawCurve: number[] = [];
  for (let s = 0; s < Math.floor(durationSec); s += 1) {
    const frame = Math.round((s * sampleRate) / HOP_SIZE);
    const e = frameEnergyAt(samples, frame);
    rawCurve.push(e);
    if (e > peak) peak = e;
  }
  for (let s = 0; s < rawCurve.length; s += 1) {
    energyCurve.push({
      timeSec: s,
      energy: peak > 0 ? rawCurve[s] / peak : 0,
    });
  }

  // Drops: at each phrase boundary (16 beats), compare the loudness of
  // the 8 beats before with the 4 beats after. A drop is a boundary that
  // was relatively quiet and then jumps hard.
  const drops: DropCandidate[] = [];
  const phraseLen = beatsPerBar * 4;
  const beatEnergy = (beat: number): number => {
    const t = firstBeatSec + beat * spb;
    const entry = energyCurve[Math.round(t)];
    return entry ? entry.energy : 0;
  };
  for (let b = phraseLen; b + 4 < totalBeats; b += phraseLen) {
    let before = 0;
    for (let k = b - 8; k < b; k += 1) before += beatEnergy(k);
    before /= 8;
    let after = 0;
    for (let k = b; k < b + 4; k += 1) after += beatEnergy(k);
    after /= 4;
    if (before > 0.02 && before < 0.5 && after / before > 1.8) {
      drops.push({
        timeSec: firstBeatSec + b * spb,
        beat: b,
        strength: after / before,
      });
    }
  }
  drops.sort((a, z) => z.strength - a.strength);

  // The key is read from the opening stretch of the track: keys in
  // dance music are stable, and sampling keeps this pass bounded
  // instead of scanning every second of audio.
  const keySampleCount = Math.min(samples.length, Math.floor(45 * sampleRate));
  const key = detectKey(samples.subarray(0, keySampleCount), sampleRate);

  const vocalRanges = detectVocalRanges(samples, sampleRate);

  return {
    beatMap,
    tempoConfidence: tempo.confidence,
    energyCurve,
    drops,
    key,
    vocalRanges,
  };
}

/** Mixes an AudioBuffer down to mono samples and analyses them. */
export function analyseAudioBuffer(
  buffer: AudioBuffer,
  options: AnalyseOptions = {},
): TrackAnalysis | null {
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
  return analyseTrack(mono, buffer.sampleRate, options);
}
