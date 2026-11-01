import { describe, expect, it } from "vitest";
import { detectVocalRanges, overlapsVocals } from "./detectVocals";

const SAMPLE_RATE = 44100;

/** Quiet broadband noise, like a room tone / soft backing. */
function noiseSamples(seconds: number, seed = 7): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  let state = seed;
  for (let i = 0; i < out.length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out[i] = ((state / 2147483648) * 2 - 1) * 0.04;
  }
  return out;
}

/** Adds a voice-like sung note: a pitch with harmonics and a gentle vibrato. */
function addVoice(
  samples: Float32Array,
  fromSec: number,
  toSec: number,
  basePitch: number,
): void {
  const from = Math.floor(fromSec * SAMPLE_RATE);
  const to = Math.min(samples.length, Math.floor(toSec * SAMPLE_RATE));
  // Harmonic strengths shaped like a sung vowel: the formant region
  // (roughly the 3rd–5th harmonics) carries more than the fundamental.
  const amps = [0.7, 0.55, 0.85, 1, 0.7, 0.4];
  // The vibrato must be integrated into the phase — multiplying a
  // varying pitch by t directly would smear the note into a chirp
  // that no steady-pitch test could ever hear as voiced.
  let phase = 0;
  for (let i = from; i < to; i += 1) {
    const t = (i - from) / SAMPLE_RATE;
    const pitch = basePitch * (1 + 0.006 * Math.sin(2 * Math.PI * 5 * t));
    phase += (2 * Math.PI * pitch) / SAMPLE_RATE;
    let v = 0;
    for (let h = 0; h < amps.length; h += 1) {
      v += amps[h] * Math.sin(phase * (h + 1));
    }
    samples[i] += v * 0.22;
  }
}

/** Adds a soft kick-like thump: a low decaying sine burst, repeated. */
function addKick(samples: Float32Array, everySec: number): void {
  const period = Math.floor(everySec * SAMPLE_RATE);
  const burst = Math.floor(0.12 * SAMPLE_RATE);
  for (let start = 0; start + burst < samples.length; start += period) {
    for (let i = 0; i < burst; i += 1) {
      const t = i / SAMPLE_RATE;
      samples[start + i] +=
        Math.sin(2 * Math.PI * 58 * t) * Math.exp(-t * 22) * 0.7;
    }
  }
}

describe("detectVocalRanges", () => {
  it("finds the sung section and only the sung section", () => {
    const samples = noiseSamples(12);
    addVoice(samples, 4, 8, 185);
    const ranges = detectVocalRanges(samples, SAMPLE_RATE);
    expect(ranges.length).toBe(1);
    expect(ranges[0].startSec).toBeGreaterThanOrEqual(3.25);
    expect(ranges[0].startSec).toBeLessThanOrEqual(4.75);
    expect(ranges[0].endSec).toBeGreaterThanOrEqual(7.25);
    expect(ranges[0].endSec).toBeLessThanOrEqual(8.75);
  });

  it("finds a low male-range voice too", () => {
    const samples = noiseSamples(10, 31);
    addVoice(samples, 3, 7, 130);
    const ranges = detectVocalRanges(samples, SAMPLE_RATE);
    expect(ranges.length).toBe(1);
    expect(ranges[0].startSec).toBeGreaterThanOrEqual(2.25);
    expect(ranges[0].startSec).toBeLessThanOrEqual(3.75);
    expect(ranges[0].endSec).toBeGreaterThanOrEqual(6.25);
    expect(ranges[0].endSec).toBeLessThanOrEqual(7.75);
  });

  it("does not mistake a kick pattern for singing", () => {
    const samples = noiseSamples(8, 13);
    addKick(samples, 0.5);
    expect(detectVocalRanges(samples, SAMPLE_RATE)).toEqual([]);
  });

  it("returns nothing for noise alone or for very short clips", () => {
    expect(detectVocalRanges(noiseSamples(6, 21), SAMPLE_RATE)).toEqual([]);
    expect(detectVocalRanges(noiseSamples(0.3), SAMPLE_RATE)).toEqual([]);
  });
});

describe("overlapsVocals", () => {
  const ranges = [{ startSec: 10, endSec: 20 }];

  it("detects spans that touch a vocal range", () => {
    expect(overlapsVocals(ranges, 15, 16)).toBe(true);
    expect(overlapsVocals(ranges, 8, 11)).toBe(true);
    expect(overlapsVocals(ranges, 19, 25)).toBe(true);
  });

  it("passes spans that stay clear", () => {
    expect(overlapsVocals(ranges, 0, 10)).toBe(false);
    expect(overlapsVocals(ranges, 20, 30)).toBe(false);
    expect(overlapsVocals([], 0, 100)).toBe(false);
  });
});
