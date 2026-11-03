import { describe, expect, it } from "vitest";
import { buildBeatGrid } from "./gridTrack";
import { beatsAtTime, timeAtBeat, type BeatMap } from "./beatMap";

// gridTrack is fed the same onset envelope the analyser computes:
// per-frame energy increases at 44 100 / 512 ≈ 86.13 frames a second.
// These tests build envelopes whose true beats are known exactly.

const FPS = 44100 / 512;

/** An onset envelope with a click of the given strength on each true beat. */
function onsetEnvelope(
  beatTimes: number[],
  seconds: number,
  strength = 0.4,
): Float32Array {
  const frames = new Float32Array(Math.floor(seconds * FPS));
  for (const t of beatTimes) {
    const f = Math.round(t * FPS);
    if (f >= 0 && f < frames.length) frames[f] = strength;
  }
  return frames;
}

function constantBeats(bpm: number, seconds: number): number[] {
  const times: number[] = [];
  for (let t = 0; t < seconds; t += 60 / bpm) times.push(t);
  return times;
}

describe("buildBeatGrid", () => {
  it("anchors a constant-tempo track with high confidence", () => {
    const beats = constantBeats(120, 30);
    const grid = buildBeatGrid({
      onsets: onsetEnvelope(beats, 30),
      framesPerSecond: FPS,
      firstBeatSec: 0,
      bpm: 120,
      durationSec: 30,
    });
    expect(grid.confidence).toBeGreaterThan(0.6);
    expect(grid.anchors.length).toBeGreaterThan(50);
    // Anchors land on the true beats.
    for (const anchor of grid.anchors.slice(0, 20)) {
      expect(Math.abs(anchor.timeSec - anchor.beat * 0.5)).toBeLessThan(0.05);
    }
    // And the grid-aware clock agrees with the true beat times.
    const map: BeatMap = {
      bpm: 120,
      firstBeatSec: 0,
      beatsPerBar: 4,
      durationSec: 30,
      grid,
    };
    expect(Math.abs(timeAtBeat(map, 40) - 20)).toBeLessThan(0.05);
    expect(Math.abs(beatsAtTime(map, 20) - 40)).toBeLessThan(0.2);
  });

  it("follows a tempo drift the rigid grid cannot", () => {
    // 120 → 128 bpm linearly over 60 s, integrated beat times.
    const beatTimes: number[] = [];
    let t = 0;
    while (t < 60) {
      beatTimes.push(t);
      t += 60 / (120 + (8 * t) / 60);
    }
    // The caller passes the track's summary tempo — for a linear
    // ramp, autocorrelation reports the average (124), and the walk
    // bends ± around it. (Handed the starting tempo instead, the
    // walk would rightly refuse to chase beats that drift more than
    // half a beat off the leash.)
    const grid = buildBeatGrid({
      onsets: onsetEnvelope(beatTimes, 60),
      framesPerSecond: FPS,
      firstBeatSec: 0,
      bpm: 124,
      durationSec: 60,
    });
    expect(grid.confidence).toBeGreaterThan(0.3);
    const midTrue = beatTimes.reduce((best, bt) =>
      Math.abs(bt - 30) < Math.abs(best - 30) ? bt : best,
    );
    const nearest = Math.min(
      ...grid.anchors.map((a) => Math.abs(a.timeSec - midTrue)),
    );
    expect(nearest).toBeLessThan(0.12);
    const last = grid.sections[grid.sections.length - 1];
    expect(last.bpm).toBeGreaterThan(grid.sections[0].bpm + 2);
  });

  it("says so, with zero confidence, when there is nothing to anchor to", () => {
    const grid = buildBeatGrid({
      onsets: new Float32Array(Math.floor(30 * FPS)),
      framesPerSecond: FPS,
      firstBeatSec: 0,
      bpm: 120,
      durationSec: 30,
    });
    expect(grid.confidence).toBe(0);
    expect(grid.anchors).toEqual([{ beat: 0, timeSec: 0, confidence: 0 }]);
    expect(grid.sections[0].confidence).toBe(0);
  });

  it("never anchors a beat backwards, and off-beats alone cannot capture it", () => {
    // Off-beat clicks halfway between the true beats sit outside
    // every prediction's search window (±0.4 beat) — there is
    // nothing on the beat to anchor, so the grid must stay empty
    // rather than slide onto the off-beats.
    const offBeats: number[] = [];
    for (let t = 0.25; t < 30; t += 0.5) offBeats.push(t);
    const grid = buildBeatGrid({
      onsets: onsetEnvelope(offBeats, 30),
      framesPerSecond: FPS,
      firstBeatSec: 0,
      bpm: 120,
      durationSec: 30,
    });
    for (let i = 1; i < grid.anchors.length; i += 1) {
      expect(grid.anchors[i].timeSec).toBeGreaterThan(
        grid.anchors[i - 1].timeSec,
      );
    }
    for (const anchor of grid.anchors) {
      const rigid = anchor.beat * 0.5;
      expect(Math.abs(anchor.timeSec - rigid)).toBeLessThanOrEqual(0.26);
    }
  });
});
