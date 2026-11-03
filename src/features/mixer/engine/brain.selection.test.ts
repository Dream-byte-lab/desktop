// Brain × selection (R5): the decision loop spends the §16/§15
// lottery, and its session coordinates make the night replayable.
//
// brain.test.ts (S5-4) is untouched; this suite pins what R5 adds:
//   · the decision carries its selection record (temperature,
//     seed coordinate, band probabilities, scorer agreement);
//   · the performed candidate is always a member of the scored
//     near-equal band — variety never leaves the suitable set;
//   · a fresh brain replaying the same calls reproduces the same
//     pick sequence exactly; a new set (or a new session seed)
//     changes the seed coordinate;
//   · scoring's deterministic pick remains the reference — when
//     the lottery agrees with it, the record says so.
//
// Fixtures follow brain.test.ts: 120 BPM, 240 s tracks, a friendly
// vocal pair with full structure.

import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import { DjBrain } from "./brain";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import {
  createJoinHistory,
  type JoinLogStorage,
  type JoinRecord,
} from "./joinHistory";
import type { PreparedTrack } from "./trackSource";

const T0 = 1_000_000;

function key(camelot: string, pitchClass: number): KeyEstimate {
  return { tonic: "C", mode: "major", pitchClass, camelot, confidence: 0.9 };
}

function vocalCurve(
  durationSec: number,
  activityAt: (t: number) => number,
  confidence = 1,
): VocalActivityCurve {
  const points = [];
  for (let t = 0; t < durationSec; t += 0.25) {
    points.push({ timeSec: t, activity: activityAt(t), confidence });
  }
  return { windowSec: 0.25, stepSec: 0.25, points };
}

function section(
  kind: TrackSection["kind"],
  startSec: number,
  endSec: number,
  meanRms: number,
  vocalActivity: number,
): TrackSection {
  return {
    kind,
    startSec,
    endSec,
    startBeat: startSec * 2,
    endBeat: endSec * 2,
    meanRms,
    vocalActivity,
    confidence: 0.9,
  };
}

function outgoingAnalysis(): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: "hash-a",
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("verse", 16, 64, 0.3, 0.85),
      section("chorus", 64, 112, 0.5, 0.9),
      section("verse", 112, 200, 0.3, 0.85),
      section("outro", 200, 240, 0.1, 0),
    ],
    outro: { startSec: 200, endSec: 240, startBeat: 400, endBeat: 480 },
    vocalActivity: vocalCurve(240, (t) => (t < 16 ? 0 : t < 200 ? 0.9 : 0)),
  };
}

function incomingAnalysis(): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [{ timeSec: 32, beat: 64, strength: 2.4 }],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: "hash-b",
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("chorus", 16, 64, 0.5, 0.9),
      section("verse", 64, 160, 0.3, 0.85),
      section("chorus", 160, 240, 0.5, 0.9),
    ],
    intro: { startSec: 0, endSec: 16, startBeat: 0, endBeat: 32 },
    vocalActivity: vocalCurve(240, (t) => (t < 16 ? 0 : 0.9)),
  };
}

function prepared(id: string, analysis: TrackAnalysis): PreparedTrack {
  return {
    track: {
      id,
      title: id,
      artists: "Test Artist",
      durationMs: 240_000,
    } as Track,
    buffer: { duration: 240 } as AudioBuffer,
    analysis,
  };
}

function fakeStorage(): JoinLogStorage {
  return {
    read: async () => null,
    write: async (_joins: readonly JoinRecord[]) => {},
  };
}

function makeBrain(sessionSeed?: string): DjBrain {
  return new DjBrain({
    history: createJoinHistory(fakeStorage()),
    now: () => T0,
    ...(sessionSeed !== undefined ? { sessionSeed } : {}),
  });
}

const PAIR = () => ({
  outgoing: prepared("a", outgoingAnalysis()),
  outgoingPositionSec: 60,
  incoming: prepared("b", incomingAnalysis()),
});

describe("the selection record on the decision", () => {
  it("carries the §16/§15 spend: temperature, seed, band probabilities", async () => {
    const brain = makeBrain();
    await brain.beginSet();
    const decision = brain.consider(PAIR(), 0.3)!;
    const selection = decision.selection;
    expect(selection.method).toBe("softmax");
    expect(selection.temperature).toBe(0.05); // STANDARD's band
    expect(selection.sensitivity).toBe(0.1); // STANDARD's familyRepeatCost
    expect(selection.seed).toBe("linerave#1#1");
    expect(selection.band.length).toBeGreaterThan(0);
    const total = selection.band.reduce((s, b) => s + b.probability, 0);
    expect(total).toBeCloseTo(1, 12);
    // The performed candidate is the record's chosen band member…
    const chosen = selection.band[selection.chosenIndex];
    expect(chosen.family).toBe(decision.candidate.family);
    expect(chosen.score).toBeCloseTo(decision.scored.score, 12);
    // …and every band member sits within the profile's near-equal
    // band of the band's best — variety never leaves the band.
    const best = Math.max(...selection.band.map((b) => b.score));
    for (const member of selection.band) {
      expect(best - member.score).toBeLessThanOrEqual(0.05 + 1e-9);
    }
    expect(typeof selection.agreedWithScorer).toBe("boolean");
  });

  it("rotates the seed coordinate per set and per decision", async () => {
    const brain = makeBrain();
    await brain.beginSet();
    expect(brain.consider(PAIR(), 0.3)!.selection.seed).toBe("linerave#1#1");
    expect(brain.consider(PAIR(), 0.3)!.selection.seed).toBe("linerave#1#2");
    await brain.beginSet();
    expect(brain.consider(PAIR(), 0.3)!.selection.seed).toBe("linerave#2#1");
  });

  it("hangs the coordinate from an injected session seed", async () => {
    const brain = makeBrain("another-night");
    await brain.beginSet();
    expect(brain.consider(PAIR(), 0.3)!.selection.seed).toBe(
      "another-night#1#1",
    );
  });
});

describe("reproducibility of the night's picks", () => {
  async function playDecisions(brain: DjBrain, count: number) {
    await brain.beginSet();
    const families: string[] = [];
    const seeds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const decision = brain.consider(PAIR(), 0.3)!;
      families.push(decision.candidate.family);
      seeds.push(decision.selection.seed);
      brain.recordPerformed(decision, { heardLengthSec: 190 });
    }
    return { families, seeds };
  }

  it("replays identically from a fresh brain with the same construction", async () => {
    const first = await playDecisions(makeBrain(), 6);
    const replay = await playDecisions(makeBrain(), 6);
    expect(replay).toEqual(first);
  });

  it("opens on a blend family, and history rotates the second pick off it", async () => {
    const { families } = await playDecisions(makeBrain(), 6);
    const blendFamilies = new Set([
      "long-blend",
      "standard-blend",
      "short-blend",
      "loop-extended-blend",
    ]);
    // The fresh-history field is the charter field: its band is
    // blends (the S5-4 guarantee-4 shape), so the opener blends.
    expect(blendFamilies.has(families[0])).toBe(true);
    // The performed family is charged (family + geometry +
    // same-pair ≈ 0.41) while its rivals carry only the same-pair
    // charge (≈ 0.25): a ≈ 0.16 differential against a 0.05 band
    // pushes it out of the second decision's band entirely.
    expect(families[1]).not.toBe(families[0]);
  });
});
