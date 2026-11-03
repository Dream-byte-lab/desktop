import { describe, expect, it } from "vitest";
import type { KeyEstimate } from "./detectKey";
import {
  arcTarget,
  assembleSet,
  candidateFromAnalysis,
  chooseArcShape,
  type SetCandidate,
} from "./curatedSet";
import type { TrackAnalysis } from "./analyseTrack";

function key(
  tonic: string,
  mode: "major" | "minor",
  camelot: string,
  pitchClass: number,
) {
  const estimate: KeyEstimate = {
    tonic,
    mode,
    pitchClass,
    camelot,
    confidence: 0.9,
  };
  return estimate;
}

const C_MAJOR = key("C", "major", "8B", 0);
const G_MAJOR = key("G", "major", "9B", 7); // adjacent on the wheel
const A_MINOR = key("A", "minor", "8A", 9); // relative of C major
const F_SHARP_MINOR = key("F#", "minor", "11A", 6); // distant from all above

function candidate(
  trackId: string,
  energy: number,
  k: KeyEstimate | null = C_MAJOR,
  bpm = 124,
): SetCandidate {
  return { trackId, bpm, key: k, energy };
}

describe("arcTarget", () => {
  it("opens and lands low, peaks past the middle", () => {
    expect(arcTarget(0)).toBeCloseTo(0.3);
    expect(arcTarget(1)).toBeCloseTo(0.3);
    expect(arcTarget(0.55)).toBeCloseTo(0.9);
    expect(arcTarget(0.25)).toBeCloseTo(0.55);
  });
});

describe("assembleSet", () => {
  // A pool spanning the energy range, keys mostly compatible.
  const pool: SetCandidate[] = [
    candidate("peak-1", 0.92),
    candidate("warm-1", 0.28),
    candidate("build-1", 0.55, G_MAJOR),
    candidate("mid-1", 0.62, A_MINOR),
    candidate("warm-2", 0.35, A_MINOR),
    candidate("peak-2", 0.85, G_MAJOR),
    candidate("land-1", 0.3),
    candidate("release-1", 0.58),
    candidate("build-2", 0.5),
    candidate("peak-3", 0.95, A_MINOR),
  ];

  it("uses the whole pool with no repeats", () => {
    const set = assembleSet(pool);
    expect(set).toHaveLength(pool.length);
    expect(new Set(set).size).toBe(pool.length);
  });

  it("shapes the energy arc: gentle open, hot middle, gentle landing", () => {
    const byId = new Map(pool.map((c) => [c.trackId, c]));
    const set = assembleSet(pool).map((id) => byId.get(id)!);
    expect(set[0].energy).toBeLessThanOrEqual(0.4);
    expect(set[set.length - 1].energy).toBeLessThanOrEqual(0.45);
    const middle = set[Math.floor(set.length / 2)];
    expect(middle.energy).toBeGreaterThanOrEqual(0.8);
  });

  it("respects a requested length and handles tiny or empty pools", () => {
    expect(assembleSet(pool, 4)).toHaveLength(4);
    expect(assembleSet([candidate("only", 0.5)])).toEqual(["only"]);
    expect(assembleSet([])).toEqual([]);
  });

  it("is deterministic", () => {
    expect(assembleSet(pool)).toEqual(assembleSet(pool));
  });

  it("prefers a compatible join over an equal-energy clashing one", () => {
    // After the opener (C major), two candidates fit the build energy
    // equally; the G major one joins well, the F# minor one clashes.
    const clashPool: SetCandidate[] = [
      candidate("opener", 0.3, C_MAJOR),
      candidate("smooth", 0.55, G_MAJOR),
      candidate("clash", 0.55, F_SHARP_MINOR),
      candidate("peak", 0.9, C_MAJOR),
      candidate("closer", 0.3, C_MAJOR),
    ];
    const set = assembleSet(clashPool);
    const smoothAt = set.indexOf("smooth");
    const clashAt = set.indexOf("clash");
    // The clash is not excluded — a set uses its pool — but the smooth
    // join is taken first, adjacent to the opener.
    expect(smoothAt).toBeLessThan(clashAt);
  });
});

describe("candidateFromAnalysis", () => {
  it("reads bpm, key and peak energy from an analysis", () => {
    const analysis: TrackAnalysis = {
      beatMap: { bpm: 126, firstBeatSec: 0, beatsPerBar: 4, durationSec: 200 },
      tempoConfidence: 0.9,
      energyCurve: [
        { timeSec: 0, energy: 0.2 },
        { timeSec: 1, energy: 0.4 },
        { timeSec: 2, energy: 1.0 },
        { timeSec: 3, energy: 0.9 },
      ],
      drops: [],
      key: C_MAJOR,
      vocalRanges: [],
      loudness: 0.4,
    };
    const result = candidateFromAnalysis("t1", analysis);
    expect(result.bpm).toBe(126);
    expect(result.key).toBe(C_MAJOR);
    // Top quarter of [1.0, 0.9, 0.4, 0.2] is just [1.0].
    expect(result.energy).toBeCloseTo(1.0);
  });
});

describe("arc shapes (v2)", () => {
  it("front-peak arrives earlier; slow-burn peaks later than classic", () => {
    expect(arcTarget(0.2, "front-peak")).toBeGreaterThan(arcTarget(0.2));
    expect(arcTarget(0.55, "slow-burn")).toBeLessThan(arcTarget(0.55));
    expect(arcTarget(0.88, "slow-burn")).toBeCloseTo(0.92);
  });

  it("chooses the night's shape from the pool itself", () => {
    const hot = [
      candidate("h1", 0.9),
      candidate("h2", 0.85),
      candidate("h3", 0.8),
      candidate("h4", 0.75),
    ];
    expect(chooseArcShape(hot)).toBe("front-peak");
    const warm = [
      candidate("w1", 0.3),
      candidate("w2", 0.35),
      candidate("w3", 0.4),
      candidate("w4", 0.42),
    ];
    expect(chooseArcShape(warm)).toBe("slow-burn");
    const mixed = [
      candidate("m1", 0.3),
      candidate("m2", 0.55),
      candidate("m3", 0.9),
      candidate("m4", 0.5),
    ];
    expect(chooseArcShape(mixed)).toBe("classic");
    expect(chooseArcShape([candidate("only", 0.9)])).toBe("classic");
  });
});

describe("candidateFromAnalysis (v2)", () => {
  it("reads energy absolutely from sections when they exist", () => {
    const analysis: TrackAnalysis = {
      beatMap: { bpm: 126, firstBeatSec: 0, beatsPerBar: 4, durationSec: 200 },
      tempoConfidence: 0.9,
      energyCurve: [{ timeSec: 0, energy: 1 }], // peak-normalised bait
      drops: [],
      key: C_MAJOR,
      vocalRanges: [],
      loudness: 0.4,
      sections: [
        {
          kind: "chorus",
          startSec: 0,
          endSec: 100,
          startBeat: 0,
          endBeat: 200,
          meanRms: 0.07, // a genuinely quiet track
          vocalActivity: 0.5,
          confidence: 0.9,
        },
        {
          kind: "drop",
          startSec: 100,
          endSec: 200,
          startBeat: 200,
          endBeat: 400,
          meanRms: 0.315,
          vocalActivity: 0,
          confidence: 0.9,
        },
      ],
    };
    // The drop's absolute level rules: 0.315 / 0.35 reference = 0.9 —
    // NOT the normalised curve's 1.0.
    expect(candidateFromAnalysis("t1", analysis).energy).toBeCloseTo(0.9);
    const quiet: TrackAnalysis = {
      ...analysis,
      sections: [analysis.sections![0]],
    };
    expect(candidateFromAnalysis("t2", quiet).energy).toBeCloseTo(0.2);
  });

  it("carries the owner's labels when given them", () => {
    const analysis: TrackAnalysis = {
      beatMap: { bpm: 126, firstBeatSec: 0, beatsPerBar: 4, durationSec: 200 },
      tempoConfidence: 0.9,
      energyCurve: [],
      drops: [],
      key: C_MAJOR,
      vocalRanges: [],
      loudness: 0.4,
    };
    const result = candidateFromAnalysis("t1", analysis, {
      playlistGenres: ["Amapiano"],
      genres: [],
    });
    expect(result.playlistGenres).toEqual(["Amapiano"]);
    expect(result.genres).toBeUndefined();
  });
});

describe("assembleSet context (v2)", () => {
  it("a rotation seed turns the near-equal band", () => {
    const tied: SetCandidate[] = [
      candidate("first", 0.5),
      candidate("second", 0.5),
      candidate("third", 0.5),
    ];
    expect(assembleSet(tied)[0]).toBe("first");
    expect(assembleSet(tied, undefined, { rotationSeed: 1 })[0]).toBe("second");
    // Same pool + same seed = same set (determinism is contextual).
    expect(assembleSet(tied, undefined, { rotationSeed: 1 })).toEqual(
      assembleSet(tied, undefined, { rotationSeed: 1 }),
    );
  });

  it("continues the owner's Playlist Genre across a near-equal slot", () => {
    const pool: SetCandidate[] = [
      { ...candidate("opener", 0.3), playlistGenres: ["Amapiano"] },
      { ...candidate("other", 0.55), playlistGenres: ["House"] },
      { ...candidate("kin", 0.55), playlistGenres: ["Amapiano"] },
      candidate("peak", 0.9),
      candidate("closer", 0.3),
    ];
    const set = assembleSet(pool);
    expect(set.indexOf("kin")).toBeLessThan(set.indexOf("other"));
  });

  it("respects the pool absolutely under any options", () => {
    const pool = [
      candidate("p1", 0.3),
      candidate("p2", 0.6),
      candidate("p3", 0.9),
    ];
    const set = assembleSet(pool, undefined, {
      shape: "front-peak",
      rotationSeed: 2,
    });
    expect([...set].sort()).toEqual(["p1", "p2", "p3"]);
  });
});
