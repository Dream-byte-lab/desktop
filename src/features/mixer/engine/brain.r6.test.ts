// The brain, R6: playlist-bounded track choice (Addendum A),
// §28's evaluation of performed joins, and the minimum-play
// floor's anchor veto (Note 19, ruling 1). Fixtures follow the
// brain suite: 120 BPM, 240 s tracks, a friendly vocal pair.

import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { DjBrain, evaluatePerformedJoin, type BrainDecision } from "./brain";
import { candidatesForPair } from "./candidates";
import { STANDARD_PROFILE } from "./decisionProfile";
import {
  createJoinHistory,
  type JoinLogStorage,
  type JoinRecord,
} from "./joinHistory";
import { factsFromAnalysis, type TrackFacts } from "./playlistIntel";
import type { PreparedTrack } from "./trackSource";

const T0 = 1_000_000;

function key(camelot: string, pitchClass: number): KeyEstimate {
  return { tonic: "C", mode: "major", pitchClass, camelot, confidence: 0.9 };
}

function vocalCurve(
  durationSec: number,
  activityAt: (t: number) => number,
): VocalActivityCurve {
  const points = [];
  for (let t = 0; t < durationSec; t += 0.25) {
    points.push({ timeSec: t, activity: activityAt(t), confidence: 1 });
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

/** The same song, but its first chorus runs to 232 s — floor 232. */
function longChorusAnalysis(bigKind: "chorus" | "bridge"): TrackAnalysis {
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
      section(bigKind, 64, 232, 0.5, 0.9),
      section("outro", 232, 240, 0.1, 0),
    ],
    outro: { startSec: 232, endSec: 240, startBeat: 464, endBeat: 480 },
    vocalActivity: vocalCurve(240, (t) => (t < 16 ? 0 : t < 232 ? 0.9 : 0)),
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
    buffer: { duration: 240 } as unknown as AudioBuffer,
    analysis,
  };
}

function fakeStorage(
  seed: JoinRecord[] = [],
): JoinLogStorage & { saved: JoinRecord[] } {
  const saved: JoinRecord[] = [];
  return {
    saved,
    read: async () => (seed.length > 0 ? seed : null),
    write: async (joins) => {
      saved.splice(0, saved.length, ...joins);
    },
  };
}

function makeBrain(seed: JoinRecord[] = [], sessionSeed?: string) {
  const storage = fakeStorage(seed);
  const brain = new DjBrain({
    history: createJoinHistory(storage),
    now: () => T0,
    ...(sessionSeed ? { sessionSeed } : {}),
  });
  return { brain, storage };
}

/** Facts for a one-chorus song whose energy is set by its chorus level. */
function songFacts(
  trackId: string,
  hash: string,
  energy: number,
  labels?: { playlistGenres?: string[] },
): TrackFacts {
  const a: TrackAnalysis = {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: hash,
    sections: [section("chorus", 0, 240, energy * 0.35, 0)],
    vocalActivity: vocalCurve(240, () => 0),
  };
  return factsFromAnalysis(trackId, a, labels);
}

describe("the minimum-play floor binds the join's ANCHOR (ruling 1)", () => {
  it("sub-floor candidates exist in the authoring space — and the decision never lands on one", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const outgoing = outgoingAnalysis(); // floor: chorus ends at 112
    const incoming = incomingAnalysis();
    const raw = candidatesForPair(
      { outgoing, outgoingPositionSec: 60, incoming },
      { profiles: [STANDARD_PROFILE] },
    );
    // The authoring space genuinely contains early moves
    // (a drop-cut at 63 s, a section-swap at 111 s): without the
    // veto they would be eligible picks.
    expect(
      raw.some(
        (c) =>
          c.recipe.overlap.startAMs !== null &&
          c.recipe.overlap.startAMs < 112_000,
      ),
    ).toBe(true);
    const decision = brain.consider(
      {
        outgoing: prepared("a", outgoing),
        outgoingPositionSec: 60,
        incoming: prepared("b", incoming),
      },
      0.3,
    );
    expect(decision).not.toBeNull();
    const anchor = decision!.recipe.overlap.startAMs;
    expect(anchor === null || anchor >= 112_000).toBe(true);
  });

  it("with the chorus running to 232, only the outro blends and let-it-play survive", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const decision = brain.consider(
      {
        outgoing: prepared("a", longChorusAnalysis("chorus")),
        outgoingPositionSec: 60,
        incoming: prepared("b", incomingAnalysis()),
      },
      0.3,
    );
    expect(decision).not.toBeNull();
    const anchor = decision!.recipe.overlap.startAMs;
    expect(anchor === null || anchor >= 232_000).toBe(true);
  });

  it("the control: the same timings without a big section decide the same way", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const decision = brain.consider(
      {
        outgoing: prepared("a", longChorusAnalysis("bridge")),
        outgoingPositionSec: 60,
        incoming: prepared("b", incomingAnalysis()),
      },
      0.3,
    );
    // A bridge is not a big section: the floor falls back to the
    // first section's end (16 s) and the pair decides as before.
    expect(decision).not.toBeNull();
  });

  it("a section-less outgoing still owes its derived floor (Note 33)", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const outgoing = outgoingAnalysis();
    outgoing.sections = undefined;
    const decision = brain.consider(
      {
        outgoing: prepared("a", outgoing),
        outgoingPositionSec: 60,
        incoming: prepared("b", incomingAnalysis()),
      },
      0.3,
    );
    // No sections to read the floor from: it is derived — a
    // quarter of the 240 s track, 60 s — and the veto binds the
    // derived floor exactly as it binds a read one.
    expect(decision).not.toBeNull();
    const anchor = decision!.recipe.overlap.startAMs;
    expect(anchor === null || anchor >= 60_000).toBe(true);
  });
});

describe("§28 — performed joins are evaluated and persisted", () => {
  async function decidedBrain() {
    const { brain, storage } = makeBrain();
    await brain.beginSet();
    const decision = brain.consider(
      {
        outgoing: prepared("a", outgoingAnalysis()),
        outgoingPositionSec: 60,
        incoming: prepared("b", incomingAnalysis()),
      },
      0.3,
    )!;
    return { brain, storage, decision };
  }

  it("a completed join with an outcome carries its evaluation", async () => {
    const { brain, decision } = await decidedBrain();
    brain.recordPerformed(decision, {
      heardLengthSec: 200,
      outcome: { interrupted: false, loudnessContinuity: 0.95 },
    });
    const joins = brain.historySnapshot();
    expect(joins).toHaveLength(1);
    expect(joins[0].evaluation).toBeDefined();
    expect(joins[0].evaluation!.executionReliability).toBe(1);
    expect(joins[0].evaluation!.loudnessContinuity).toBeCloseTo(0.95);
    expect(joins[0].evaluation!.overall).toBeGreaterThan(0.5);
  });

  it("an interrupted join grades its execution at 0.35", async () => {
    const { brain, decision } = await decidedBrain();
    brain.recordPerformed(decision, {
      heardLengthSec: 90,
      outcome: { interrupted: true },
    });
    expect(brain.historySnapshot()[0].evaluation!.executionReliability).toBe(
      0.35,
    );
  });

  it("no outcome, no evaluation — the pre-R6 record shape (parity)", async () => {
    const { brain, decision } = await decidedBrain();
    brain.recordPerformed(decision, { heardLengthSec: 200 });
    expect(brain.historySnapshot()[0].evaluation).toBeUndefined();
  });

  it("grading is personality-relative: a cut is not failed for its loudness step", () => {
    const fabricated = (family: string) =>
      ({
        candidate: {
          family,
          evidence: {
            beatmatched: false,
            entryKind: "drop",
            gridConfidence: undefined,
            tempoConfidence: 0.9,
          },
        },
        scored: {
          components: [
            { name: "keyFit", value: 1 },
            { name: "structureFit", value: 1 },
          ],
        },
      }) as unknown as BrainDecision;
    const performed = {
      heardLengthSec: 100,
      outcome: { interrupted: false, loudnessContinuity: 0 },
    };
    const cut = evaluatePerformedJoin(fabricated("drop-cut"), performed);
    const blend = evaluatePerformedJoin(
      fabricated("standard-blend"),
      performed,
    );
    expect(cut.beatAlignment).toBe(0.9);
    expect(cut.overall).toBeCloseTo(0.86);
    expect(blend.overall).toBeCloseTo(0.72);
    expect(cut.overall).toBeGreaterThan(blend.overall);
  });
});

describe("chooseNextTrack — playlist-bounded autonomy (Addendum A)", () => {
  it("a field of one is not a choice — the standing order stands", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const only = songFacts("only", "hash-only", 0.5);
    expect(
      brain.chooseNextTrack({
        current: null,
        field: [{ trackId: "only", facts: only }],
        arcPosition: 0,
      }),
    ).toBeNull();
  });

  it("replays exactly from the same seed coordinates", async () => {
    const field = [
      { trackId: "x", facts: songFacts("x", "hash-x", 0.5) },
      { trackId: "y", facts: songFacts("y", "hash-y", 0.5) },
      { trackId: "z", facts: songFacts("z", "hash-z", 0.5) },
    ];
    const run = async () => {
      const { brain } = makeBrain();
      await brain.beginSet();
      return brain.chooseNextTrack({ current: null, field, arcPosition: 0.2 });
    };
    const first = await run();
    const second = await run();
    expect(first).not.toBeNull();
    expect(second!.trackId).toBe(first!.trackId);
    expect(second!.record.seed).toBe("linerave#1#1");
    expect(second!.record.field).toEqual(first!.record.field);
  });

  it("the incumbent holds a real head start over identical rivals", async () => {
    let incumbentWins = 0;
    const runs = 120;
    for (let i = 0; i < runs; i += 1) {
      const { brain } = makeBrain([], `night-${i}`);
      await brain.beginSet();
      const field = [
        { trackId: "holder", facts: songFacts("holder", "hash-h", 0.5) },
        { trackId: "rival1", facts: songFacts("rival1", "hash-r1", 0.5) },
        { trackId: "rival2", facts: songFacts("rival2", "hash-r2", 0.5) },
      ];
      const choice = brain.chooseNextTrack({
        current: null,
        field,
        arcPosition: 0.2,
      });
      if (choice?.trackId === "holder") incumbentWins += 1;
    }
    // Three identical candidates: a fair lottery gives ~40; the
    // incumbency logit lifts the holder to roughly four in five.
    expect(incumbentWins).toBeGreaterThanOrEqual(72);
    expect(incumbentWins).toBeLessThan(runs);
  });

  it("the arc steers: at the peak, the peak-energy track wins outright", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const current = songFacts("now", "hash-now", 0.5);
    const choice = brain.chooseNextTrack({
      current,
      field: [
        { trackId: "low", facts: songFacts("low", "hash-low", 0.2) },
        { trackId: "peak", facts: songFacts("peak", "hash-peak", 0.9) },
      ],
      arcPosition: 0.55,
    });
    expect(choice?.trackId).toBe("peak");
    expect(choice?.record.bandSize).toBe(1);
  });

  it("§15 shapes track choice: a recently-played twin is leaned away from", async () => {
    const seed: JoinRecord[] = [0, 1, 2].map(
      (i) =>
        ({
          aAudioHash: "hash-earlier",
          bAudioHash: "hash-twin-b",
          family: "standard-blend",
          profileId: "standard",
          pairShape: "similar",
          blendBeats: 32,
          stretch: 0,
          heardLengthSec: 180,
          at: T0 + i,
        }) as unknown as JoinRecord,
    );
    const { brain } = makeBrain(seed);
    await brain.beginSet();
    const choice = brain.chooseNextTrack({
      current: null,
      field: [
        { trackId: "holder", facts: songFacts("holder", "hash-h", 0.5) },
        { trackId: "twin-b", facts: songFacts("twin-b", "hash-twin-b", 0.5) },
        { trackId: "twin-c", facts: songFacts("twin-c", "hash-twin-c", 0.5) },
      ],
      arcPosition: 0.2,
    });
    const probabilityOf = (id: string) =>
      choice!.record.field.find((entry) => entry.trackId === id)!.probability;
    expect(probabilityOf("twin-b")).toBeLessThan(probabilityOf("twin-c"));
    expect(probabilityOf("twin-b")).toBeGreaterThan(0);
  });

  it("genre flexibility spends at track level through the resolved credit", async () => {
    const { brain } = makeBrain();
    await brain.beginSet();
    const current = songFacts("now", "hash-now", 0.5, {
      playlistGenres: ["Warm Up"],
    });
    const field = [
      {
        trackId: "shared",
        facts: songFacts("shared", "hash-s", 0.5, {
          playlistGenres: ["Warm Up"],
        }),
      },
      {
        trackId: "other",
        facts: songFacts("other", "hash-o", 0.5, {
          playlistGenres: ["Peak Time"],
        }),
      },
    ];
    const scoreOf = (
      choice: ReturnType<DjBrain["chooseNextTrack"]>,
      id: string,
    ) => choice!.record.field.find((entry) => entry.trackId === id)!.score;
    const house = brain.chooseNextTrack({ current, field, arcPosition: 0.2 });
    expect(scoreOf(house, "shared")).toBeGreaterThan(scoreOf(house, "other"));
    const openFormat = brain.chooseNextTrack({
      current,
      field,
      arcPosition: 0.2,
      curation: {
        nearEqualEpsilon: 0.05,
        incumbencyPenalty: 0.1,
        sharedLabelCredit: 0.25,
      },
    });
    expect(scoreOf(openFormat, "other")).toBeGreaterThan(
      scoreOf(openFormat, "shared"),
    );
  });
});
