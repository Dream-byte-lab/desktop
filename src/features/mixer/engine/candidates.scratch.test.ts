import { describe, expect, it } from "vitest";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import {
  candidatesForPair,
  familyOfRecipe,
  type Candidate,
} from "./candidates";
import {
  ADVENTUROUS_PROFILE,
  CONSERVATIVE_PROFILE,
  STANDARD_PROFILE,
  type DecisionProfile,
} from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { validateRecipe } from "./recipe";
import { scoreCandidates } from "./scoring";
import type { RecipeRequest } from "./transitionPlanner";

// The revamp's R2 — scratch AUTHORING. The gates are the spec's
// discipline (§2B) with a narrower door than R1's stop exits: a
// scratch is performed ON material, so the window must be
// witnessed, quiet-voiced and transient-rich before technique is
// even discussed. Each gate is pinned by the fixture that fails
// it. Fixture arithmetic: 120 BPM, a beat is 0.5 s, a 240 s track
// is 480 beats.

function key(camelot: string, pitchClass: number): KeyEstimate {
  return { tonic: "C", mode: "major", pitchClass, camelot, confidence: 0.9 };
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

/** A graded vocal curve, one point every half second. */
function vocalCurve(
  activity: (sec: number) => number,
  confidence = 0.9,
): VocalActivityCurve {
  const points = [];
  for (let t = 0; t < 240; t += 0.5) {
    points.push({ timeSec: t, activity: activity(t), confidence });
  }
  return { windowSec: 0.25, stepSec: 0.5, points };
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

/** The R1 stop fixture's outgoing: falls into a quiet outro at 200 s. */
function fallingOutgoing(
  overrides: Partial<TrackAnalysis> = {},
): TrackAnalysis {
  return analysis({
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("verse", 16, 64, 0.3, 0.85),
      section("chorus", 64, 112, 0.5, 0.9),
      section("verse", 112, 200, 0.3, 0.85),
      section("outro", 200, 240, 0.1, 0),
    ],
    outro: { startSec: 200, endSec: 240, startBeat: 400, endBeat: 480 },
    ...overrides,
  });
}

/**
 * A pair built for a scratch-IN: B has a long, silent, witnessed
 * intro ending in a strong drop at beat 80 (40 s); A offers
 * section boundaries. Position 60 s.
 */
function scratchInRequest(
  overrides: {
    outgoing?: Partial<TrackAnalysis>;
    incoming?: Partial<TrackAnalysis>;
  } = {},
): RecipeRequest {
  const outgoing = fallingOutgoing(overrides.outgoing);
  const incoming = analysis({
    audioHash: "hash-b",
    sections: [
      section("intro", 0, 40, 0.15, 0),
      section("chorus", 40, 120, 0.5, 0.9),
      section("verse", 120, 200, 0.3, 0.85),
      section("chorus", 200, 240, 0.5, 0.9),
    ],
    intro: { startSec: 0, endSec: 40, startBeat: 0, endBeat: 80 },
    drops: [{ timeSec: 40, beat: 80, strength: 2.6 }],
    vocalActivity: vocalCurve((t) => (t < 40 ? 0 : 0.9)),
    ...overrides.incoming,
  });
  return { outgoing, outgoingPositionSec: 60, incoming };
}

/**
 * A pair built for a scratch-OUT: A's outro head carries a last
 * transient (a drop read at beat 401) over a silent outro; B is
 * the R1 stop fixture's incoming, whose own scratch-in window is
 * sung (chorus vocal 0.9), so only the scratch-out can fire.
 */
function scratchOutRequest(
  overrides: {
    outgoing?: Partial<TrackAnalysis>;
    incoming?: Partial<TrackAnalysis>;
  } = {},
): RecipeRequest {
  const outgoing = fallingOutgoing({
    drops: [{ timeSec: 200.5, beat: 401, strength: 1.5 }],
    ...overrides.outgoing,
  });
  const incoming = analysis({
    audioHash: "hash-b",
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("chorus", 16, 64, 0.5, 0.9),
      section("verse", 64, 160, 0.3, 0.85),
      section("chorus", 160, 240, 0.5, 0.9),
    ],
    intro: { startSec: 0, endSec: 16, startBeat: 0, endBeat: 32 },
    drops: [{ timeSec: 32, beat: 64, strength: 2.4 }],
    ...overrides.incoming,
  });
  return { outgoing, outgoingPositionSec: 60, incoming };
}

function scratchCandidates(
  request: RecipeRequest,
  profiles?: readonly DecisionProfile[],
): Candidate[] {
  return candidatesForPair(request, profiles ? { profiles } : {}).filter(
    (c) => c.family === "scratch",
  );
}

describe("authorScratchIn — the incoming is scratched in, under gates", () => {
  it("a hot drop entry earns a CHIRP under standard and a TRANSFORMER under adventurous", () => {
    const scratches = scratchCandidates(scratchInRequest());
    expect(scratches).toHaveLength(2);
    const chirp = scratches.find(
      (c) => c.recipe.loops[0].technique === "chirp",
    );
    const transformer = scratches.find(
      (c) => c.recipe.loops[0].technique === "transformer",
    );
    if (!chirp || !transformer) {
      throw new Error("expected a chirp and a transformer telling");
    }
    expect(chirp.profileId).toBe("standard");
    expect(transformer.profileId).toBe("adventurous");
    expect(familyOfRecipe(chirp.recipe)).toBe("scratch");

    // The chirp: B's last 2 beats before its drop (40 s), handed
    // over at A's chorus end (112 s).
    const block = chirp.recipe.loops[0];
    expect(block.type).toBe("scratch");
    expect(block.side).toBe("B");
    expect(block.startMs).toBe(39_000);
    expect(block.endMs).toBe(40_000);
    expect(block.beats).toBe(2);
    expect(block.strokes).toBe(2);
    expect(block.excursionBeats).toBe(0.75);
    expect(chirp.recipe.overlap.startAMs).toBe(111_000);
    expect(chirp.recipe.overlap.startBMs).toBe(39_000);
    expect(chirp.recipe.overlap.durationMs).toBe(1000);
    expect(validateRecipe(chirp.recipe)).toEqual([]);

    // The transformer needs its room: 4 beats of window, one slow
    // hand cycle, clicks at 2 per beat.
    const tBlock = transformer.recipe.loops[0];
    expect(tBlock.startMs).toBe(38_000);
    expect(tBlock.beats).toBe(4);
    expect(tBlock.strokes).toBe(1);
    expect(tBlock.clicksPerBeat).toBe(2);
    expect(validateRecipe(transformer.recipe)).toEqual([]);
  });

  it("a quiet entry earns the BABY — the foundation move, nothing showy", () => {
    const scratches = scratchCandidates(
      scratchInRequest({
        incoming: {
          sections: [
            section("intro", 0, 40, 0.15, 0),
            section("chorus", 40, 120, 0.2, 0.9),
            section("verse", 120, 200, 0.5, 0.85),
            section("chorus", 200, 240, 0.2, 0.9),
          ],
        },
      }),
    );
    expect(scratches).toHaveLength(1);
    expect(scratches[0].recipe.loops[0].technique).toBe("baby");
  });

  it("the conservative profile never authors a scratch — it prices the family out of its own reach", () => {
    expect(
      scratchCandidates(scratchInRequest(), [CONSERVATIVE_PROFILE]),
    ).toEqual([]);
    expect(
      scratchCandidates(scratchOutRequest(), [CONSERVATIVE_PROFILE]),
    ).toEqual([]);
  });

  it("a profile that prices scratch at 1 (priced out entirely) never authors one", () => {
    const pricedOut: DecisionProfile = {
      ...STANDARD_PROFILE,
      id: "priced-out",
      familyCosts: { ...STANDARD_PROFILE.familyCosts, scratch: 1 },
    };
    expect(scratchCandidates(scratchInRequest(), [pricedOut])).toEqual([]);
  });

  it("no scratch across a lead vocal — a sung window refuses the hand", () => {
    const scratches = scratchCandidates(
      scratchInRequest({
        incoming: { vocalActivity: vocalCurve(() => 0.9) },
      }),
    );
    expect(scratches).toEqual([]);
  });

  it("no scratch on an UNWITNESSED window — no curve, no sections, no guess", () => {
    const scratches = scratchCandidates(
      scratchInRequest({
        incoming: { vocalActivity: undefined, sections: [] },
      }),
    );
    expect(scratches).toEqual([]);
  });

  it("no scratch on flat material — nothing for the hand to chop", () => {
    const flatContour = Array.from({ length: 960 }, (_, i) => ({
      timeSec: i * 0.25,
      rms: 0.2,
    }));
    const scratches = scratchCandidates(
      scratchInRequest({
        incoming: { drops: [], energyContour: flatContour },
      }),
    );
    expect(scratches).toEqual([]);
  });

  it("no scratch when the incoming offers no landing — no drop, no section, no intro end", () => {
    const scratches = scratchCandidates(
      scratchInRequest({
        incoming: { drops: [], sections: [], intro: null },
      }),
    );
    expect(scratches).toEqual([]);
  });

  it("scratches are SCORED, not vetoed — they stand or fall on evidence and cost", () => {
    const candidates = candidatesForPair(scratchInRequest());
    const result = scoreCandidates(candidates, {}, STANDARD_PROFILE);
    const scratch = result.ranked.find((r) => r.candidate.family === "scratch");
    if (!scratch) throw new Error("expected a scratch candidate ranked");
    expect(scratch.vetoed).toBe(false);
  });
});

describe("authorScratchOut — the outgoing is scratched out, under gates", () => {
  it("a falling, witnessed outro head earns a CHIRP out (the landing is hot)", () => {
    const scratches = scratchCandidates(scratchOutRequest());
    expect(scratches).toHaveLength(1);
    const block = scratches[0].recipe.loops[0];
    expect(block.type).toBe("scratch");
    expect(block.side).toBe("A");
    expect(block.technique).toBe("chirp");
    expect(block.startMs).toBe(200_000);
    expect(block.beats).toBe(2);
    // B starts a window early and silent; its drop lands as the
    // scratch completes.
    expect(scratches[0].recipe.overlap.startBMs).toBe(31_000);
    expect(scratches[0].recipe.overlap.durationMs).toBe(1000);
    expect(validateRecipe(scratches[0].recipe)).toEqual([]);
  });

  it("no scratch-out when the outro CLIMBS — inherited from the stop exits' gate", () => {
    const scratches = scratchCandidates(
      scratchOutRequest({
        outgoing: {
          sections: [
            section("intro", 0, 16, 0.15, 0),
            section("verse", 16, 64, 0.3, 0.85),
            section("chorus", 64, 112, 0.5, 0.9),
            section("verse", 112, 200, 0.3, 0.85),
            section("outro", 200, 240, 0.6, 0),
          ],
        },
      }),
    );
    expect(scratches).toEqual([]);
  });

  it("no scratch-out on flat material — the outro head must carry a transient", () => {
    const scratches = scratchCandidates(
      scratchOutRequest({ outgoing: { drops: [] } }),
    );
    expect(scratches).toEqual([]);
  });
});

describe("validateRecipe — scratch data is checked", () => {
  function authoredChirp(): Candidate {
    const chirp = scratchCandidates(scratchInRequest()).find(
      (c) => c.recipe.loops[0].technique === "chirp",
    );
    if (!chirp) throw new Error("expected an authored chirp");
    return chirp;
  }

  function withBlock(
    patch: Partial<Candidate["recipe"]["loops"][number]>,
  ): Candidate["recipe"] {
    const base = authoredChirp().recipe;
    return { ...base, loops: [{ ...base.loops[0], ...patch }] };
  }

  it("a scratch without a named technique is not performable", () => {
    const broken = withBlock({ technique: undefined });
    expect(validateRecipe(broken).some((e) => e.includes("technique"))).toBe(
      true,
    );
  });

  it("a scratch with no strokes is not a scratch — no direction change, no move", () => {
    expect(
      validateRecipe(withBlock({ strokes: 0 })).some((e) =>
        e.includes("strokes"),
      ),
    ).toBe(true);
    expect(
      validateRecipe(withBlock({ strokes: 1.5 })).some((e) =>
        e.includes("strokes"),
      ),
    ).toBe(true);
  });

  it("a scratch must state its sweep — zero is a resting hand, past two beats is a throw", () => {
    expect(
      validateRecipe(withBlock({ excursionBeats: 0 })).some((e) =>
        e.includes("excursionBeats"),
      ),
    ).toBe(true);
    expect(
      validateRecipe(withBlock({ excursionBeats: 2.5 })).some((e) =>
        e.includes("excursionBeats"),
      ),
    ).toBe(true);
  });

  it("a transformer without its click rhythm cannot be performed", () => {
    const noRhythm = withBlock({
      technique: "transformer",
      clicksPerBeat: undefined,
    });
    expect(
      validateRecipe(noRhythm).some((e) => e.includes("clicksPerBeat")),
    ).toBe(true);
    const tooFast = withBlock({ technique: "transformer", clicksPerBeat: 9 });
    expect(
      validateRecipe(tooFast).some((e) => e.includes("clicksPerBeat")),
    ).toBe(true);
    const honest = withBlock({ technique: "transformer", clicksPerBeat: 2 });
    expect(validateRecipe(honest)).toEqual([]);
  });

  it("a valid flare block validates clean", () => {
    expect(validateRecipe(withBlock({ technique: "flare" }))).toEqual([]);
  });

  it("the adventurous profile prices scratch inside authoring reach; conservative outside it", () => {
    expect(ADVENTUROUS_PROFILE.familyCosts.scratch).toBeLessThan(
      STANDARD_PROFILE.familyCosts.scratch,
    );
    expect(STANDARD_PROFILE.familyCosts.scratch).toBeLessThanOrEqual(0.5);
    expect(CONSERVATIVE_PROFILE.familyCosts.scratch).toBeGreaterThan(0.5);
  });
});
