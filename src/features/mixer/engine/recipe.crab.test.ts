import { describe, expect, it } from "vitest";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import { authorManualScratch } from "./candidates";
import { STANDARD_PROFILE } from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { validateRecipe, type TransitionRecipe } from "./recipe";
import type { RecipeRequest } from "./transitionPlanner";

// The crab's recipe data, checked (the crab slice, step 1). The
// base recipes are REAL authored ones — a manual crab and a
// manual chirp over the seams fixtures — patched field by field,
// in the R2 validation suite's idiom: a valid telling validates
// clean, and each broken field is refused by name.
//
// The discipline under test is the clicksPerBeat precedent,
// applied to a different quantity: tapsPerStroke is counted per
// STROKE, not per beat. A crab REQUIRES it (the taps are the
// technique — a crab without its finger count has no fader
// pattern), and wherever the field appears it must be a whole
// number in [3, 4] — three fingers or four are the technique; a
// two-tap burst is a twiddle, a different named move.

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

/** The manual fixtures: a 60 s outgoing whose 20–30 s stretch is witnessed, silent and stabby. */
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

function manualRequest(): RecipeRequest {
  return {
    outgoing: outgoingNoOutro(),
    outgoingPositionSec: 20,
    incoming: incomingLandings(),
  };
}

function authoredCrab(): TransitionRecipe {
  const recipe = authorManualScratch(manualRequest(), STANDARD_PROFILE, "crab");
  if (!recipe) throw new Error("expected an authored manual crab");
  return recipe;
}

function withBlock(
  patch: Partial<TransitionRecipe["loops"][number]>,
  base: TransitionRecipe = authoredCrab(),
): TransitionRecipe {
  return { ...base, loops: [{ ...base.loops[0], ...patch }] };
}

describe("validateRecipe — crab data is checked", () => {
  it("a valid crab block validates clean — taps stated, in range", () => {
    const recipe = authoredCrab();
    expect(recipe.loops[0].technique).toBe("crab");
    expect(recipe.loops[0].tapsPerStroke).toBe(3);
    expect(validateRecipe(recipe)).toEqual([]);
  });

  it("a four-finger crab validates clean — [3, 4] is the hand's honest range", () => {
    expect(validateRecipe(withBlock({ tapsPerStroke: 4 }))).toEqual([]);
  });

  it("a crab without its taps cannot be performed — the taps ARE the technique", () => {
    const broken = withBlock({ tapsPerStroke: undefined });
    expect(
      validateRecipe(broken).some((e) => e.includes("tapsPerStroke")),
    ).toBe(true);
  });

  it("a two-tap burst is a twiddle, not a crab — and five taps is not a hand", () => {
    for (const taps of [2, 5]) {
      expect(
        validateRecipe(withBlock({ tapsPerStroke: taps })).some((e) =>
          e.includes("tapsPerStroke"),
        ),
      ).toBe(true);
    }
  });

  it("a fractional tap count is not a finger count", () => {
    expect(
      validateRecipe(withBlock({ tapsPerStroke: 3.5 })).some((e) =>
        e.includes("tapsPerStroke"),
      ),
    ).toBe(true);
  });

  it("the range is checked wherever the field appears — an out-of-range count on a chirp is still refused", () => {
    const chirp = authorManualScratch(
      manualRequest(),
      STANDARD_PROFILE,
      "chirp",
    );
    if (!chirp) throw new Error("expected an authored manual chirp");
    expect(
      validateRecipe(withBlock({ tapsPerStroke: 5 }, chirp)).some((e) =>
        e.includes("tapsPerStroke"),
      ),
    ).toBe(true);
    // An in-range count riding on another technique is inert
    // data, not an error — the clicksPerBeat precedent is a
    // range check, not a presence ban.
    expect(validateRecipe(withBlock({ tapsPerStroke: 3 }, chirp))).toEqual([]);
  });
});
