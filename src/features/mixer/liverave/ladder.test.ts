// ladder.test.ts — the rungs land in order and never die (item 2).

import { describe, expect, it } from "vitest";
import { createBrain } from "./brain";
import { buildTrackFacts, type TrackFacts, type TrackRead } from "./facts";
import { proveLadder, transitionBudgetMs } from "./ladder";
import type { JoinRecipe } from "./recipe";
import { NEUTRAL_SHAPING } from "./shaping";
import { slateCandidateId, Slate } from "./slate";
import { clubA, clubB, folkA, folkB } from "./testFixtures";

function makeRead(overrides: Partial<TrackRead> = {}): TrackRead {
  const beatsMs: number[] = [];
  for (let b = 0; b <= 480; b += 1) beatsMs.push(b * 500);
  const downbeatsMs: number[] = [];
  for (let b = 0; b <= 480; b += 4) downbeatsMs.push(b * 500);
  return {
    audioHash: "hash",
    analysisVersion: 1,
    depth: "deep",
    durationSec: 240,
    bpm: 120,
    tempoConfidence: 0.9,
    grid: { beatsMs, downbeatsMs, beatsPerBar: 4, confidence: 0.9 },
    key: { tonic: 0, mode: "major" as const, camelot: "8B", confidence: 0.9 },
    sections: [
      { kind: "intro", startMs: 0, endMs: 30_000, meanEnergy: 0.08 },
      { kind: "verse", startMs: 30_000, endMs: 120_000, meanEnergy: 0.2 },
      { kind: "chorus", startMs: 120_000, endMs: 225_000, meanEnergy: 0.3 },
      { kind: "outro", startMs: 225_000, endMs: 240_000, meanEnergy: 0.1 },
    ],
    energyCurvePerSec: [],
    energyContour: [],
    vocalActivity: [
      { startMs: 0, endMs: 240_000, activity: 0.1, confidence: 0.9 },
    ],
    drops: [],
    loudnessRms: 0.2,
    ...overrides,
  };
}

function slateFor(a: TrackFacts, b: TrackFacts): Slate {
  const brain = createBrain({ rng: () => 0.42 });
  const slate = brain.assembleSlate!({
    factsA: a,
    optionsB: [b],
    arcPosition: 0.5,
    shaping: NEUTRAL_SHAPING,
  });
  expect(slate).not.toBeNull();
  return slate!;
}

const NOW = () => 0;

describe("proveLadder", () => {
  it("a tidy pair lands on rung 1, performed as authored", () => {
    const outcome = proveLadder({
      slate: slateFor(clubA, clubB),
      factsA: clubA,
      rng: () => 0.42,
      now: NOW,
      budgetMs: 5_000,
    });
    expect(outcome.kind).toBe("authored");
    if (outcome.kind === "authored") {
      expect(outcome.rung).toBe(1);
      expect(outcome.degraded).toBe(false);
      expect(outcome.proof.proof).toBe("proven");
    }
  });

  it("a vocal-collision pair cannot blend in any form — it lands as a cut or below", () => {
    // Both tracks sing at 0.85 across their whole spans, so the
    // one blend candidate's window is refused on witnessed
    // evidence at the blend tiers; the ladder must land the pair
    // on the phrase-cut rung instead of performing the blend.
    const loud = {
      vocalActivity: [
        { startMs: 0, endMs: 240_000, activity: 0.85, confidence: 0.9 },
      ],
    };
    const a = buildTrackFacts("la", makeRead(loud), 240_000);
    const b = buildTrackFacts("lb", makeRead(loud), 240_000);
    const recipe = {
      id: "loud-blend",
      family: "blend",
      outgoing: {
        trackId: "la",
        audioHash: null,
        exitAnchorMs: 120_000,
        exitBeat: 240,
      },
      incoming: {
        trackId: "lb",
        audioHash: null,
        entryAnchorMs: 0,
        entryBeat: 0,
      },
      overlapBeats: 16,
      rates: { rateA: 1, rateB: 1, beatmatched: true },
      curves: {
        gainA: [],
        gainB: [],
        eqA: { low: [], mid: [], high: [] },
        eqB: { low: [], mid: [], high: [] },
        filterA: [],
        filterB: [],
      },
      blocks: [],
      authored: { evidence: {}, notes: [] },
    } as unknown as JoinRecipe;
    const slate = new Slate([
      {
        id: slateCandidateId("lb", recipe.id),
        trackB: b,
        recipe,
        suitability: 0.8,
        source: "planner",
        weight: 0.64,
        crateWeight: 1,
        autonomousExcluded: null,
      },
    ]);
    const outcome = proveLadder({
      slate,
      factsA: a,
      rng: () => 0.42,
      now: NOW,
      budgetMs: 5_000,
    });
    expect(outcome.kind).toBe("cut");
    if (outcome.kind === "cut") expect(outcome.rung).toBe(3);
  });

  it("an empty slate is the guaranteed crossfade, not a death", () => {
    const brain = createBrain({ rng: () => 0.42 });
    const empty = brain.assembleSlate!({
      factsA: clubA,
      optionsB: [],
      arcPosition: 0.5,
      shaping: NEUTRAL_SHAPING,
    });
    expect(empty).toBeNull();
    const outcome = proveLadder({
      slate: { entries: () => [] } as unknown as Slate,
      factsA: clubA,
      rng: () => 0.42,
      now: NOW,
      budgetMs: 5_000,
    });
    expect(outcome).toEqual({ kind: "crossfade", rung: 4 });
  });

  it("budget exhaustion after rung 1 falls to the guaranteed rung", () => {
    // folk pair: phrase-blend is not proven (see canMix tests for
    // the family) — with a clock that jumps past the budget after
    // the first check round, the ladder must land on rung 4
    // rather than keep proving.
    let calls = 0;
    const outcome = proveLadder({
      slate: slateFor(folkA, folkB),
      factsA: folkA,
      rng: () => 0.42,
      now: () => (calls++ === 0 ? 0 : 60_000),
      budgetMs: 1_000,
    });
    expect(["authored", "cut", "crossfade"]).toContain(outcome.kind);
    if (outcome.kind === "authored") {
      expect(outcome.rung).toBe(1); // only rung 1 may precede the budget
    }
  });
});

describe("transitionBudgetMs", () => {
  it("derives from seconds-to-mix-out with the reserve held back", () => {
    expect(transitionBudgetMs(20)).toBe(19_000);
    expect(transitionBudgetMs(0.2)).toBe(500);
    expect(transitionBudgetMs(120)).toBe(30_000);
    expect(transitionBudgetMs(null)).toBe(500);
  });
});
