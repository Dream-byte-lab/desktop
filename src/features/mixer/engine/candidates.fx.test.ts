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
import { validateRecipe, type RecipeEffectKind } from "./recipe";
import { scoreCandidates } from "./scoring";
import type { RecipeRequest } from "./transitionPlanner";

// The revamp's R3 — effect DRESSING authoring. Effects are not
// joins: they dress a blend or a fade the author already made, and
// only where the material witnesses the window and the profile
// prices the rack within reach. Each gate is pinned by the fixture
// that fails it. Fixture arithmetic: 120 BPM, a beat is 0.5 s, a
// 240 s track is 480 beats. The standard author's blend for the
// fixture pair below runs 16 beats (8 s) into the outgoing's outro
// at 200 s, the incoming entering on its drop at 40 s (beat 80) —
// so the tail window is A [200 s, 208 s], the wash / grit window
// is B [32 s, 40 s], and the chop window ends at 200 s.

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

interface FxFixture {
  outgoing?: Partial<TrackAnalysis>;
  incoming?: Partial<TrackAnalysis>;
  position?: number;
  /** The outgoing outro's meanRms — its exit energy is this / 0.5. */
  outroRms?: number;
  /** The incoming entry section's meanRms — its entry energy is this / 0.5. */
  entryRms?: number;
  /** Vocal activity over A's chop window [198 s, 200 s). */
  chopVocal?: number;
  /** Vocal activity over A's tail window [200 s, 208 s). */
  tailVocal?: number;
  /** Vocal activity over B's wash window [32 s, 40 s). */
  bVocal?: number;
}

/**
 * A pair built to be dressed: A's blend exits into its outro, B
 * enters on a strong drop. Both tracks sing at 0.9 everywhere
 * EXCEPT the windows the dressings read, whose vocal levels the
 * fixture names — so each variant's witness gate is exercised in
 * isolation, and the author's desired blend stays the standard
 * 16 beats (the pair is never quiet enough to earn the long one).
 */
function fxRequest(fixture: FxFixture = {}): RecipeRequest {
  const outroRms = fixture.outroRms ?? 0.25;
  const entryRms = fixture.entryRms ?? 0.5;
  const chopVocal = fixture.chopVocal ?? 0.1;
  const tailVocal = fixture.tailVocal ?? 0.1;
  const bVocal = fixture.bVocal ?? 0.1;
  const outgoing = analysis({
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("verse", 16, 64, 0.3, 0.85),
      section("chorus", 64, 112, 0.5, 0.9),
      section("verse", 112, 200, 0.3, 0.85),
      section("outro", 200, 240, outroRms, 0),
    ],
    outro: { startSec: 200, endSec: 240, startBeat: 400, endBeat: 480 },
    vocalActivity: vocalCurve((t) =>
      t >= 198 && t < 200 ? chopVocal : t >= 200 && t < 208 ? tailVocal : 0.9,
    ),
    ...fixture.outgoing,
  });
  const incoming = analysis({
    audioHash: "hash-b",
    sections: [
      section("intro", 0, 40, 0.15, 0),
      section("chorus", 40, 120, entryRms, 0.9),
      section("verse", 120, 200, 0.3, 0.85),
      section("chorus", 200, 240, 0.5, 0.9),
    ],
    intro: { startSec: 0, endSec: 40, startBeat: 0, endBeat: 80 },
    drops: [{ timeSec: 40, beat: 80, strength: 2.6 }],
    vocalActivity: vocalCurve((t) => (t >= 32 && t < 40 ? bVocal : 0.9)),
    ...fixture.incoming,
  });
  return {
    outgoing,
    outgoingPositionSec: fixture.position ?? 60,
    incoming,
  };
}

function fxCandidates(
  request: RecipeRequest,
  profiles?: readonly DecisionProfile[],
): Candidate[] {
  return candidatesForPair(request, profiles ? { profiles } : {}).filter(
    (c) => c.family === "fx",
  );
}

function withEffect(
  candidates: Candidate[],
  kind: RecipeEffectKind,
): Candidate | undefined {
  return candidates.find((c) =>
    (c.recipe.effects ?? []).some((e) => e.kind === kind),
  );
}

function effectKinds(candidates: Candidate[]): RecipeEffectKind[] {
  return candidates.flatMap((c) => (c.recipe.effects ?? []).map((e) => e.kind));
}

describe("authorEffectVariants — the tail and the wash", () => {
  it("a hot, witnessed pair earns the tail CHAIN and the wash FLANGER under standard, exactly as authored", () => {
    const fx = fxCandidates(fxRequest(), [STANDARD_PROFILE]);
    // All four dressings land on this pair: chain, flanger, the
    // flat-material trans chop, and grit (the entry energy is 1,
    // past the 0.8 line where any authoring profile reaches).
    expect(fx.map((c) => c.origin)).toEqual([
      "fx:standard",
      "fx:standard",
      "fx:standard",
      "fx:standard",
    ]);
    expect(effectKinds(fx)).toEqual([
      "delay",
      "reverb",
      "flanger",
      "trans",
      "distortion",
    ]);

    const chain = withEffect(fx, "delay");
    if (!chain) throw new Error("expected a chain-dressed candidate");
    expect(chain.family).toBe("fx");
    expect(familyOfRecipe(chain.recipe)).toBe("fx");
    // One beat of A (0.5 s) of delay, chained into the reverb.
    expect(chain.recipe.fx).toEqual({
      delay: { delaySec: 0.5, feedback: 0.35, wet: 0.5 },
      reverb: { decaySec: 1.8, wet: 0.55 },
      chainDelayIntoReverb: true,
    });
    expect(chain.recipe.effects).toEqual([
      {
        kind: "delay",
        side: "A",
        startMs: 200_000,
        endMs: 208_000,
        beats: 16,
        level: 0.45,
      },
      {
        kind: "reverb",
        side: "A",
        startMs: 200_000,
        endMs: 208_000,
        beats: 16,
        level: 0.5,
      },
    ]);
    // The dressing shares its base's geometry untouched.
    expect(chain.recipe.overlap.startAMs).toBe(200_000);
    expect(chain.recipe.overlap.startBMs).toBe(32_000);
    expect(chain.recipe.overlap.durationMs).toBe(8000);
    expect(validateRecipe(chain.recipe)).toEqual([]);

    const wash = withEffect(fx, "flanger");
    if (!wash) throw new Error("expected a flanger-dressed candidate");
    expect(wash.recipe.fx).toEqual({
      flanger: { rateHz: 0.3, depthMs: 1.2, feedback: 0.3, wet: 0.5 },
    });
    expect(wash.recipe.effects).toEqual([
      {
        kind: "flanger",
        side: "B",
        startMs: 32_000,
        endMs: 40_000,
        beats: 16,
        level: 0.35,
      },
    ]);
    expect(validateRecipe(wash.recipe)).toEqual([]);
  });

  it("a quiet exit (energy < 0.4) earns REVERB alone — no delay, no chain", () => {
    const fx = fxCandidates(fxRequest({ outroRms: 0.1 }), [STANDARD_PROFILE]);
    const tail = withEffect(fx, "reverb");
    if (!tail) throw new Error("expected a reverb-dressed candidate");
    expect(tail.recipe.fx).toEqual({ reverb: { decaySec: 1.8, wet: 0.55 } });
    expect(tail.recipe.effects).toEqual([
      {
        kind: "reverb",
        side: "A",
        startMs: 200_000,
        endMs: 208_000,
        beats: 16,
        level: 0.5,
      },
    ]);
    expect(withEffect(fx, "delay")).toBeUndefined();
    expect(withEffect(fx, "spiral")).toBeUndefined();
  });

  it("a very hot, low-vocal exit earns the SPIRAL", () => {
    const fx = fxCandidates(fxRequest({ outroRms: 0.4, tailVocal: 0.2 }), [
      STANDARD_PROFILE,
    ]);
    const spiral = withEffect(fx, "spiral");
    if (!spiral) throw new Error("expected a spiral-dressed candidate");
    expect(spiral.recipe.fx).toEqual({
      spiral: { delaySec: 0.25, sweepToRatio: 0.5, feedback: 0.45, wet: 0.5 },
    });
    expect(spiral.recipe.effects).toEqual([
      {
        kind: "spiral",
        side: "A",
        startMs: 200_000,
        endMs: 208_000,
        beats: 16,
        level: 0.4,
      },
    ]);
    expect(withEffect(fx, "delay")).toBeUndefined();
  });

  it("a hot but vocal-heavier exit falls back to the CHAIN", () => {
    // Tail-window vocal mean 0.5: inside the wash class's 0.6, past
    // the spiral's own stricter 0.35.
    const fx = fxCandidates(fxRequest({ outroRms: 0.4, tailVocal: 0.5 }), [
      STANDARD_PROFILE,
    ]);
    expect(withEffect(fx, "spiral")).toBeUndefined();
    const chain = withEffect(fx, "delay");
    if (!chain) throw new Error("expected the chain fallback");
    expect(chain.recipe.fx.chainDelayIntoReverb).toBe(true);
  });
});

describe("authorEffectVariants — the chop", () => {
  it("a transient-rich witnessed pre-window earns the ROLL", () => {
    const fx = fxCandidates(
      fxRequest({
        outgoing: { drops: [{ timeSec: 199.5, beat: 399, strength: 1.5 }] },
      }),
      [STANDARD_PROFILE],
    );
    const roll = withEffect(fx, "roll");
    if (!roll) throw new Error("expected a roll-dressed candidate");
    expect(roll.recipe.fx).toEqual({
      roll: { sliceBeats: 0.5, feedback: 0.94 },
    });
    expect(roll.recipe.effects).toEqual([
      {
        kind: "roll",
        side: "A",
        startMs: 199_000,
        endMs: 200_000,
        beats: 2,
        level: 0.8,
      },
    ]);
    expect(withEffect(fx, "trans")).toBeUndefined();
    expect(validateRecipe(roll.recipe)).toEqual([]);
  });

  it("a flat witnessed pre-window earns the TRANS", () => {
    const fx = fxCandidates(fxRequest(), [STANDARD_PROFILE]);
    const trans = withEffect(fx, "trans");
    if (!trans) throw new Error("expected a trans-dressed candidate");
    expect(trans.recipe.fx).toEqual({
      trans: { divisionBeats: 0.5, depth: 0.85 },
    });
    expect(trans.recipe.effects).toEqual([
      {
        kind: "trans",
        side: "A",
        startMs: 198_000,
        endMs: 200_000,
        beats: 4,
        level: 1,
      },
    ]);
  });

  it("a pre-window starting too close to the position earns NEITHER chop", () => {
    // A profile with no lead requirement lets the author place the
    // blend's start 0.1 s ahead of the playhead — inside the chop
    // windows' reach. The dressings that do not read that window
    // (the tail) still land; the chop must not.
    const closeProfile: DecisionProfile = {
      ...STANDARD_PROFILE,
      id: "close-in",
      minLeadBeats: 0,
    };
    const fx = fxCandidates(fxRequest({ position: 199.9 }), [closeProfile]);
    expect(fx.length).toBeGreaterThan(0);
    expect(withEffect(fx, "roll")).toBeUndefined();
    expect(withEffect(fx, "trans")).toBeUndefined();
  });
});

describe("authorEffectVariants — the grit", () => {
  it("adventurous earns DISTORTION at a loud drop entry where standard does not", () => {
    // Entry energy 0.7: past the grit floor (0.65) but below the
    // 0.8 line where any authoring profile reaches — this pins the
    // BOLD branch of the gate (adventurous prices fx at 0.3).
    const request = fxRequest({ entryRms: 0.35 });
    const adventurous = fxCandidates(request, [ADVENTUROUS_PROFILE]);
    const grit = withEffect(adventurous, "distortion");
    if (!grit) throw new Error("expected a distortion-dressed candidate");
    expect(grit.recipe.fx).toEqual({
      distortion: { amount: 0.65, wet: 0.55 },
    });
    expect(grit.recipe.effects).toEqual([
      {
        kind: "distortion",
        side: "B",
        startMs: 32_000,
        endMs: 40_000,
        beats: 16,
        level: 0.5,
      },
    ]);
    const standard = fxCandidates(request, [STANDARD_PROFILE]);
    expect(withEffect(standard, "distortion")).toBeUndefined();
  });
});

describe("authorEffectVariants — the provable silences", () => {
  it("the conservative profile authors NO fx variants — it prices the rack out of its own reach", () => {
    expect(fxCandidates(fxRequest(), [CONSERVATIVE_PROFILE])).toEqual([]);
  });

  it("unwitnessed windows earn nothing — no vocal curve, no sections, no guess", () => {
    const request = fxRequest({
      outgoing: { vocalActivity: undefined, sections: [] },
      incoming: { vocalActivity: undefined, sections: [] },
    });
    // The base blend itself is still honestly authored…
    expect(
      candidatesForPair(request, { profiles: [STANDARD_PROFILE] }).some(
        (c) => c.origin === "author:standard",
      ),
    ).toBe(true);
    // …but no window of it can be witnessed, so nothing is dressed.
    expect(fxCandidates(request, [STANDARD_PROFILE])).toEqual([]);
  });

  it("a vocal-dense window (wash mean > 0.6) earns no tail and no wash", () => {
    const fx = fxCandidates(fxRequest({ tailVocal: 0.9, bVocal: 0.9 }), [
      STANDARD_PROFILE,
    ]);
    for (const kind of [
      "reverb",
      "delay",
      "spiral",
      "flanger",
      "phaser",
    ] as const) {
      expect(withEffect(fx, kind)).toBeUndefined();
    }
  });

  it("a strict-class window over the vocal bound earns no chop and no grit", () => {
    // Both strict windows at mean 0.4 — past the scratch bound of
    // 0.25 the strict class answers to, inside the wash class's 0.6
    // (the tail and wash dressings still land; only the strict
    // class is refused).
    const fx = fxCandidates(fxRequest({ chopVocal: 0.4, bVocal: 0.4 }), [
      STANDARD_PROFILE,
    ]);
    expect(withEffect(fx, "trans")).toBeUndefined();
    expect(withEffect(fx, "roll")).toBeUndefined();
    expect(withEffect(fx, "distortion")).toBeUndefined();
    expect(withEffect(fx, "reverb")).toBeDefined();
  });

  it("a distant-key pair whose blend outruns the cap earns NO fx variants — a vetoed blend stays vetoed dressed", () => {
    // Scoring's distant-key veto is scoped to the blend families;
    // without the authoring guard this dressing would escape it.
    // The pair cannot beatmatch (tempo confidence too low to
    // spend), so the author answers with an 8-beat filter fade —
    // a host family — under a profile capping distant blends at
    // 4 beats. Every other gate is satisfied (witnessed quiet
    // windows, a mid-energy exit, a hot entry): the distant key
    // alone silences the rack.
    const capProfile: DecisionProfile = {
      ...STANDARD_PROFILE,
      id: "distant-cap",
      distantKeyMaxBlendBeats: 4,
    };
    const request = fxRequest({
      incoming: {
        key: key("3B", 5),
        tempoConfidence: 0.1,
        drops: [],
      },
    });
    const candidates = candidatesForPair(request, { profiles: [capProfile] });
    const base = candidates.find((c) => c.origin === "author:distant-cap");
    if (!base) throw new Error("expected the filter-fade base");
    expect(base.family).toBe("filter-fade");
    expect(base.evidence.keyRelation).toBe("distant");
    expect(base.evidence.blendBeats).toBe(8);
    expect(candidates.filter((c) => c.family === "fx")).toEqual([]);
  });

  it("theatre and restraint bases are never dressed — no fx recipe carries a scratch or stop block", () => {
    const candidates = candidatesForPair(fxRequest());
    const families = new Set(candidates.map((c) => c.family));
    // The set really does contain the undressed families…
    expect(families.has("let-it-play")).toBe(true);
    expect(
      [...families].some((f) =>
        ["scratch", "spinback", "vinyl-stop"].includes(f),
      ),
    ).toBe(true);
    // …and every dressing sits on a plain blend/fade base, whose
    // loops it shares untouched: none at all.
    const fx = candidates.filter((c) => c.family === "fx");
    expect(fx.length).toBeGreaterThan(0);
    for (const candidate of fx) {
      expect(candidate.recipe.loops).toEqual([]);
    }
  });
});

describe("authorEffectVariants — family, signature and scoring", () => {
  it("the base and its dressings survive enumeration as separate candidates", () => {
    const candidates = candidatesForPair(fxRequest(), {
      profiles: [STANDARD_PROFILE],
    });
    const base = candidates.find((c) => c.origin === "author:standard");
    if (!base) throw new Error("expected the author's base candidate");
    expect(base.family).not.toBe("fx");
    const fx = candidates.filter((c) => c.origin === "fx:standard");
    expect(fx.length).toBeGreaterThanOrEqual(2);
    for (const candidate of fx) {
      expect(candidate.recipe.overlap).toEqual(base.recipe.overlap);
      expect(candidate.recipe).not.toBe(base.recipe);
    }
  });

  it("an fx candidate is SCORED, not vetoed — and the fx family cost is exactly what separates it from its base", () => {
    const candidates = candidatesForPair(fxRequest(), {
      profiles: [STANDARD_PROFILE],
    });
    const base = candidates.find((c) => c.origin === "author:standard");
    const chain = withEffect(
      candidates.filter((c) => c.family === "fx"),
      "delay",
    );
    if (!base || !chain) throw new Error("expected a base and its chain");
    const result = scoreCandidates(candidates, {}, STANDARD_PROFILE);
    const scoredBase = result.ranked.find((r) => r.candidate === base);
    const scoredChain = result.ranked.find((r) => r.candidate === chain);
    if (!scoredBase || !scoredChain) {
      throw new Error("expected both candidates ranked");
    }
    expect(scoredChain.vetoed).toBe(false);
    // Same recipe evidence, no history: the only term that moves
    // is the family cost — standard-blend is free under standard,
    // fx costs 0.45.
    expect(scoredBase.score - scoredChain.score).toBeCloseTo(0.45, 9);
  });

  it("fx pricing orders adventurous < standard ≤ the authoring ceiling < conservative", () => {
    expect(ADVENTUROUS_PROFILE.familyCosts.fx).toBe(0.3);
    expect(STANDARD_PROFILE.familyCosts.fx).toBe(0.45);
    expect(CONSERVATIVE_PROFILE.familyCosts.fx).toBe(0.7);
    expect(ADVENTUROUS_PROFILE.familyCosts.fx).toBeLessThan(
      STANDARD_PROFILE.familyCosts.fx,
    );
    expect(STANDARD_PROFILE.familyCosts.fx).toBeLessThanOrEqual(0.5);
    expect(CONSERVATIVE_PROFILE.familyCosts.fx).toBeGreaterThan(0.5);
  });
});
