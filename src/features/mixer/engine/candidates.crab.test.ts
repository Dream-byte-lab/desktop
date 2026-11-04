import { describe, expect, it } from "vitest";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import {
  authorManualScratch,
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
import type { JoinRecord } from "./joinHistory";
import { validateRecipe } from "./recipe";
import { scoreCandidates, type ScoredCandidate } from "./scoring";
import { countRecentFamilyUsesWeighted, selectFromBand } from "./selection";
import type { RecipeRequest } from "./transitionPlanner";

// The crab's AUTHORING (the crab slice, step 3) and its §15
// doctrine. The crab is the scratch family's most demanding
// telling of the same stab, so its difficulty is expressed as
// ELIGIBILITY, never as a price — the transformer precedent:
//   · a bold profile (one that prices scratch ≤ 0.4),
//   · a HOT entry (≥ 0.75),
//   · landing on a DROP — its material IS the stab at the
//     landing, so without the drop it is never attempted.
// Attempt order in that branch is [transformer, crab, flare]:
// the transformer's four-beat room is the rarer showcase and
// keeps first attempt; the crab follows; the flare remains.
//
// Fixture arithmetic: 120 BPM, a beat is 0.5 s, a 240 s track
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

/** The R2 fixtures' outgoing: falls into a quiet outro at 200 s. */
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
 * The R2 scratch-in pair: B has a long, silent, witnessed intro
 * ending in a strong drop at beat 80 (40 s); A offers section
 * boundaries. Position 60 s.
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
 * The pair with the transformer's four-beat window refused and
 * the crab's two-beat window clean: a singer occupies 38–39 s —
 * the first half of the transformer's window [38, 40] — while
 * the crab's window [39, 40] stays silent and witnessed.
 */
function crabReachableRequest(): RecipeRequest {
  return scratchInRequest({
    incoming: {
      vocalActivity: vocalCurve((t) =>
        t >= 38 && t < 39 ? 0.9 : t < 40 ? 0 : 0.9,
      ),
    },
  });
}

function scratchCandidates(
  request: RecipeRequest,
  profiles?: readonly DecisionProfile[],
): Candidate[] {
  return candidatesForPair(request, profiles ? { profiles } : {}).filter(
    (c) => c.family === "scratch",
  );
}

describe("authorScratchIn — the crab's eligibility and attempt order", () => {
  it("the transformer keeps first attempt in the hot drop branch — the crab does not preempt it", () => {
    const scratches = scratchCandidates(scratchInRequest(), [
      ADVENTUROUS_PROFILE,
    ]);
    expect(scratches).toHaveLength(1);
    expect(scratches[0].recipe.loops[0].technique).toBe("transformer");
  });

  it("when the transformer's window is refused, the crab is attempted next — with its exact block", () => {
    const scratches = scratchCandidates(crabReachableRequest(), [
      ADVENTUROUS_PROFILE,
    ]);
    expect(scratches).toHaveLength(1);
    const crab = scratches[0];
    expect(crab.profileId).toBe("adventurous");
    expect(familyOfRecipe(crab.recipe)).toBe("scratch");
    const block = crab.recipe.loops[0];
    expect(block.type).toBe("scratch");
    expect(block.side).toBe("B");
    expect(block.technique).toBe("crab");
    expect(block.startMs).toBe(39_000);
    expect(block.endMs).toBe(40_000);
    expect(block.beats).toBe(2);
    expect(block.strokes).toBe(2);
    // The family's shortest excursion — the crab works a SHORT
    // sound — and the three-finger burst.
    expect(block.excursionBeats).toBe(0.5);
    expect(block.tapsPerStroke).toBe(3);
    expect(crab.recipe.overlap.startBMs).toBe(39_000);
    expect(crab.recipe.overlap.durationMs).toBe(1000);
    expect(validateRecipe(crab.recipe)).toEqual([]);
    // And it stands in the full-profile enumeration too.
    const all = scratchCandidates(crabReachableRequest());
    expect(all.some((c) => c.recipe.loops[0].technique === "crab")).toBe(true);
  });

  it("a hot entry WITHOUT the drop never reaches the crab — the flare answers instead", () => {
    // No drops anywhere; the window's transient must come from
    // the energy contour (a stab pattern inside [39, 40]).
    const contour = Array.from({ length: 960 }, (_, i) => {
      const t = i * 0.25;
      const inWindow = t >= 39 && t < 40;
      return {
        timeSec: t,
        rms: inWindow ? (i % 2 === 0 ? 1 : 0.2) : 0.2,
      };
    });
    const scratches = scratchCandidates(
      scratchInRequest({
        incoming: { drops: [], energyContour: contour },
      }),
      [ADVENTUROUS_PROFILE],
    );
    expect(scratches).toHaveLength(1);
    expect(scratches[0].recipe.loops[0].technique).toBe("flare");
  });

  it("a mid-energy drop entry never reaches the crab — the transformer's branch answers", () => {
    // Entry section at 0.35 against a 0.5 peak: entry energy 0.7,
    // inside the mid branch [transformer, chirp] under a bold
    // profile — the crab's hot door (≥ 0.75) stays shut.
    const request = scratchInRequest({
      incoming: {
        sections: [
          section("intro", 0, 40, 0.15, 0),
          section("chorus", 40, 120, 0.35, 0.9),
          section("verse", 120, 200, 0.3, 0.85),
          section("chorus", 200, 240, 0.5, 0.9),
        ],
      },
    });
    const scratches = scratchCandidates(request, [ADVENTUROUS_PROFILE]);
    expect(scratches).toHaveLength(1);
    expect(scratches[0].recipe.loops[0].technique).toBe("transformer");
    expect(
      scratchCandidates(request).some(
        (c) => c.recipe.loops[0].technique === "crab",
      ),
    ).toBe(false);
  });

  it("a non-bold profile never reaches the crab, however hot the drop", () => {
    const scratches = scratchCandidates(crabReachableRequest(), [
      STANDARD_PROFILE,
    ]);
    expect(scratches.some((c) => c.recipe.loops[0].technique === "crab")).toBe(
      false,
    );
  });
});

describe("the crab spends the family's one price — no price of its own", () => {
  it("the conservative profile never authors a crab — it prices the FAMILY out of reach", () => {
    expect(
      scratchCandidates(crabReachableRequest(), [CONSERVATIVE_PROFILE]),
    ).toEqual([]);
  });

  it("a profile that prices scratch at 1 never authors a crab", () => {
    const pricedOut: DecisionProfile = {
      ...STANDARD_PROFILE,
      id: "priced-out",
      familyCosts: { ...STANDARD_PROFILE.familyCosts, scratch: 1 },
    };
    expect(scratchCandidates(crabReachableRequest(), [pricedOut])).toEqual([]);
  });

  it("the crab is SCORED, not vetoed — it stands or falls on evidence and the family cost", () => {
    const candidates = candidatesForPair(crabReachableRequest(), {
      profiles: [ADVENTUROUS_PROFILE],
    });
    const result = scoreCandidates(candidates, {}, ADVENTUROUS_PROFILE);
    const crab = result.ranked.find(
      (r) => r.candidate.recipe.loops[0]?.technique === "crab",
    );
    if (!crab) throw new Error("expected the crab candidate ranked");
    expect(crab.vetoed).toBe(false);
    expect(crab.candidate.family).toBe("scratch");
  });
});

// ---------------------------------------------------------------------
// Manual parity — the host's hand names the crab
// ---------------------------------------------------------------------

function manualVocalCurve(
  durationSec: number,
  activityAt: (t: number) => number,
): VocalActivityCurve {
  const points = [];
  for (let t = 0; t < durationSec; t += 0.25) {
    points.push({ timeSec: t, activity: activityAt(t), confidence: 1 });
  }
  return { windowSec: 0.25, stepSec: 0.25, points };
}

function manualSection(
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

/** The seams fixtures: a 60 s outgoing whose 20–30 s stretch is witnessed, silent and stabby. */
function manualOutgoing(): TrackAnalysis {
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
      manualSection("intro", 0, 8, 0.15, 0),
      manualSection("verse", 8, 24, 0.3, 0.85),
      manualSection("chorus", 24, 44, 0.5, 0.9),
      manualSection("chorus", 44, 60, 0.6, 0.9),
    ],
    vocalActivity: manualVocalCurve(60, (t) => (t >= 20 && t < 30 ? 0 : 0.9)),
  };
}

/** A 60 s incoming with real landings: an intro end and a drop. */
function manualIncoming(): TrackAnalysis {
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
      manualSection("intro", 0, 8, 0.15, 0),
      manualSection("chorus", 8, 32, 0.5, 0.9),
      manualSection("verse", 32, 60, 0.3, 0.85),
    ],
    intro: { startSec: 0, endSec: 8, startBeat: 0, endBeat: 16 },
    vocalActivity: manualVocalCurve(60, (t) => (t < 8 ? 0 : 0.9)),
  };
}

describe("authorManualScratch — the host names a crab", () => {
  it("performs the NAMED crab from the playhead, in the authored shape", () => {
    const recipe = authorManualScratch(
      {
        outgoing: manualOutgoing(),
        outgoingPositionSec: 20,
        incoming: manualIncoming(),
      },
      STANDARD_PROFILE,
      "crab",
    );
    if (!recipe) throw new Error("expected a manual crab");
    const block = recipe.loops[0];
    expect(block.type).toBe("scratch");
    expect(block.side).toBe("A");
    expect(block.technique).toBe("crab");
    expect(block.startMs).toBe(20_000);
    expect(block.beats).toBe(2);
    expect(block.strokes).toBe(2);
    expect(block.excursionBeats).toBe(0.5);
    expect(block.tapsPerStroke).toBe(3);
    expect(validateRecipe(recipe)).toEqual([]);
  });

  it("refuses a window over a lead vocal — the material gate stands for the host too", () => {
    expect(
      authorManualScratch(
        {
          outgoing: manualOutgoing(),
          outgoingPositionSec: 40,
          incoming: manualIncoming(),
        },
        STANDARD_PROFILE,
        "crab",
      ),
    ).toBeNull();
  });

  it("refuses an unwitnessed window — no curve, no sections, no guess", () => {
    const outgoing = {
      ...manualOutgoing(),
      vocalActivity: undefined,
      sections: [],
    };
    expect(
      authorManualScratch(
        {
          outgoing,
          outgoingPositionSec: 20,
          incoming: manualIncoming(),
        },
        STANDARD_PROFILE,
        "crab",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------
// §15 — recent scratch use shapes the crab's chances, never excludes
// ---------------------------------------------------------------------

/** A deterministic stream for the doctrine draws (an LCG; the draw discipline is selectFromBand's own). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function scratchRecord(at: number): JoinRecord {
  return {
    aAudioHash: "hash-a",
    bAudioHash: "hash-b",
    family: "scratch",
    profileId: "adventurous",
    pairShape: "test",
    blendBeats: 0,
    stretch: 0,
    heardLengthSec: 60,
    at,
  };
}

describe("§15 shaping — a performed crab counts, and history leans without excluding", () => {
  it("a performed crab counts as a scratch use in the weighted recent-use count", () => {
    // Join history records the FAMILY a join was performed
    // under; a crab join is written as family "scratch" (its
    // recipe's own reading), and the §28-weighted counter
    // counts it exactly once, evaluation-free.
    const crab = scratchCandidates(crabReachableRequest(), [
      ADVENTUROUS_PROFILE,
    ])[0];
    const record = scratchRecord(1);
    expect(record.family).toBe(familyOfRecipe(crab.recipe));
    expect(countRecentFamilyUsesWeighted([record], "scratch", 8)).toBe(1);
    expect(countRecentFamilyUsesWeighted([record], "long-blend", 8)).toBe(0);
  });

  it("seeded scratch history shrinks the crab's band share over 5,000 draws — and never zeroes it", () => {
    const candidates = candidatesForPair(crabReachableRequest(), {
      profiles: [ADVENTUROUS_PROFILE],
    });
    const crab = candidates.find(
      (c) => c.recipe.loops[0]?.technique === "crab",
    );
    const rival = candidates.find((c) => c.family !== "scratch");
    if (!crab || !rival) {
      throw new Error("expected a crab and a non-scratch rival");
    }
    const scored = (candidate: Candidate): ScoredCandidate => ({
      candidate,
      vetoed: false,
      vetoReasons: [],
      components: [],
      historyCost: 0,
      historyNotes: [],
      score: 0.8,
    });
    const crabScored = scored(crab);
    const band = [crabScored, scored(rival)];

    const history: JoinRecord[] = Array.from({ length: 6 }, (_, i) =>
      scratchRecord(i + 1),
    );

    // Record level first: the shaped read names the crab's six
    // recent uses and prices its probability below the clean
    // read's — shaping made visible, not just sampled.
    const clean = selectFromBand(band, {
      profile: STANDARD_PROFILE,
      history: [],
      random: seededRandom(7),
      seed: "crab-doctrine",
      scorerPick: null,
    }).record;
    const shaped = selectFromBand(band, {
      profile: STANDARD_PROFILE,
      history,
      random: seededRandom(7),
      seed: "crab-doctrine",
      scorerPick: null,
    }).record;
    const cleanCrab = clean.band.find((b) => b.family === "scratch");
    const shapedCrab = shaped.band.find((b) => b.family === "scratch");
    if (!cleanCrab || !shapedCrab) {
      throw new Error("expected the crab in both band records");
    }
    expect(cleanCrab.recentUses).toBe(0);
    expect(shapedCrab.recentUses).toBe(6);
    expect(shapedCrab.probability).toBeLessThan(cleanCrab.probability);
    expect(shapedCrab.probability).toBeGreaterThan(0);

    // The 5,000-draw eligibility form (R5's idiom): the crab
    // keeps winning sometimes under a heavy scratch history —
    // its share measurably shrinks, and it never reaches zero.
    const wins = (hist: readonly JoinRecord[]): number => {
      const random = seededRandom(987_654_321);
      let n = 0;
      for (let i = 0; i < 5000; i += 1) {
        const { chosen } = selectFromBand(band, {
          profile: STANDARD_PROFILE,
          history: hist,
          random,
          seed: "crab-doctrine",
          scorerPick: null,
        });
        if (chosen === crabScored) n += 1;
      }
      return n;
    };
    const cleanWins = wins([]);
    const shapedWins = wins(history);
    expect(cleanWins).toBeGreaterThan(0);
    expect(shapedWins).toBeGreaterThan(0);
    expect(shapedWins).toBeLessThan(cleanWins);
  });
});
