import { describe, expect, it } from "vitest";
import type { BeatMap } from "./beatMap";
import {
  expandJugglePerformance,
  validateJugglePerformance,
  type JugglePerformance,
} from "./juggle";

// The revamp's J3 — beat juggling as data. Expansion is grid-true
// (every start read off the track's own beat map) and validation
// carries the plan's named non-goals as mechanics, not labels: a
// performance that never changes deck — a loop repeat wearing the
// juggle's name — is refused by the alternation check, and the
// v1 bounds (3–5 segments, at most 8 beats in total) are enforced
// on the data before any executor or session code sees it.

const flat120: BeatMap = {
  bpm: 120,
  firstBeatSec: 0,
  beatsPerBar: 4,
  durationSec: 240,
};

describe("juggle — expansion", () => {
  it("repeat re-cues the same span on alternating decks and exits at the break's own end", () => {
    const p = expandJugglePerformance({
      pattern: "repeat",
      breakStartBeat: 32,
      segmentBeats: 2,
      segmentCount: 3,
      firstDeck: 0,
      beatMap: flat120,
    });
    expect(p.breakStartSec).toBe(16);
    expect(p.secPerBeat).toBe(0.5);
    expect(p.segments).toEqual([
      { deck: 0, startSec: 16, beats: 2 },
      { deck: 1, startSec: 16, beats: 2 },
      { deck: 0, startSec: 16, beats: 2 },
    ]);
    // Track time across the window is the break's span exactly
    // once: the track resumes where the break would have ended.
    expect(p.exitSec).toBe(17);
    expect(validateJugglePerformance(p, 240)).toEqual([]);
  });

  it("continue walks forward through consecutive spans and exits where the walk ends", () => {
    const p = expandJugglePerformance({
      pattern: "continue",
      breakStartBeat: 32,
      segmentBeats: 2,
      segmentCount: 4,
      firstDeck: 0,
      beatMap: flat120,
    });
    expect(p.segments.map((s) => s.startSec)).toEqual([16, 17, 18, 19]);
    expect(p.segments.map((s) => s.deck)).toEqual([0, 1, 0, 1]);
    expect(p.exitSec).toBe(20);
    expect(validateJugglePerformance(p, 240)).toEqual([]);
  });

  it("the first deck is a role: starting on deck 1 flips every segment", () => {
    const p = expandJugglePerformance({
      pattern: "repeat",
      breakStartBeat: 32,
      segmentBeats: 2,
      segmentCount: 3,
      firstDeck: 1,
      beatMap: flat120,
    });
    expect(p.segments.map((s) => s.deck)).toEqual([1, 0, 1]);
    expect(validateJugglePerformance(p, 240)).toEqual([]);
  });

  it("segmentBeats defaults to 2", () => {
    const p = expandJugglePerformance({
      pattern: "repeat",
      breakStartBeat: 32,
      segmentCount: 3,
      firstDeck: 0,
      beatMap: flat120,
    });
    expect(p.segmentBeats).toBe(2);
    expect(p.segments.every((s) => s.beats === 2)).toBe(true);
  });

  it("expansion reads a bending grid, and the result still validates", () => {
    // Anchors drift late: beat 34 falls at 17.4 s, not the rigid
    // grid's 17.0 — a continue walk must follow the grid.
    const bending: BeatMap = {
      ...flat120,
      grid: {
        anchors: [
          { beat: 0, timeSec: 0, confidence: 1 },
          { beat: 32, timeSec: 16, confidence: 1 },
          { beat: 34, timeSec: 17.4, confidence: 1 },
          { beat: 36, timeSec: 18.6, confidence: 1 },
          { beat: 40, timeSec: 20.6, confidence: 1 },
        ],
        sections: [],
        confidence: 1,
      },
    };
    const p = expandJugglePerformance({
      pattern: "continue",
      breakStartBeat: 32,
      segmentBeats: 2,
      segmentCount: 3,
      firstDeck: 0,
      beatMap: bending,
    });
    expect(p.segments.map((s) => s.startSec)).toEqual([16, 17.4, 18.6]);
    expect(p.exitSec).toBeCloseTo(19.6, 9);
    expect(validateJugglePerformance(p, 240)).toEqual([]);
  });
});

describe("juggle — validation", () => {
  const sound = (): JugglePerformance =>
    expandJugglePerformance({
      pattern: "repeat",
      breakStartBeat: 32,
      segmentBeats: 2,
      segmentCount: 3,
      firstDeck: 0,
      beatMap: flat120,
    });

  it("refuses fewer than 3 or more than 5 segments", () => {
    const two = sound();
    two.segments = two.segments.slice(0, 2);
    expect(validateJugglePerformance(two, 240).join(" ")).toMatch(/segments/);
    const six = expandJugglePerformance({
      pattern: "repeat",
      breakStartBeat: 32,
      segmentBeats: 1,
      segmentCount: 6,
      firstDeck: 0,
      beatMap: flat120,
    });
    expect(validateJugglePerformance(six, 240).join(" ")).toMatch(/segments/);
  });

  it("refuses a performance spanning more than 8 beats in total", () => {
    const wide = expandJugglePerformance({
      pattern: "continue",
      breakStartBeat: 32,
      segmentBeats: 2,
      segmentCount: 5,
      firstDeck: 0,
      beatMap: flat120,
    });
    expect(validateJugglePerformance(wide, 240).join(" ")).toMatch(
      /at most 8 beats/,
    );
  });

  it("refuses the named non-goal: segments that never change deck", () => {
    // A loop repeat labelled a juggle: the same span, cued again
    // and again on ONE deck. The alternation check refuses it at
    // the data layer — no executor path can perform it.
    const loopInJuggleClothing = sound();
    loopInJuggleClothing.segments = loopInJuggleClothing.segments.map((s) => ({
      ...s,
      deck: 0 as const,
    }));
    const errors = validateJugglePerformance(loopInJuggleClothing, 240);
    expect(errors.join(" ")).toMatch(/alternates decks/);
  });

  it("refuses a segment that runs past the track's end", () => {
    const late = expandJugglePerformance({
      pattern: "continue",
      breakStartBeat: 32,
      segmentBeats: 2,
      segmentCount: 3,
      firstDeck: 0,
      beatMap: flat120,
    });
    // The break itself is inside a 17.5 s track; the walk is not.
    expect(validateJugglePerformance(late, 17.5).join(" ")).toMatch(
      /past the track/,
    );
  });

  it("refuses an exit that is not the final segment's own end", () => {
    const p = sound();
    p.exitSec = 20;
    expect(validateJugglePerformance(p, 240).join(" ")).toMatch(/exitSec/);
  });

  it("refuses a repeat whose segments do not re-cue the same span", () => {
    const p = sound();
    p.segments[1] = { ...p.segments[1], startSec: 18 };
    expect(validateJugglePerformance(p, 240).join(" ")).toMatch(/re-cues/);
  });

  it("refuses a continue whose segments gap or overlap", () => {
    const p = expandJugglePerformance({
      pattern: "continue",
      breakStartBeat: 32,
      segmentBeats: 2,
      segmentCount: 3,
      firstDeck: 0,
      beatMap: flat120,
    });
    p.segments[2] = { ...p.segments[2], startSec: 19.5 };
    // Keep the exit consistent with the moved final segment so
    // only the walk check can fire.
    p.exitSec = 20.5;
    expect(validateJugglePerformance(p, 240).join(" ")).toMatch(
      /walks forward/,
    );
  });

  it("refuses fractional or empty segments and a negative break", () => {
    const fractional = sound();
    fractional.segmentBeats = 1.5;
    fractional.segments = fractional.segments.map((s) => ({
      ...s,
      beats: 1.5,
    }));
    expect(validateJugglePerformance(fractional, 240).length).toBeGreaterThan(
      0,
    );
    const negative = sound();
    negative.breakStartSec = -1;
    negative.segments = negative.segments.map((s) => ({
      ...s,
      startSec: -1,
    }));
    expect(validateJugglePerformance(negative, 240).length).toBeGreaterThan(0);
  });
});
