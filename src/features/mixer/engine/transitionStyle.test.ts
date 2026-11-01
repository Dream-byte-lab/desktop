import { describe, expect, it } from "vitest";
import type { TrackAnalysis } from "./analyseTrack";
import { decideTransition } from "./transitionStyle";

function analysis(partial: Partial<TrackAnalysis>): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 300 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: null,
    vocalRanges: [],
    ...partial,
  };
}

describe("decideTransition", () => {
  it("blends when an honest blend exists", () => {
    const decision = decideTransition({
      outgoing: analysis({}),
      outgoingPositionSec: 10,
      incoming: analysis({}),
    });
    expect(decision.kind).toBe("blend");
  });

  it("drop-cuts into the incoming drop when voices block every blend", () => {
    const decision = decideTransition({
      outgoing: analysis({ vocalRanges: [{ startSec: 0, endSec: 400 }] }),
      outgoingPositionSec: 10,
      incoming: analysis({
        vocalRanges: [{ startSec: 0, endSec: 400 }],
        drops: [{ timeSec: 32, beat: 64, strength: 2.5 }],
      }),
    });
    expect(decision.kind).toBe("drop-cut");
    if (decision.kind === "drop-cut") {
      // Beat 64 at 120 bpm lands at 32s.
      expect(decision.entrySec).toBeCloseTo(32, 6);
    }
  });

  it("plain-cuts when there is no blend and no usable drop", () => {
    const decision = decideTransition({
      outgoing: analysis({ vocalRanges: [{ startSec: 0, endSec: 400 }] }),
      outgoingPositionSec: 10,
      incoming: analysis({ vocalRanges: [{ startSec: 0, endSec: 400 }] }),
    });
    expect(decision.kind).toBe("cut");
  });

  it("ignores a drop that lands too early to be a landing", () => {
    const decision = decideTransition({
      outgoing: analysis({ vocalRanges: [{ startSec: 0, endSec: 400 }] }),
      outgoingPositionSec: 10,
      incoming: analysis({
        vocalRanges: [{ startSec: 0, endSec: 400 }],
        drops: [{ timeSec: 2, beat: 4, strength: 3 }],
      }),
    });
    expect(decision.kind).toBe("cut");
  });
});
