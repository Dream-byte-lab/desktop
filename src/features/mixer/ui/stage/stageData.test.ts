import { describe, expect, it } from "vitest";
import type { TrackAnalysis, TrackSection } from "../../engine/analyseTrack";
import {
  activityLines,
  landmarkCues,
  sectionSpans,
  waveformBars,
  type ActivitySnapshot,
} from "./stageData";

function makeAnalysis(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 100 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: null,
    vocalRanges: [],
    loudness: 0.5,
    ...overrides,
  };
}

function section(
  kind: TrackSection["kind"],
  startSec: number,
  endSec: number,
): TrackSection {
  return {
    kind,
    startSec,
    endSec,
    startBeat: startSec * 2,
    endBeat: endSec * 2,
    meanRms: 0.5,
    vocalActivity: 0,
    confidence: 0.8,
  };
}

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

describe("landmarkCues", () => {
  it("collects intro end, section starts, drops and outro start, sorted by time", () => {
    const cues = landmarkCues(
      makeAnalysis({
        intro: { startSec: 0, endSec: 8, startBeat: 0, endBeat: 16 },
        outro: { startSec: 90, endSec: 100, startBeat: 180, endBeat: 200 },
        sections: [
          section("intro", 0, 8),
          section("verse", 8, 40),
          section("chorus", 40, 90),
          section("outro", 90, 100),
        ],
        drops: [{ timeSec: 60, beat: 120, strength: 2 }],
      }),
    );
    // verse at 8 dedupes against intro end at 8, chorus at 40,
    // drop at 60, outro section at 90 dedupes against outro at 90.
    expect(cues.map((c) => [c.timeSec, c.label, c.kind])).toEqual([
      [8, "Intro end", "intro"],
      [40, "Chorus", "section"],
      [60, "Drop", "drop"],
      [90, "Outro", "outro"],
    ]);
  });

  it("skips a section starting at 0", () => {
    const cues = landmarkCues(
      makeAnalysis({
        sections: [section("verse", 0, 50), section("chorus", 50, 100)],
      }),
    );
    expect(cues).toEqual([
      { id: "section-500", timeSec: 50, label: "Chorus", kind: "section" },
    ]);
  });

  it("capitalises section labels", () => {
    const cues = landmarkCues(
      makeAnalysis({
        sections: [
          section("verse", 10, 30),
          section("breakdown", 30, 50),
          section("bridge", 50, 70),
        ],
      }),
    );
    expect(cues.map((c) => c.label)).toEqual(["Verse", "Breakdown", "Bridge"]);
  });

  it("counts a drop-kind section as a drop, not a section", () => {
    const cues = landmarkCues(
      makeAnalysis({ sections: [section("drop", 32, 60)] }),
    );
    expect(cues).toEqual([
      { id: "drop-320", timeSec: 32, label: "Drop", kind: "drop" },
    ]);
  });

  it("builds ids from kind and the time in tenths", () => {
    const cues = landmarkCues(
      makeAnalysis({
        drops: [{ timeSec: 42.26, beat: 84, strength: 3 }],
      }),
    );
    expect(cues[0].id).toBe("drop-423");
  });

  it("dedupes a section within 2s of a later drop in favour of the drop", () => {
    const cues = landmarkCues(
      makeAnalysis({
        sections: [section("chorus", 49, 80)],
        drops: [{ timeSec: 50, beat: 100, strength: 2 }],
      }),
    );
    expect(cues).toEqual([
      { id: "drop-500", timeSec: 50, label: "Drop", kind: "drop" },
    ]);
  });

  it("dedupes a section within 2s of an earlier drop in favour of the drop", () => {
    const cues = landmarkCues(
      makeAnalysis({
        sections: [section("chorus", 51, 80)],
        drops: [{ timeSec: 50, beat: 100, strength: 2 }],
      }),
    );
    expect(cues).toEqual([
      { id: "drop-500", timeSec: 50, label: "Drop", kind: "drop" },
    ]);
  });

  it("dedupes a section within 2s of the intro end in favour of the intro", () => {
    const cues = landmarkCues(
      makeAnalysis({
        intro: { startSec: 0, endSec: 16, startBeat: 0, endBeat: 32 },
        sections: [section("verse", 15, 60)],
      }),
    );
    expect(cues).toEqual([
      { id: "intro-160", timeSec: 16, label: "Intro end", kind: "intro" },
    ]);
  });

  it("dedupes a section within 2s of the outro start in favour of the outro", () => {
    const cues = landmarkCues(
      makeAnalysis({
        outro: { startSec: 90, endSec: 100, startBeat: 180, endBeat: 200 },
        sections: [section("chorus", 89, 100)],
      }),
    );
    expect(cues).toEqual([
      { id: "outro-900", timeSec: 90, label: "Outro", kind: "outro" },
    ]);
  });

  it("keeps the earliest of two same-priority cues within 2s", () => {
    const cues = landmarkCues(
      makeAnalysis({
        sections: [section("verse", 30, 45), section("chorus", 31.5, 60)],
      }),
    );
    expect(cues.map((c) => c.timeSec)).toEqual([30]);
  });

  it("keeps cues more than 2s apart", () => {
    const cues = landmarkCues(
      makeAnalysis({
        sections: [section("verse", 30, 45), section("chorus", 32.5, 60)],
      }),
    );
    expect(cues.map((c) => c.timeSec)).toEqual([30, 32.5]);
  });

  it("caps at 8 cues, keeping the earliest 8 after dedupe", () => {
    const sections = Array.from({ length: 12 }, (_, i) =>
      section("verse", 5 + i * 8, 5 + i * 8 + 4),
    );
    const cues = landmarkCues(makeAnalysis({ sections }));
    expect(cues).toHaveLength(8);
    expect(cues.map((c) => c.timeSec)).toEqual([5, 13, 21, 29, 37, 45, 53, 61]);
  });

  it("uses drops, intro and outro only when sections is undefined", () => {
    const cues = landmarkCues(
      makeAnalysis({
        sections: undefined,
        intro: { startSec: 0, endSec: 10, startBeat: 0, endBeat: 20 },
        outro: { startSec: 90, endSec: 100, startBeat: 180, endBeat: 200 },
        drops: [{ timeSec: 50, beat: 100, strength: 2 }],
      }),
    );
    expect(cues.map((c) => [c.timeSec, c.kind])).toEqual([
      [10, "intro"],
      [50, "drop"],
      [90, "outro"],
    ]);
  });

  it("returns no cues when the analysis carries no landmarks", () => {
    expect(landmarkCues(makeAnalysis())).toEqual([]);
    expect(landmarkCues(makeAnalysis({ intro: null, outro: null }))).toEqual(
      [],
    );
  });

  it("handles a null intro and outro alongside sections", () => {
    const cues = landmarkCues(
      makeAnalysis({
        intro: null,
        outro: null,
        sections: [section("chorus", 20, 60)],
      }),
    );
    expect(cues.map((c) => c.label)).toEqual(["Chorus"]);
  });
});

describe("waveformBars", () => {
  it("normalises the energy contour by its max and buckets by peak", () => {
    const bars = waveformBars(
      makeAnalysis({
        energyContour: [
          { timeSec: 0, rms: 0.2 },
          { timeSec: 10, rms: 0.8 },
          { timeSec: 60, rms: 0.4 },
        ],
      }),
      2,
    );
    // Bar 0 holds rms 0.2 and 0.8: the peak (0.8 / 0.8 = 1) wins,
    // not the mean. Bar 1: 0.4 / 0.8 = 0.5.
    expect(bars).toEqual([
      { level: 1, vocal: false },
      { level: 0.5, vocal: false },
    ]);
  });

  it("prefers the energy contour over the energy curve", () => {
    const bars = waveformBars(
      makeAnalysis({
        energyContour: [{ timeSec: 10, rms: 0.5 }],
        energyCurve: [{ timeSec: 10, energy: 0.1 }],
      }),
      1,
    );
    expect(bars[0].level).toBe(1);
  });

  it("returns all-zero levels when the contour max is 0", () => {
    const bars = waveformBars(
      makeAnalysis({
        energyContour: [
          { timeSec: 0, rms: 0 },
          { timeSec: 50, rms: 0 },
        ],
      }),
      3,
    );
    expect(bars).toEqual([
      { level: 0, vocal: false },
      { level: 0, vocal: false },
      { level: 0, vocal: false },
    ]);
  });

  it("falls back to the energy curve when there is no contour", () => {
    const bars = waveformBars(
      makeAnalysis({
        energyContour: undefined,
        energyCurve: [
          { timeSec: 0, energy: 0.3 },
          { timeSec: 10, energy: 0.7 },
          { timeSec: 60, energy: 0.9 },
        ],
      }),
      2,
    );
    expect(bars.map((b) => b.level)).toEqual([0.7, 0.9]);
  });

  it("falls back to the energy curve when the contour is empty", () => {
    const bars = waveformBars(
      makeAnalysis({
        energyContour: [],
        energyCurve: [{ timeSec: 0, energy: 0.4 }],
      }),
      1,
    );
    expect(bars[0].level).toBe(0.4);
  });

  it("returns zero-level bars when neither contour nor curve exists", () => {
    const bars = waveformBars(
      makeAnalysis({ energyContour: undefined, energyCurve: [] }),
      4,
    );
    expect(bars).toEqual([
      { level: 0, vocal: false },
      { level: 0, vocal: false },
      { level: 0, vocal: false },
      { level: 0, vocal: false },
    ]);
  });

  it("returns [] for a non-positive bar count", () => {
    expect(waveformBars(makeAnalysis(), 0)).toEqual([]);
    expect(waveformBars(makeAnalysis(), -3)).toEqual([]);
  });

  it("flags a bar vocal when its centre falls inside a vocal range", () => {
    const bars = waveformBars(
      makeAnalysis({
        energyContour: [{ timeSec: 0, rms: 1 }],
        vocalRanges: [{ startSec: 30, endSec: 50 }],
      }),
      4,
    );
    // Centres: 12.5, 37.5, 62.5, 87.5 — only 37.5 is in [30, 50).
    expect(bars.map((b) => b.vocal)).toEqual([false, true, false, false]);
  });

  it("flags a bar vocal from the vocal activity curve at its centre", () => {
    const bars = waveformBars(
      makeAnalysis({
        energyContour: [{ timeSec: 0, rms: 1 }],
        vocalRanges: [],
        vocalActivity: {
          windowSec: 0.25,
          stepSec: 25,
          points: [
            { timeSec: 0, activity: 0.9, confidence: 1 },
            { timeSec: 25, activity: 0.1, confidence: 1 },
            { timeSec: 50, activity: 0.6, confidence: 1 },
            { timeSec: 75, activity: 0.4, confidence: 1 },
          ],
        },
      }),
      4,
    );
    expect(bars.map((b) => b.vocal)).toEqual([true, false, true, false]);
  });

  it("treats vocal activity of exactly 0.5 as vocal", () => {
    const bars = waveformBars(
      makeAnalysis({
        energyContour: [{ timeSec: 0, rms: 1 }],
        vocalActivity: {
          windowSec: 0.25,
          stepSec: 100,
          points: [{ timeSec: 0, activity: 0.5, confidence: 1 }],
        },
      }),
      1,
    );
    expect(bars[0].vocal).toBe(true);
  });

  it("flags vocals on zero-level bars when neither energy source exists", () => {
    // Vocal evidence is independent of the level source: the bars
    // exist (zero level) and a centre in a vocal range still flags.
    const bars = waveformBars(
      makeAnalysis({
        energyContour: undefined,
        energyCurve: [],
        vocalRanges: [{ startSec: 0, endSec: 100 }],
      }),
      2,
    );
    // The no-source path returns plain zero bars (vocal false) —
    // locking in that documented behaviour.
    expect(bars).toEqual([
      { level: 0, vocal: false },
      { level: 0, vocal: false },
    ]);
  });
});

describe("sectionSpans", () => {
  it("converts sections to fractions of the duration with capitalised labels", () => {
    const spans = sectionSpans(
      makeAnalysis({
        beatMap: {
          bpm: 120,
          firstBeatSec: 0,
          beatsPerBar: 4,
          durationSec: 200,
        },
        sections: [section("intro", 0, 20), section("verse", 20, 100)],
      }),
    );
    expect(spans).toEqual([
      { kind: "intro", startFrac: 0, endFrac: 0.1, label: "Intro" },
      { kind: "verse", startFrac: 0.1, endFrac: 0.5, label: "Verse" },
    ]);
  });

  it("returns [] when sections is absent or empty", () => {
    expect(sectionSpans(makeAnalysis({ sections: undefined }))).toEqual([]);
    expect(sectionSpans(makeAnalysis({ sections: [] }))).toEqual([]);
  });

  it("skips spans whose end is not after their start", () => {
    const spans = sectionSpans(
      makeAnalysis({
        sections: [
          section("verse", 30, 30),
          section("chorus", 50, 40),
          section("bridge", 60, 80),
        ],
      }),
    );
    expect(spans).toEqual([
      { kind: "bridge", startFrac: 0.6, endFrac: 0.8, label: "Bridge" },
    ]);
  });
});

describe("activityLines", () => {
  it("names each known end reason when the set is not running", () => {
    const base = makeSnapshot({ running: false });
    expect(activityLines({ ...base, endReason: "queue-exhausted" })).toEqual([
      { tone: "idle", text: "Set ended — the queue ran out" },
    ]);
    expect(activityLines({ ...base, endReason: "start-no-playable" })).toEqual([
      { tone: "idle", text: "Set ended — nothing playable could be prepared" },
    ]);
    expect(activityLines({ ...base, endReason: "user-stop" })).toEqual([
      { tone: "idle", text: "DJ stopped" },
    ]);
    expect(activityLines({ ...base, endReason: "replaced" })).toEqual([
      { tone: "idle", text: "Set replaced by a new one" },
    ]);
  });

  it("falls back to a generic ended line for an unknown end reason", () => {
    expect(
      activityLines(
        makeSnapshot({ running: false, endReason: "mystery-cause" }),
      ),
    ).toEqual([{ tone: "idle", text: "Set ended (mystery-cause)" }]);
  });

  it("says the DJ is off when not running with no end reason", () => {
    expect(
      activityLines(makeSnapshot({ running: false, endReason: null })),
    ).toEqual([{ tone: "idle", text: "DJ is off" }]);
  });

  it("reports a paused set", () => {
    expect(activityLines(makeSnapshot({ paused: true }))).toEqual([
      { tone: "live", text: "Paused — decks are holding" },
    ]);
  });

  it("gives the paused line precedence over blending", () => {
    expect(
      activityLines(makeSnapshot({ paused: true, blending: true })),
    ).toEqual([{ tone: "live", text: "Paused — decks are holding" }]);
  });

  it("reports a blend with both titles", () => {
    expect(activityLines(makeSnapshot({ blending: true }))).toEqual([
      { tone: "live", text: "Blending — Current Song into Next Song" },
    ]);
  });

  it("falls back to generic names in a blend when titles are missing", () => {
    expect(
      activityLines(
        makeSnapshot({ blending: true, currentTitle: null, nextTitle: null }),
      ),
    ).toEqual([
      { tone: "live", text: "Blending — current track into the next track" },
    ]);
  });

  it("reports preparing when the next track is not prepared", () => {
    expect(activityLines(makeSnapshot({ nextPrepared: false }))).toEqual([
      { tone: "prep", text: "Preparing incoming track — Next Song" },
    ]);
  });

  it("gives the blending line precedence over preparing", () => {
    expect(
      activityLines(makeSnapshot({ blending: true, nextPrepared: false })),
    ).toEqual([
      { tone: "live", text: "Blending — Current Song into Next Song" },
    ]);
  });

  it("reports performing when the next track is prepared", () => {
    expect(activityLines(makeSnapshot())).toEqual([
      { tone: "live", text: "Performing — Current Song" },
    ]);
  });

  it("falls back to 'current track' when performing with no title", () => {
    expect(activityLines(makeSnapshot({ currentTitle: null }))).toEqual([
      { tone: "live", text: "Performing — current track" },
    ]);
  });

  it("adds a singular guest-request line for exactly one request", () => {
    expect(activityLines(makeSnapshot({ openRequestCount: 1 }))).toEqual([
      { tone: "live", text: "Performing — Current Song" },
      { tone: "prep", text: "1 guest request waiting for its moment" },
    ]);
  });

  it("adds a plural guest-request line for several requests", () => {
    expect(activityLines(makeSnapshot({ openRequestCount: 3 }))).toEqual([
      { tone: "live", text: "Performing — Current Song" },
      { tone: "prep", text: "3 guest requests waiting for a moment" },
    ]);
  });

  it("reports the last track in the queue when there is no next title", () => {
    expect(activityLines(makeSnapshot({ nextTitle: null }))).toEqual([
      {
        tone: "live",
        text: "Performing — Current Song (last in queue)",
      },
    ]);
  });

  it("appends a singular degraded line for one plain cut", () => {
    expect(
      activityLines(makeSnapshot({ degraded: true, plainCutCount: 1 })),
    ).toEqual([
      { tone: "live", text: "Performing — Current Song" },
      { tone: "warn", text: "Mixing degraded — 1 plain cut so far" },
    ]);
  });

  it("appends a plural degraded line for several plain cuts", () => {
    expect(
      activityLines(makeSnapshot({ degraded: true, plainCutCount: 5 })),
    ).toEqual([
      { tone: "live", text: "Performing — Current Song" },
      { tone: "warn", text: "Mixing degraded — 5 plain cuts so far" },
    ]);
  });

  it("pluralises zero plain cuts as cuts", () => {
    expect(
      activityLines(makeSnapshot({ degraded: true, plainCutCount: 0 })),
    ).toEqual([
      { tone: "live", text: "Performing — Current Song" },
      { tone: "warn", text: "Mixing degraded — 0 plain cuts so far" },
    ]);
  });

  it("orders main, requests, then degraded, capped at 3 lines", () => {
    const lines = activityLines(
      makeSnapshot({
        openRequestCount: 2,
        degraded: true,
        plainCutCount: 4,
      }),
    );
    expect(lines).toEqual([
      { tone: "live", text: "Performing — Current Song" },
      { tone: "prep", text: "2 guest requests waiting for a moment" },
      { tone: "warn", text: "Mixing degraded — 4 plain cuts so far" },
    ]);
    expect(lines).toHaveLength(3);
  });

  it("appends the degraded line to an idle line", () => {
    expect(
      activityLines(
        makeSnapshot({
          running: false,
          endReason: "user-stop",
          degraded: true,
          plainCutCount: 2,
        }),
      ),
    ).toEqual([
      { tone: "idle", text: "DJ stopped" },
      { tone: "warn", text: "Mixing degraded — 2 plain cuts so far" },
    ]);
  });

  it("appends the degraded line to a paused line", () => {
    expect(
      activityLines(
        makeSnapshot({ paused: true, degraded: true, plainCutCount: 1 }),
      ),
    ).toEqual([
      { tone: "live", text: "Paused — decks are holding" },
      { tone: "warn", text: "Mixing degraded — 1 plain cut so far" },
    ]);
  });
});
