import { describe, expect, it } from "vitest";
import type { TrackAnalysis } from "./analyseTrack";
import { chooseEntryBeat } from "./entryBeat";

function analysis(partial: Partial<TrackAnalysis>): TrackAnalysis {
  return {
    beatMap: {
      bpm: 120,
      firstBeatSec: 0,
      beatsPerBar: 4,
      durationSec: 240,
    },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    ...partial,
  };
}

describe("chooseEntryBeat", () => {
  it("aims at the earliest usable drop", () => {
    const result = chooseEntryBeat(
      analysis({
        drops: [
          { timeSec: 32, beat: 64, strength: 3 },
          { timeSec: 16, beat: 32, strength: 2.5 },
        ],
      }),
    );
    // drops are stored strongest-first, not earliest-first: beat 64 is
    // stronger, but the cue point is the earliest usable drop
    expect(result).toBe(32);
  });

  it("ignores a drop too close to the start to blend into", () => {
    const result = chooseEntryBeat(
      analysis({
        drops: [{ timeSec: 2, beat: 4, strength: 3 }],
      }),
    );
    expect(result).toBe(32);
  });

  it("falls back to a phrase beat on a long track without drops", () => {
    expect(chooseEntryBeat(analysis({}))).toBe(32);
  });

  it("falls back further on a short track", () => {
    const short = analysis({
      beatMap: {
        bpm: 120,
        firstBeatSec: 0,
        beatsPerBar: 4,
        durationSec: 10,
      },
    });
    expect(chooseEntryBeat(short)).toBe(0);
  });
});
