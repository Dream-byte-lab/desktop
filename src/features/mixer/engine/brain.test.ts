import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import { DjBrain, deriveProfile } from "./brain";
import { STANDARD_PROFILE } from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import {
  createJoinHistory,
  type JoinLogStorage,
  type JoinRecord,
} from "./joinHistory";
import type { PreparedTrack } from "./trackSource";

// The brain (S5-4): the decision loop over the S5-3 seam. Fixture
// arithmetic follows the candidates suite: 120 BPM (a beat is
// 0.5 s), 240 s tracks, a friendly vocal pair with full structure.

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

function outgoingAnalysis(outroStartSec = 200): TrackAnalysis {
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
      section("verse", 112, outroStartSec, 0.3, 0.85),
      section("outro", outroStartSec, 240, 0.1, 0),
    ],
    outro: {
      startSec: outroStartSec,
      endSec: 240,
      startBeat: outroStartSec * 2,
      endBeat: 480,
    },
    vocalActivity: vocalCurve(240, (t) =>
      t < 16 ? 0 : t < outroStartSec ? 0.9 : 0,
    ),
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

function fakeStorage(): JoinLogStorage & { saved: JoinRecord[] } {
  const saved: JoinRecord[] = [];
  return {
    saved,
    read: async () => null,
    write: async (joins) => {
      saved.splice(0, saved.length, ...joins);
    },
  };
}

function makeBrain(): {
  brain: DjBrain;
  storage: ReturnType<typeof fakeStorage>;
  setNow: (ms: number) => void;
} {
  let now = T0;
  const storage = fakeStorage();
  const brain = new DjBrain({
    history: createJoinHistory(storage),
    now: () => now,
  });
  return {
    brain,
    storage,
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

const BLEND_FAMILIES = new Set([
  "long-blend",
  "standard-blend",
  "short-blend",
  "loop-extended-blend",
]);

describe("the decision loop", () => {
  it("guarantee 4 (brain level): a friendly pair yields a planned blend, not a cut", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const decision = brain.consider(
      {
        outgoing: prepared("a", outgoingAnalysis()),
        outgoingPositionSec: 60,
        incoming: prepared("b", incomingAnalysis()),
      },
      0.3,
    );
    expect(decision).not.toBeNull();
    expect(BLEND_FAMILIES.has(decision!.candidate.family)).toBe(true);
    expect(decision!.recipe.overlap.durationMs).toBeGreaterThan(0);
    expect(decision!.recipe.fingerprints.aAudioHash).toBe("hash-a");
    expect(decision!.recipe.fingerprints.bAudioHash).toBe("hash-b");
  });

  it("records a performed join with the §8 field shape — and only then", async () => {
    const { brain, storage } = makeBrain();
    await brain.beginSet();
    const decision = brain.consider(
      {
        outgoing: prepared("a", outgoingAnalysis()),
        outgoingPositionSec: 60,
        incoming: prepared("b", incomingAnalysis()),
      },
      0.3,
    );
    expect(brain.historySnapshot()).toHaveLength(0);
    brain.recordPerformed(decision!, { heardLengthSec: 187.5 });
    const joins = brain.historySnapshot();
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({
      aAudioHash: "hash-a",
      bAudioHash: "hash-b",
      family: decision!.candidate.family,
      profileId: "standard",
      pairShape: decision!.candidate.evidence.pairShape,
      blendBeats: decision!.candidate.evidence.blendBeats,
      stretch: decision!.candidate.evidence.stretch,
      heardLengthSec: 187.5,
      at: T0,
    });
    expect(storage.saved).toHaveLength(1);
  });

  it("feeds history back into scoring: a thrice-repeated join is charged or rotated away", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const pair = {
      outgoing: prepared("a", outgoingAnalysis()),
      outgoingPositionSec: 60,
      incoming: prepared("b", incomingAnalysis()),
    };
    const first = brain.consider(pair, 0.3)!;
    for (let i = 0; i < 3; i += 1) {
      brain.recordPerformed(first, { heardLengthSec: 190 });
    }
    const next = brain.consider(pair, 0.3)!;
    expect(
      next.scored.historyCost > 0 ||
        next.candidate.family !== first.candidate.family,
    ).toBe(true);
  });
});

describe("Req 1 — plans revise when the world changes", () => {
  it("an outro that arrives early moves the next decision's anchor", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const incoming = prepared("b", incomingAnalysis());
    const early = brain.consider(
      {
        outgoing: prepared("a", outgoingAnalysis(200)),
        outgoingPositionSec: 60,
        incoming,
      },
      0.3,
    );
    // The same track, re-read: its outro actually starts at 120 s.
    const revised = brain.consider(
      {
        outgoing: prepared("a", outgoingAnalysis(120)),
        outgoingPositionSec: 100,
        incoming,
      },
      0.3,
    );
    expect(early!.recipe.overlap.startAMs).not.toBeNull();
    expect(revised!.recipe.overlap.startAMs).not.toBeNull();
    expect(revised!.recipe.overlap.startAMs!).toBeLessThan(
      early!.recipe.overlap.startAMs!,
    );
  });
});

describe("Req 2 — signals move the weights decisions are made with", () => {
  it("an early skip raises the long-ride costs in the derived profile", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const before = brain.effectiveProfile(T0);
    expect(before.familyCosts["long-blend"]).toBe(
      STANDARD_PROFILE.familyCosts["long-blend"],
    );
    brain.signals.record({
      kind: "skip-early",
      family: "standard-blend",
      atMs: T0,
    });
    const after = brain.effectiveProfile(T0);
    // Impatience (0.7) leans on both long rides…
    expect(after.familyCosts["long-blend"]).toBeCloseTo(
      STANDARD_PROFILE.familyCosts["long-blend"] + 0.07,
    );
    expect(after.familyCosts["loop-extended-blend"]).toBeCloseTo(
      STANDARD_PROFILE.familyCosts["loop-extended-blend"] + 0.07,
    );
    // …and the skip's charge lands on the family that delivered it.
    expect(after.familyCosts["standard-blend"]).toBeCloseTo(
      STANDARD_PROFILE.familyCosts["standard-blend"] + 0.09,
    );
    // The base temperament is untouched: derivation is a copy.
    expect(brain.profile.familyCosts["long-blend"]).toBe(
      STANDARD_PROFILE.familyCosts["long-blend"],
    );
    // And the decision itself is authored under the derived profile.
    const decision = brain.consider(
      {
        outgoing: prepared("a", outgoingAnalysis()),
        outgoingPositionSec: 60,
        incoming: prepared("b", incomingAnalysis()),
      },
      0.3,
    );
    expect(decision!.profile.familyCosts["long-blend"]).toBeCloseTo(
      after.familyCosts["long-blend"],
    );
  });

  it("the raise decays as the signal ages", () => {
    const { brain } = makeBrain();
    brain.signals.record({ kind: "skip-early", atMs: T0 });
    const fresh = deriveProfile(brain.profile, brain.signals, T0);
    const aged = deriveProfile(brain.profile, brain.signals, T0 + 90_000);
    expect(aged.familyCosts["long-blend"]).toBeCloseTo(
      STANDARD_PROFILE.familyCosts["long-blend"] + 0.035,
    );
    expect(aged.familyCosts["long-blend"]).toBeLessThan(
      fresh.familyCosts["long-blend"],
    );
  });
});

describe("the arc", () => {
  it("follows the night's shape and leans with the room", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    expect(brain.arcTargetAt(0.55, T0)).toBeCloseTo(0.9); // classic peak
    brain.setArcShape("slow-burn");
    expect(brain.arcTargetAt(0.55, T0)).toBeLessThan(0.9);
    brain.setArcShape("classic");
    for (let i = 0; i < 8; i += 1) {
      brain.signals.record({ kind: "party-reaction", atMs: T0 - 5_000 });
    }
    expect(brain.arcTargetAt(0.55, T0)).toBeGreaterThan(0.9);
  });
});
