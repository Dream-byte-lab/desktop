import { describe, expect, it } from "vitest";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import {
  candidatesForPair,
  familyOfRecipe,
  type Candidate,
} from "./candidates";
import {
  CONSERVATIVE_PROFILE,
  STANDARD_PROFILE,
  type DecisionProfile,
} from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import { validateRecipe } from "./recipe";
import { scoreCandidates } from "./scoring";
import type { RecipeRequest } from "./transitionPlanner";

// The revamp's R1 — stop-exit AUTHORING. The gates are the spec's
// discipline (§2B: a technique fires when it makes musical sense,
// never on a counter): a falling outro, a real landing on the
// incoming, a profile that prices the family within reach. Each
// gate is pinned by the fixture that fails it. Fixture arithmetic:
// 120 BPM, a beat is 0.5 s, a 240 s track is 480 beats.

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

/**
 * A pair built for a stop exit: A falls into a long quiet outro at
 * 200 s (beat 400); B offers a strong drop at beat 64. Position 60 s.
 */
function stopRequest(
  overrides: {
    outgoing?: Partial<TrackAnalysis>;
    incoming?: Partial<TrackAnalysis>;
  } = {},
): RecipeRequest {
  const outgoing = analysis({
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("verse", 16, 64, 0.3, 0.85),
      section("chorus", 64, 112, 0.5, 0.9),
      section("verse", 112, 200, 0.3, 0.85),
      section("outro", 200, 240, 0.1, 0),
    ],
    outro: { startSec: 200, endSec: 240, startBeat: 400, endBeat: 480 },
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

function stopCandidates(
  request: RecipeRequest,
  profiles?: readonly DecisionProfile[],
): Candidate[] {
  return candidatesForPair(request, profiles ? { profiles } : {}).filter(
    (c) => c.family === "spinback" || c.family === "vinyl-stop",
  );
}

describe("authorStopExit — the stop exits are authored, under gates", () => {
  it("a falling outro earns a spinback and a BRAKE (long tail) under the vinyl-stop family", () => {
    const stops = stopCandidates(stopRequest());
    const spin = stops.find((c) => c.family === "spinback");
    const stop = stops.find((c) => c.family === "vinyl-stop");
    if (!spin || !stop) throw new Error("expected both stop exits");

    const spinBlock = spin.recipe.loops[0];
    expect(spinBlock.type).toBe("spinback");
    expect(spinBlock.side).toBe("A");
    expect(spinBlock.startMs).toBe(200_000);
    expect(spinBlock.beats).toBe(2);
    expect(spinBlock.peakRate).toBe(-3.5);
    // The incoming's drop (beat 64, at 32 s) lands as the spin ends:
    // B starts 1 s of its own time earlier, silent until then.
    expect(spin.recipe.overlap.startBMs).toBe(31_000);
    expect(spin.recipe.overlap.durationMs).toBe(1000);
    expect(validateRecipe(spin.recipe)).toEqual([]);

    // 80 beats of falling outro is a gradual moment: the stop
    // family's technique is the brake, though the family is one.
    const brakeBlock = stop.recipe.loops[0];
    expect(brakeBlock.type).toBe("brake");
    expect(brakeBlock.beats).toBe(4);
    expect(familyOfRecipe(stop.recipe)).toBe("vinyl-stop");
    expect(validateRecipe(stop.recipe)).toEqual([]);
  });

  it("a short outro earns a sudden VINYL STOP (1 beat), not a brake", () => {
    const stops = stopCandidates(
      stopRequest({
        outgoing: {
          sections: [
            section("intro", 0, 16, 0.15, 0),
            section("verse", 16, 64, 0.3, 0.85),
            section("chorus", 64, 232, 0.5, 0.9),
            section("outro", 232, 240, 0.1, 0),
          ],
          outro: { startSec: 232, endSec: 240, startBeat: 464, endBeat: 480 },
        },
      }),
    );
    const stop = stops.find((c) => c.family === "vinyl-stop");
    if (!stop) throw new Error("expected a stop exit");
    expect(stop.recipe.loops[0].type).toBe("vinyl-stop");
    expect(stop.recipe.loops[0].beats).toBe(1);
  });

  it("the conservative profile never authors a stop exit — it prices theatre out of its own reach", () => {
    expect(stopCandidates(stopRequest(), [CONSERVATIVE_PROFILE])).toEqual([]);
  });

  it("a profile that prices the stop families at 1 (priced out entirely) never authors them", () => {
    const pricedOut: DecisionProfile = {
      ...STANDARD_PROFILE,
      id: "priced-out",
      familyCosts: {
        ...STANDARD_PROFILE.familyCosts,
        spinback: 1,
        "vinyl-stop": 1,
      },
    };
    expect(stopCandidates(stopRequest(), [pricedOut])).toEqual([]);
  });

  it("no stop exit when the outro CLIMBS — a stop is an ending, not an interruption", () => {
    const stops = stopCandidates(
      stopRequest({
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
    expect(stops).toEqual([]);
  });

  it("no stop exit without an outro at all", () => {
    expect(stopCandidates(stopRequest({ outgoing: { outro: null } }))).toEqual(
      [],
    );
  });

  it("no stop exit when the incoming offers no landing — no drop, no section, no intro end", () => {
    const stops = stopCandidates(
      stopRequest({
        incoming: { drops: [], sections: [], intro: null },
      }),
    );
    expect(stops).toEqual([]);
  });

  it("stop exits are SCORED, not vetoed — the performability veto died with R1", () => {
    const candidates = candidatesForPair(stopRequest());
    const result = scoreCandidates(candidates, {}, STANDARD_PROFILE);
    const spin = result.ranked.find((r) => r.candidate.family === "spinback");
    const stop = result.ranked.find((r) => r.candidate.family === "vinyl-stop");
    if (!spin || !stop) throw new Error("expected both stop exits ranked");
    expect(spin.vetoed).toBe(false);
    expect(stop.vetoed).toBe(false);
  });
});

describe("validateRecipe — jog-move data is checked", () => {
  it("a spinback without a sane negative peak is not performable", () => {
    const spin = stopCandidates(stopRequest()).find(
      (c) => c.family === "spinback",
    );
    if (!spin) throw new Error("expected a spinback");
    const broken = {
      ...spin.recipe,
      loops: [{ ...spin.recipe.loops[0], peakRate: undefined }],
    };
    expect(validateRecipe(broken).some((e) => e.includes("peakRate"))).toBe(
      true,
    );
    const positive = {
      ...spin.recipe,
      loops: [{ ...spin.recipe.loops[0], peakRate: 2 }],
    };
    expect(validateRecipe(positive).some((e) => e.includes("peakRate"))).toBe(
      true,
    );
  });

  it("a nudge must bend — a bend of exactly 1 is no move, and a wild bend is a tempo change", () => {
    const spin = stopCandidates(stopRequest()).find(
      (c) => c.family === "spinback",
    );
    if (!spin) throw new Error("expected a spinback");
    const asNudge = (bend: number) => ({
      ...spin.recipe,
      loops: [
        {
          type: "nudge" as const,
          side: "A" as const,
          startMs: 200_000,
          endMs: 201_000,
          beats: 2,
          bend,
        },
      ],
    });
    expect(validateRecipe(asNudge(1)).some((e) => e.includes("bend"))).toBe(
      true,
    );
    expect(validateRecipe(asNudge(1.5)).some((e) => e.includes("bend"))).toBe(
      true,
    );
    expect(validateRecipe(asNudge(1.05))).toEqual([]);
  });
});
