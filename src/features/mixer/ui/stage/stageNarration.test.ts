import { describe, expect, it } from "vitest";
import {
  activityLines,
  activityLinesForStage,
  type ActivitySnapshot,
} from "./stageData";
import { midBlendFixture } from "./stageFixtures";
import type { StageCurrentMove } from "./stageSnapshot";

function makeSnapshot(
  overrides: Partial<ActivitySnapshot> = {},
): ActivitySnapshot {
  return {
    running: true,
    paused: false,
    blending: false,
    degraded: false,
    plainCutCount: 0,
    currentTitle: "Current Song",
    nextTitle: "Next Song",
    nextPrepared: true,
    openRequestCount: 0,
    endReason: null,
    ...overrides,
  };
}

const chirpMove: StageCurrentMove = {
  label: "Performing a chirp scratch",
  family: "scratch",
  technique: "chirp",
};

describe("activityLinesForStage — fallback battery", () => {
  const shapes: Array<[string, ActivitySnapshot]> = [
    ["not running, no end reason", makeSnapshot({ running: false })],
    [
      "not running, queue exhausted",
      makeSnapshot({ running: false, endReason: "queue-exhausted" }),
    ],
    [
      "not running, user stop",
      makeSnapshot({ running: false, endReason: "user-stop" }),
    ],
    [
      "not running, unknown end reason",
      makeSnapshot({ running: false, endReason: "mystery-cause" }),
    ],
    ["paused", makeSnapshot({ paused: true })],
    ["paused and blending", makeSnapshot({ paused: true, blending: true })],
    ["blending", makeSnapshot({ blending: true })],
    ["preparing", makeSnapshot({ nextPrepared: false })],
    ["performing", makeSnapshot()],
    ["performing with one request", makeSnapshot({ openRequestCount: 1 })],
    ["performing with several requests", makeSnapshot({ openRequestCount: 3 })],
    ["last in queue", makeSnapshot({ nextTitle: null })],
    [
      "degraded, one plain cut",
      makeSnapshot({ degraded: true, plainCutCount: 1 }),
    ],
    [
      "degraded, several plain cuts",
      makeSnapshot({ degraded: true, plainCutCount: 5 }),
    ],
    [
      "degraded while blending",
      makeSnapshot({ blending: true, degraded: true, plainCutCount: 2 }),
    ],
    [
      "degraded while not running",
      makeSnapshot({
        running: false,
        endReason: "user-stop",
        degraded: true,
        plainCutCount: 2,
      }),
    ],
    [
      "degraded while paused",
      makeSnapshot({ paused: true, degraded: true, plainCutCount: 1 }),
    ],
    [
      "performing with requests and degraded",
      makeSnapshot({
        openRequestCount: 2,
        degraded: true,
        plainCutCount: 4,
      }),
    ],
  ];

  for (const [name, snapshot] of shapes) {
    it(`falls back to activityLines for ${name} when move is null`, () => {
      expect(activityLinesForStage(snapshot, null)).toEqual(
        activityLines(snapshot),
      );
    });

    it(`falls back to activityLines for ${name} when move is undefined`, () => {
      expect(activityLinesForStage(snapshot, undefined)).toEqual(
        activityLines(snapshot),
      );
    });
  }

  it("falls back when the move label is empty", () => {
    const snapshot = makeSnapshot();
    const move: StageCurrentMove = { label: "", family: null, technique: null };
    expect(activityLinesForStage(snapshot, move)).toEqual(
      activityLines(snapshot),
    );
  });

  it("falls back when the move label is whitespace-only", () => {
    const snapshot = makeSnapshot();
    for (const label of [" ", "   ", "\t", " \n "]) {
      const move: StageCurrentMove = {
        label,
        family: "scratch",
        technique: "chirp",
      };
      expect(activityLinesForStage(snapshot, move)).toEqual(
        activityLines(snapshot),
      );
    }
  });

  it("falls back when a move is supplied while paused", () => {
    const snapshot = makeSnapshot({ paused: true });
    expect(activityLinesForStage(snapshot, chirpMove)).toEqual(
      activityLines(snapshot),
    );
  });

  it("falls back when a move is supplied while not running", () => {
    const withoutReason = makeSnapshot({ running: false });
    expect(activityLinesForStage(withoutReason, chirpMove)).toEqual(
      activityLines(withoutReason),
    );

    const withReason = makeSnapshot({
      running: false,
      endReason: "queue-exhausted",
    });
    expect(activityLinesForStage(withReason, chirpMove)).toEqual(
      activityLines(withReason),
    );
  });
});

describe("activityLinesForStage — move narration", () => {
  it("leads with the fixture move verbatim for the mid-blend fixture", () => {
    const lines = activityLinesForStage(
      midBlendFixture.activity,
      midBlendFixture.snapshot.currentMove,
    );
    expect(lines[0]).toEqual({
      tone: "live",
      text: "Performing a chirp scratch",
    });
  });

  it("renders the move label verbatim with no prefixing or paraphrase", () => {
    const snapshot = makeSnapshot({ blending: true });
    const lines = activityLinesForStage(snapshot, chirpMove);
    expect(lines).toEqual([
      { tone: "live", text: "Performing a chirp scratch" },
    ]);
  });

  it("supersedes the generic performing and request lines with the move line", () => {
    const snapshot = makeSnapshot({ openRequestCount: 3 });
    const lines = activityLinesForStage(snapshot, chirpMove);
    expect(lines).toEqual([
      { tone: "live", text: "Performing a chirp scratch" },
    ]);
  });

  it("retains the warn line after the move line when degraded", () => {
    const snapshot = makeSnapshot({ degraded: true, plainCutCount: 3 });
    const lines = activityLinesForStage(snapshot, chirpMove);
    expect(lines).toEqual([
      { tone: "live", text: "Performing a chirp scratch" },
      { tone: "warn", text: "Mixing degraded — 3 plain cuts so far" },
    ]);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("retains the warn line after the move line in a degraded blend", () => {
    const snapshot = makeSnapshot({
      blending: true,
      degraded: true,
      plainCutCount: 1,
    });
    const lines = activityLinesForStage(snapshot, chirpMove);
    expect(lines[0]).toEqual({
      tone: "live",
      text: "Performing a chirp scratch",
    });
    expect(lines[1]).toEqual({
      tone: "warn",
      text: "Mixing degraded — 1 plain cut so far",
    });
    expect(lines.length).toBeLessThanOrEqual(3);
  });
});
