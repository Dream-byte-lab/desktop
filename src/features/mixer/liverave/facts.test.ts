import { describe, expect, it } from "vitest";
import { buildTrackFacts, keyFitBetween, type TrackRead } from "./facts";

function beatsEvery(stepMs: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => i * stepMs);
}

function makeRead(overrides: Partial<TrackRead> = {}): TrackRead {
  return {
    audioHash: "deadbeef",
    analysisVersion: 1,
    depth: "deep",
    durationSec: 240,
    bpm: 120,
    tempoConfidence: 0.4,
    grid: {
      beatsMs: beatsEvery(500, 481),
      downbeatsMs: beatsEvery(2000, 121),
      beatsPerBar: 4,
      confidence: 0.5,
    },
    key: { tonic: 0, mode: "major", camelot: "8B", confidence: 0.8 },
    sections: [],
    energyCurvePerSec: [],
    energyContour: [],
    vocalActivity: [],
    drops: [],
    loudnessRms: 0.2,
    ...overrides,
  };
}

describe("buildTrackFacts — null and thin reads", () => {
  it("null read with a known duration: everything unknown, derived floor", () => {
    const facts = buildTrackFacts("t1", null, 240_000);
    expect(facts.durationMs).toBe(240_000);
    expect(facts.tempo).toEqual({ bpm: null, confidence: 0 });
    expect(facts.grid.beatMs).toEqual([]);
    expect(facts.sections).toEqual([]);
    expect(facts.phrases).toEqual([]);
    expect(facts.key).toBeNull();
    expect(facts.drops).toEqual([]);
    expect(facts.intro).toBeNull();
    expect(facts.outro).toBeNull();
    expect(facts.loopSpans).toEqual([]);
    expect(facts.beatmatchTrusted).toBe(false);
    expect(facts.minimumPlayMs).toBe(60_000); // 240 s / 4
    expect(facts.vocals.vocalActivityIn(0, 60_000)).toEqual({
      mean: 0,
      confidence: 0,
      witnessed: false,
    });
    expect(facts.evidenceQuality.score).toBe(0);
  });

  it("null read and unknown duration: minimumPlayMs is null, nothing throws", () => {
    const facts = buildTrackFacts("t1", null, null);
    expect(facts.durationMs).toBeNull();
    expect(facts.minimumPlayMs).toBeNull();
  });

  it("duration falls back to the read's durationSec", () => {
    const facts = buildTrackFacts("t1", makeRead(), null);
    expect(facts.durationMs).toBe(240_000);
    expect(facts.audioHash).toBe("deadbeef");
  });
});

describe("buildTrackFacts — minimumPlayMs (Note 33 semantics)", () => {
  it("witnessed sections: genuine floor is the first body section's end", () => {
    const read = makeRead({
      sections: [
        { kind: "intro", startMs: 0, endMs: 10_000, meanEnergy: 0.05 },
        { kind: "verse", startMs: 10_000, endMs: 50_000, meanEnergy: 0.15 },
        { kind: "chorus", startMs: 50_000, endMs: 110_000, meanEnergy: 0.3 },
        { kind: "verse", startMs: 110_000, endMs: 180_000, meanEnergy: 0.15 },
        { kind: "outro", startMs: 180_000, endMs: 240_000, meanEnergy: 0.05 },
      ],
    });
    const facts = buildTrackFacts("t1", read, 240_000);
    expect(facts.minimumPlayMs).toBe(50_000);
    expect(facts.intro).toEqual({ startMs: 0, endMs: 10_000 });
    expect(facts.outro).toEqual({ startMs: 180_000, endMs: 240_000 });
  });

  it("thin sections (one span for the whole track): derived floor", () => {
    const read = makeRead({
      sections: [
        { kind: "verse", startMs: 0, endMs: 240_000, meanEnergy: 0.2 },
      ],
    });
    expect(buildTrackFacts("t1", read, 240_000).minimumPlayMs).toBe(60_000);
  });

  it("thin sections on a long track: derived floor caps at 90 s", () => {
    const read = makeRead({ durationSec: 600, sections: [] });
    expect(buildTrackFacts("t1", read, 600_000).minimumPlayMs).toBe(90_000);
  });

  it("genuine floor under 10 s is raised to the derived floor", () => {
    const read = makeRead({
      sections: [
        { kind: "intro", startMs: 0, endMs: 2_000, meanEnergy: 0.05 },
        { kind: "verse", startMs: 2_000, endMs: 6_000, meanEnergy: 0.15 },
        { kind: "chorus", startMs: 6_000, endMs: 120_000, meanEnergy: 0.3 },
        { kind: "outro", startMs: 120_000, endMs: 240_000, meanEnergy: 0.05 },
      ],
    });
    expect(buildTrackFacts("t1", read, 240_000).minimumPlayMs).toBe(60_000);
  });

  it("fragmentary sections (low coverage) stay thin: derived floor", () => {
    const read = makeRead({
      sections: [
        { kind: "verse", startMs: 0, endMs: 10_000, meanEnergy: 0.15 },
        { kind: "chorus", startMs: 10_000, endMs: 20_000, meanEnergy: 0.3 },
      ],
    });
    expect(buildTrackFacts("t1", read, 240_000).minimumPlayMs).toBe(60_000);
  });
});

describe("buildTrackFacts — vocals witnessed vs unwitnessed", () => {
  function vocalRead(confidence: number): TrackRead {
    return makeRead({
      vocalActivity: [
        { startMs: 0, endMs: 250, activity: 0.8, confidence },
        { startMs: 250, endMs: 500, activity: 0.8, confidence },
      ],
    });
  }

  it("confident, covering windows are witnessed", () => {
    const facts = buildTrackFacts("t1", vocalRead(0.9), 240_000);
    // Windows tile by start time: [0,250] stands until 250, [250,500]
    // until its own end — the query [0, 500] is fully covered.
    const result = facts.vocals.vocalActivityIn(0, 500);
    expect(result.mean).toBeCloseTo(0.8);
    expect(result.confidence).toBeCloseTo(0.9);
    expect(result.witnessed).toBe(true);
  });

  it("low-confidence windows report activity but are NOT witnessed", () => {
    const facts = buildTrackFacts("t1", vocalRead(0.2), 240_000);
    const result = facts.vocals.vocalActivityIn(0, 500);
    expect(result.mean).toBeCloseTo(0.8);
    expect(result.witnessed).toBe(false);
  });

  it("a span with no covering windows is unwitnessed, not silent", () => {
    const facts = buildTrackFacts("t1", vocalRead(0.9), 240_000);
    const result = facts.vocals.vocalActivityIn(60_000, 120_000);
    expect(result).toEqual({ mean: 0, confidence: 0, witnessed: false });
  });

  it("partial coverage below the line is unwitnessed", () => {
    const facts = buildTrackFacts("t1", vocalRead(0.9), 240_000);
    // Only the first 500 ms of this 60 s span is covered.
    expect(facts.vocals.vocalActivityIn(0, 60_000).witnessed).toBe(false);
  });
});

describe("buildTrackFacts — grid, phrases, energy, loops, trust", () => {
  it("phrases are 4-bar groups from the grid (16 beats at 4/4)", () => {
    const facts = buildTrackFacts("t1", makeRead(), 240_000);
    expect(facts.phrases[0]).toEqual({
      startMs: 0,
      endMs: 8_000,
      startBeat: 0,
      endBeat: 16,
    });
    expect(facts.phrases[1]).toEqual({
      startMs: 8_000,
      endMs: 16_000,
      startBeat: 16,
      endBeat: 32,
    });
  });

  it("energyAt and windowMeanEnergy read the contour bins", () => {
    const read = makeRead({
      energyContour: [
        { atMs: 0, rms: 0.1 },
        { atMs: 250, rms: 0.3 },
        { atMs: 500, rms: 0.5 },
        { atMs: 750, rms: 0.7 },
      ],
    });
    const facts = buildTrackFacts("t1", read, 240_000);
    expect(facts.energyContour.energyAt(300)).toBe(0.3);
    expect(facts.energyContour.windowMeanEnergy(0, 1000)).toBeCloseTo(0.4);
  });

  it("loopSpans keep only breakdown/outro sections of >= 8 beats", () => {
    const read = makeRead({
      sections: [
        // 20 s at 120 bpm = 40 beats — loopable.
        { kind: "breakdown", startMs: 0, endMs: 20_000, meanEnergy: 0.05 },
        // 2 s = 4 beats — too short.
        { kind: "breakdown", startMs: 20_000, endMs: 22_000, meanEnergy: 0.05 },
        // Long enough but the wrong kind.
        { kind: "chorus", startMs: 22_000, endMs: 60_000, meanEnergy: 0.3 },
        // 10 s outro = 20 beats — loopable.
        { kind: "outro", startMs: 60_000, endMs: 70_000, meanEnergy: 0.05 },
      ],
    });
    const facts = buildTrackFacts("t1", read, 240_000);
    expect(facts.loopSpans).toEqual([
      { startMs: 0, endMs: 20_000 },
      { startMs: 60_000, endMs: 70_000 },
    ]);
  });

  it("beatmatchTrusted follows the 0.12 / 0.15 trust lines", () => {
    expect(buildTrackFacts("t1", makeRead(), 240_000).beatmatchTrusted).toBe(
      true,
    );
    const lowTempo = makeRead({ tempoConfidence: 0.1 });
    expect(buildTrackFacts("t1", lowTempo, 240_000).beatmatchTrusted).toBe(
      false,
    );
    const lowGrid = makeRead({
      grid: {
        beatsMs: beatsEvery(500, 481),
        downbeatsMs: beatsEvery(2000, 121),
        beatsPerBar: 4,
        confidence: 0.1,
      },
    });
    expect(buildTrackFacts("t1", lowGrid, 240_000).beatmatchTrusted).toBe(
      false,
    );
  });

  it("drops come back in chronological order", () => {
    const read = makeRead({
      drops: [
        { atMs: 90_000, strength: 2.5 },
        { atMs: 30_000, strength: 3.5 },
      ],
    });
    expect(buildTrackFacts("t1", read, 240_000).drops).toEqual([
      { atMs: 30_000, strength: 3.5 },
      { atMs: 90_000, strength: 2.5 },
    ]);
  });
});

describe("keyFitBetween / keyFitTo — fresh Camelot math", () => {
  const cMajor = {
    tonic: 0,
    mode: "major" as const,
    camelot: "8B",
    confidence: 0.9,
  };
  const aMinor = {
    tonic: 9,
    mode: "minor" as const,
    camelot: "8A",
    confidence: 0.9,
  };
  const gMajor = {
    tonic: 7,
    mode: "major" as const,
    camelot: "9B",
    confidence: 0.9,
  };
  const cMinor = {
    tonic: 0,
    mode: "minor" as const,
    camelot: "5A",
    confidence: 0.9,
  };
  const ebMajor = {
    tonic: 3,
    mode: "major" as const,
    camelot: "5B",
    confidence: 0.9,
  };

  it("same key scores 1, relative 0.9, adjacent 0.85, parallel 0.5", () => {
    expect(keyFitBetween(cMajor, cMajor)).toEqual({
      score: 1,
      relation: "same",
      compatible: true,
    });
    expect(keyFitBetween(cMajor, aMinor)).toEqual({
      score: 0.9,
      relation: "relative",
      compatible: true,
    });
    expect(keyFitBetween(cMajor, gMajor)).toEqual({
      score: 0.85,
      relation: "adjacent",
      compatible: true,
    });
    expect(keyFitBetween(cMajor, cMinor)).toEqual({
      score: 0.5,
      relation: "parallel",
      compatible: false,
    });
  });

  it("far-apart keys are distant; unknown keys fit to null, not a clash", () => {
    expect(keyFitBetween(cMajor, ebMajor)?.relation).toBe("distant");
    expect(keyFitBetween(cMajor, null)).toBeNull();
    expect(keyFitBetween(null, aMinor)).toBeNull();
  });

  it("facts.keyFitTo compares against another track's facts", () => {
    const a = buildTrackFacts("a", makeRead(), 240_000);
    const b = buildTrackFacts(
      "b",
      makeRead({
        key: { tonic: 9, mode: "minor", camelot: "8A", confidence: 0.7 },
      }),
      240_000,
    );
    expect(a.keyFitTo(b)).toEqual({
      score: 0.9,
      relation: "relative",
      compatible: true,
    });
    const keyless = buildTrackFacts("c", null, 240_000);
    expect(a.keyFitTo(keyless)).toBeNull();
  });
});
