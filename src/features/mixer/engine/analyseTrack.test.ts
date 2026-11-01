import { describe, expect, it } from "vitest";
import { analyseTrack } from "./analyseTrack";

const SAMPLE_RATE = 44100;

/**
 * Builds a synthetic song: a click on every beat, a louder click on every
 * accented beat, optionally quiet until a moment where it turns loud —
 * a stand-in for a breakdown followed by a drop.
 */
function syntheticSong(options: {
  bpm: number;
  seconds: number;
  firstBeatSec: number;
  accentEvery?: number;
  quietUntilSec?: number;
}): Float32Array {
  const samples = new Float32Array(Math.floor(options.seconds * SAMPLE_RATE));
  const spb = 60 / options.bpm;
  const accentEvery = options.accentEvery ?? 4;
  for (let beat = 0; ; beat += 1) {
    const t = options.firstBeatSec + beat * spb;
    if (t >= options.seconds) break;
    const quiet =
      options.quietUntilSec !== undefined && t < options.quietUntilSec;
    const accented = beat % accentEvery === 0;
    const amp = quiet ? 0.12 : accented ? 0.95 : 0.55;
    const start = Math.floor(t * SAMPLE_RATE);
    for (let n = 0; n < 512 && start + n < samples.length; n += 1) {
      samples[start + n] +=
        amp *
        Math.exp(-n / 60) *
        Math.sin((2 * Math.PI * 180 * n) / SAMPLE_RATE);
    }
  }
  return samples;
}

describe("analyseTrack", () => {
  it("finds the tempo and first downbeat of a 120 bpm click song", () => {
    const samples = syntheticSong({
      bpm: 120,
      seconds: 40,
      firstBeatSec: 0.25,
    });
    const analysis = analyseTrack(samples, SAMPLE_RATE);
    expect(analysis).not.toBeNull();
    expect(analysis!.beatMap.bpm).toBeGreaterThan(118);
    expect(analysis!.beatMap.bpm).toBeLessThan(122);
    expect(analysis!.beatMap.firstBeatSec).toBeGreaterThan(0.17);
    expect(analysis!.beatMap.firstBeatSec).toBeLessThan(0.33);
    expect(analysis!.tempoConfidence).toBeGreaterThan(0);
  });

  it("finds a different tempo", () => {
    const samples = syntheticSong({
      bpm: 126,
      seconds: 30,
      firstBeatSec: 0.1,
    });
    const analysis = analyseTrack(samples, SAMPLE_RATE);
    expect(analysis).not.toBeNull();
    expect(analysis!.beatMap.bpm).toBeGreaterThan(124);
    expect(analysis!.beatMap.bpm).toBeLessThan(128);
  });

  it("spots the drop where a quiet section turns loud on a phrase boundary", () => {
    const samples = syntheticSong({
      bpm: 120,
      seconds: 40,
      firstBeatSec: 0,
      quietUntilSec: 16,
    });
    const analysis = analyseTrack(samples, SAMPLE_RATE);
    expect(analysis).not.toBeNull();
    expect(analysis!.drops.length).toBeGreaterThan(0);
    expect(analysis!.drops[0].beat).toBe(32);
    expect(analysis!.drops[0].timeSec).toBeGreaterThan(15);
    expect(analysis!.drops[0].timeSec).toBeLessThan(17);
  });

  it("returns null for silence", () => {
    const samples = new Float32Array(SAMPLE_RATE * 10);
    expect(analyseTrack(samples, SAMPLE_RATE)).toBeNull();
  });
});
