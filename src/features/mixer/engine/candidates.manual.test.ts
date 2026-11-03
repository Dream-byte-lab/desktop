import { describe, expect, it } from "vitest";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import { STANDARD_PROFILE } from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { authorManualScratch, authorManualStopExit } from "./candidates";
import { validateRecipe } from "./recipe";
import type { RecipeRequest } from "./transitionPlanner";

// The manual authors (the DJ stage engine seams): the R1 stops
// and R2 scratches authored for the host's hand. The pins:
//   · the exit is HERE — at the position the trigger fires
//     from — not at the outro the brain's authors wait for;
//   · the brain's moment gates do NOT apply (no outro, no
//     falling energy, no price gate, no minimum-play floor);
//   · the structural gates DO: a landing to hand to, B able to
//     start early and silent, a spinback's runway, the window
//     fitting inside the track;
//   · a scratch keeps the R2 material gates whole — witnessed,
//     low-vocal, transient-rich — and performs the technique the
//     host NAMED, never a substitute chosen by an energy read.

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

/**
 * A 60 s outgoing at 120 bpm with NO outro at all and energy
 * RISING through the middle — the brain's stop authors refuse
 * this track outright; the manual author must not. The stretch
 * 20–30 s is witnessed, silent and stabby: scratch material.
 */
function outgoingNoOutro(): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 60 },
    tempoConfidence: 0.9,
    energyCurve: [],
    energyContour: Array.from({ length: 240 }, (_, i) => ({
      timeSec: i * 0.25,
      rms: i * 0.25 >= 20 && i * 0.25 < 30 ? (i % 8 === 0 ? 0.9 : 0.2) : 0.3,
    })),
    drops: [{ timeSec: 20, beat: 40, strength: 2 }],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: "hash-manual-a",
    sections: [
      section("intro", 0, 8, 0.15, 0),
      section("verse", 8, 24, 0.3, 0.85),
      section("chorus", 24, 44, 0.5, 0.9),
      section("chorus", 44, 60, 0.6, 0.9),
    ],
    vocalActivity: vocalCurve(60, (t) => (t >= 20 && t < 30 ? 0 : 0.9)),
  };
}

/** A 60 s incoming with real landings: an intro end and a drop. */
function incomingLandings(): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 60 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [{ timeSec: 16, beat: 32, strength: 2.4 }],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: "hash-manual-b",
    sections: [
      section("intro", 0, 8, 0.15, 0),
      section("chorus", 8, 32, 0.5, 0.9),
      section("verse", 32, 60, 0.3, 0.85),
    ],
    intro: { startSec: 0, endSec: 8, startBeat: 0, endBeat: 16 },
    vocalActivity: vocalCurve(60, (t) => (t < 8 ? 0 : 0.9)),
  };
}

/** An incoming whose only entry is mid-phrase — no landing anywhere. */
function incomingNoLanding(): TrackAnalysis {
  const analysis = incomingLandings();
  return {
    ...analysis,
    drops: [],
    sections: [],
    intro: undefined,
  };
}

function request(
  outgoing: TrackAnalysis,
  incoming: TrackAnalysis,
  positionSec: number,
): RecipeRequest {
  return { outgoing, outgoingPositionSec: positionSec, incoming };
}

describe("authorManualStopExit", () => {
  it("brakes from HERE, mid-track, with no outro anywhere", () => {
    const recipe = authorManualStopExit(
      request(outgoingNoOutro(), incomingLandings(), 30),
      STANDARD_PROFILE,
      "brake",
    );
    expect(recipe).not.toBeNull();
    expect(recipe!.overlap.startAMs).toBe(30_000);
    expect(recipe!.loops).toHaveLength(1);
    expect(recipe!.loops[0].type).toBe("brake");
    expect(recipe!.loops[0].side).toBe("A");
    // 4 beats at 120 bpm = 2 s of stop.
    expect(recipe!.loops[0].endMs - recipe!.loops[0].startMs).toBe(2000);
    expect(validateRecipe(recipe!)).toEqual([]);
  });

  it("vinyl-stops in one beat and spins back in two, as named", () => {
    const vinyl = authorManualStopExit(
      request(outgoingNoOutro(), incomingLandings(), 30),
      STANDARD_PROFILE,
      "vinyl-stop",
    );
    expect(vinyl!.loops[0].type).toBe("vinyl-stop");
    expect(vinyl!.loops[0].endMs - vinyl!.loops[0].startMs).toBe(500);

    const spin = authorManualStopExit(
      request(outgoingNoOutro(), incomingLandings(), 30),
      STANDARD_PROFILE,
      "spinback",
    );
    expect(spin!.loops[0].type).toBe("spinback");
    expect(spin!.loops[0].peakRate).toBe(-3.5);
    expect(spin!.loops[0].endMs - spin!.loops[0].startMs).toBe(1000);
  });

  it("B starts early and silent so its entry lands as the stop completes", () => {
    const recipe = authorManualStopExit(
      request(outgoingNoOutro(), incomingLandings(), 30),
      STANDARD_PROFILE,
      "brake",
    );
    // The entry (the drop at 16 s) minus the 2 s stop.
    expect(recipe!.overlap.startBMs).toBe(14_000);
  });

  it("refuses a spinback without runway behind the stop point", () => {
    // 1 s in: the spin needs 1 s × 2.5 + 2 = 4.5 s behind it.
    expect(
      authorManualStopExit(
        request(outgoingNoOutro(), incomingLandings(), 1),
        STANDARD_PROFILE,
        "spinback",
      ),
    ).toBeNull();
    // A brake from the same place is fine — no runway needed.
    expect(
      authorManualStopExit(
        request(outgoingNoOutro(), incomingLandings(), 1),
        STANDARD_PROFILE,
        "brake",
      ),
    ).not.toBeNull();
  });

  it("refuses when the incoming offers no landing", () => {
    expect(
      authorManualStopExit(
        request(outgoingNoOutro(), incomingNoLanding(), 30),
        STANDARD_PROFILE,
        "brake",
      ),
    ).toBeNull();
  });

  it("refuses when the move would end past the track's end", () => {
    // 59.5 s in, a 2 s brake ends at 61.5 — past the 60 s track.
    expect(
      authorManualStopExit(
        request(outgoingNoOutro(), incomingLandings(), 59.5),
        STANDARD_PROFILE,
        "brake",
      ),
    ).toBeNull();
  });

  it("refuses when B cannot start early enough for its entry", () => {
    // An incoming whose only landing is its intro end at 1 s:
    // a 2 s brake would need B to start at −1 s.
    const early = incomingLandings();
    early.intro = { startSec: 0, endSec: 1, startBeat: 0, endBeat: 2 };
    early.sections = [section("chorus", 1, 60, 0.5, 0.9)];
    early.drops = [];
    expect(
      authorManualStopExit(
        request(outgoingNoOutro(), early, 30),
        STANDARD_PROFILE,
        "brake",
      ),
    ).toBeNull();
  });
});

describe("authorManualScratch", () => {
  it("performs the NAMED technique on the window from here", () => {
    const recipe = authorManualScratch(
      request(outgoingNoOutro(), incomingLandings(), 21),
      STANDARD_PROFILE,
      "transformer",
    );
    expect(recipe).not.toBeNull();
    expect(recipe!.overlap.startAMs).toBe(21_000);
    const block = recipe!.loops[0];
    expect(block.type).toBe("scratch");
    expect(block.side).toBe("A");
    // The transformer keeps its own 4-beat shape — no energy
    // read substitutes a baby for it.
    expect(block.technique).toBe("transformer");
    expect(block.beats).toBe(4);
    expect(block.clicksPerBeat).toBe(2);
    expect(validateRecipe(recipe!)).toEqual([]);
  });

  it("scratches a baby across two beats of witnessed silent material", () => {
    const recipe = authorManualScratch(
      request(outgoingNoOutro(), incomingLandings(), 22),
      STANDARD_PROFILE,
      "baby",
    );
    expect(recipe).not.toBeNull();
    expect(recipe!.loops[0].technique).toBe("baby");
    expect(recipe!.loops[0].endMs - recipe!.loops[0].startMs).toBe(1000);
  });

  it("refuses a window over a lead vocal — the material gate stands", () => {
    // At 40 s the outgoing's vocal curve reads 0.9 throughout.
    expect(
      authorManualScratch(
        request(outgoingNoOutro(), incomingLandings(), 40),
        STANDARD_PROFILE,
        "baby",
      ),
    ).toBeNull();
  });

  it("refuses an unwitnessed window", () => {
    const outgoing = outgoingNoOutro();
    // No vocal curve and no sections: nothing witnesses the window.
    const blind: TrackAnalysis = {
      ...outgoing,
      vocalActivity: undefined,
      sections: undefined,
    };
    expect(
      authorManualScratch(
        request(blind, incomingLandings(), 22),
        STANDARD_PROFILE,
        "baby",
      ),
    ).toBeNull();
  });

  it("refuses a flat window — nothing for the hand to chop", () => {
    const outgoing = outgoingNoOutro();
    // Silent and witnessed, but the contour is a flat bed and no
    // drop stands at the window's edge.
    const flat: TrackAnalysis = {
      ...outgoing,
      drops: [],
      energyContour: Array.from({ length: 240 }, (_, i) => ({
        timeSec: i * 0.25,
        rms: 0.3,
      })),
    };
    expect(
      authorManualScratch(
        request(flat, incomingLandings(), 22),
        STANDARD_PROFILE,
        "chirp",
      ),
    ).toBeNull();
  });

  it("refuses when the window would end past the track's end", () => {
    // A 4-beat transformer from 59 s ends at 61 — past the track.
    expect(
      authorManualScratch(
        request(outgoingNoOutro(), incomingLandings(), 59),
        STANDARD_PROFILE,
        "transformer",
      ),
    ).toBeNull();
  });

  it("refuses when the incoming offers no landing", () => {
    expect(
      authorManualScratch(
        request(outgoingNoOutro(), incomingNoLanding(), 22),
        STANDARD_PROFILE,
        "baby",
      ),
    ).toBeNull();
  });
});
