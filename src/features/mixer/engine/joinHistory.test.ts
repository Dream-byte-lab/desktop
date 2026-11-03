import { describe, expect, it } from "vitest";
import { linerDb } from "@/shared/storage";
import type { TrackAnalysis } from "./analyseTrack";
import { STANDARD_PROFILE } from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import {
  createJoinHistory,
  JOIN_LOG_ID,
  linerDbJoinStorage,
  MAX_STORED_JOINS,
  pairShapeOf,
  repetitionCost,
  validateJoinLog,
  type JoinLogStorage,
  type JoinRecord,
  type RepetitionProbe,
} from "./joinHistory";

// Join history (S5-3): the log, the pair-shape vocabulary, and the
// anti-repetition read — the exact rule scoring spends.

function key(
  camelot: string,
  pitchClass: number,
  mode: "major" | "minor" = "major",
): KeyEstimate {
  return { tonic: "C", mode, pitchClass, camelot, confidence: 0.9 };
}

function vocalCurve(activity: number): VocalActivityCurve {
  const points = [];
  for (let t = 0; t < 240; t += 0.25) {
    points.push({ timeSec: t, activity, confidence: 1 });
  }
  return { windowSec: 0.25, stepSec: 0.25, points };
}

function analysis(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
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
    ...overrides,
  };
}

function join(overrides: Partial<JoinRecord> = {}): JoinRecord {
  return {
    aAudioHash: "a-1",
    bAudioHash: "b-1",
    family: "standard-blend",
    profileId: "standard",
    pairShape: "matched/same/both-vocal",
    blendBeats: 16,
    stretch: 0,
    heardLengthSec: 120,
    at: 1_000,
    ...overrides,
  };
}

function probe(overrides: Partial<RepetitionProbe> = {}): RepetitionProbe {
  return {
    family: "standard-blend",
    pairShape: "matched/same/both-vocal",
    blendBeats: 16,
    heardLengthSec: 120,
    aAudioHash: "a-2",
    bAudioHash: "b-2",
    ...overrides,
  };
}

function fakeStorage(): JoinLogStorage & { value: unknown } {
  return {
    value: null,
    async read() {
      return this.value;
    },
    async write(joins) {
      this.value = [...joins];
    },
  };
}

describe("pairShapeOf — the similarity vocabulary", () => {
  it("describes tempo, key and vocal facets from structure alone", () => {
    const a = analysis({ vocalActivity: vocalCurve(0.9) });
    const b = analysis({ audioHash: "hash-b", vocalActivity: vocalCurve(0.9) });
    expect(pairShapeOf(a, b)).toBe("matched/same/both-vocal");

    const faster = analysis({
      audioHash: "hash-b",
      beatMap: { bpm: 130, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
      vocalActivity: vocalCurve(0),
    });
    expect(pairShapeOf(a, faster)).toBe("faster/same/one-vocal");

    const keyless = analysis({ audioHash: "hash-b", key: null });
    expect(pairShapeOf(a, keyless)).toContain("/unknown/");
  });
});

describe("repetitionCost — the anti-repetition rule's exact shape", () => {
  it("a fresh history costs every probe exactly nothing", () => {
    expect(repetitionCost([], probe(), STANDARD_PROFILE)).toEqual({
      cost: 0,
      notes: [],
    });
  });

  it("charges decay with recency: the last join costs most", () => {
    const only = [join({ blendBeats: 0, heardLengthSec: null })];
    expect(
      repetitionCost(
        only,
        probe({ blendBeats: 0, heardLengthSec: null }),
        STANDARD_PROFILE,
      ).cost,
    ).toBeCloseTo(0.1, 9);
    const buried = [
      join({ blendBeats: 0, heardLengthSec: null }),
      join({ family: "drop-cut", blendBeats: 0, heardLengthSec: null }),
      join({ family: "echo-out", blendBeats: 0, heardLengthSec: null }),
    ];
    // The matching record is now two joins back: 0.1 / 3.
    expect(
      repetitionCost(
        buried,
        probe({ blendBeats: 0, heardLengthSec: null }),
        STANDARD_PROFILE,
      ).cost,
    ).toBeCloseTo(0.1 / 3, 9);
  });

  it("the same family for a different pair-shape costs less", () => {
    const sameShape = repetitionCost(
      [join({ blendBeats: 0 })],
      probe({ blendBeats: 0 }),
      STANDARD_PROFILE,
    ).cost;
    const otherShape = repetitionCost(
      [join({ blendBeats: 0, pairShape: "slower/distant/no-vocal" })],
      probe({ blendBeats: 0 }),
      STANDARD_PROFILE,
    ).cost;
    expect(sameShape).toBeCloseTo(0.1, 9);
    expect(otherShape).toBeCloseTo(0.03, 9);
  });

  it("near-identical geometry charges on top of the family", () => {
    const same = repetitionCost([join()], probe(), STANDARD_PROFILE).cost;
    expect(same).toBeCloseTo(0.1 + 0.06, 9);
    const different = repetitionCost(
      [join()],
      probe({ blendBeats: 8 }),
      STANDARD_PROFILE,
    ).cost;
    expect(different).toBeCloseTo(0.1, 9);
  });

  it("the exact pair again charges whatever the family", () => {
    const history = [
      join({ family: "let-it-play", blendBeats: 0, heardLengthSec: null }),
    ];
    const cost = repetitionCost(
      history,
      probe({
        family: "drop-cut",
        blendBeats: 0,
        heardLengthSec: null,
        aAudioHash: "a-1",
        bAudioHash: "b-1",
      }),
      STANDARD_PROFILE,
    ).cost;
    expect(cost).toBeCloseTo(0.25, 9);
  });

  it("a third similar heard length in a row charges once", () => {
    const history = [
      join({ family: "drop-cut", heardLengthSec: 100, aAudioHash: "x" }),
      join({ family: "echo-out", heardLengthSec: 100, aAudioHash: "y" }),
    ];
    const third = repetitionCost(
      history,
      probe({ family: "filter-fade", heardLengthSec: 103 }),
      STANDARD_PROFILE,
    );
    expect(third.cost).toBeCloseTo(0.08, 9);
    const broken = repetitionCost(
      history,
      probe({ family: "filter-fade", heardLengthSec: 160 }),
      STANDARD_PROFILE,
    );
    expect(broken.cost).toBe(0);
  });

  it("the total is clamped at the profile's maximum", () => {
    const history = Array.from({ length: 12 }, () => join());
    const { cost } = repetitionCost(
      history,
      probe({ aAudioHash: "a-1", bAudioHash: "b-1" }),
      STANDARD_PROFILE,
    );
    expect(cost).toBe(STANDARD_PROFILE.antiRepetition.maxCost);
  });
});

describe("the join log", () => {
  it("records in order, serves recent slices, and trims at the cap", async () => {
    const log = createJoinHistory(fakeStorage());
    for (let i = 0; i < MAX_STORED_JOINS + 5; i += 1) {
      log.record(join({ at: i }));
    }
    expect(log.size).toBe(MAX_STORED_JOINS);
    expect(log.all()[0].at).toBe(5);
    expect(log.recent(2).map((j) => j.at)).toEqual([
      MAX_STORED_JOINS + 3,
      MAX_STORED_JOINS + 4,
    ]);
    await log.clear();
    expect(log.size).toBe(0);
  });

  it("validateJoinLog drops anything unrecognisable", () => {
    expect(validateJoinLog("garbage")).toEqual([]);
    expect(validateJoinLog(null)).toEqual([]);
    const good = join();
    const mixed = validateJoinLog([
      good,
      { family: "not-a-family" },
      null,
      42,
      join({ at: Number.NaN }),
    ]);
    expect(mixed).toEqual([good]);
  });

  it("persists across log instances through linerDb, and a corrupt store reads as empty", async () => {
    const marker = join({ family: "vinyl-stop", at: 424_242 });
    const first = createJoinHistory(linerDbJoinStorage);
    first.record(marker);

    const second = createJoinHistory(linerDbJoinStorage);
    const loaded = await second.load();
    expect(
      loaded.some((j) => j.family === "vinyl-stop" && j.at === 424_242),
    ).toBe(true);

    await linerDb.putJoinLog({
      id: JOIN_LOG_ID,
      joins: "not a log",
      savedAt: Date.now(),
    });
    const third = createJoinHistory(linerDbJoinStorage);
    await expect(third.load()).resolves.toEqual([]);
  });
});
