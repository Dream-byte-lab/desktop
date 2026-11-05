import { describe, expect, it } from "vitest";
import { authorCandidates, fxKindsOfRecipe } from "./authors";
import {
  POOL_MIN_SUITABILITY,
  SUITABILITY_WEIGHTS,
  createBrain,
  suitabilityOf,
} from "./brain";
import { createPerformanceMemory } from "./memory";
import type { JoinFamily, JoinRecipe } from "./recipe";
import { NEUTRAL_SHAPING } from "./shaping";
import {
  clubA,
  clubB,
  distantB,
  dropA,
  dropB,
  folkB,
  popA,
  popB,
} from "./testFixtures";

/** Deterministic seeded RNG (mulberry32) for reproducible draws. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function handCandidate(
  family: JoinFamily,
  evidence: Record<string, number>,
): JoinRecipe {
  return {
    id: `hand-${family}`,
    family,
    outgoing: { trackId: "a", audioHash: null, exitAnchorMs: 0, exitBeat: 0 },
    incoming: { trackId: "b", audioHash: null, entryAnchorMs: 0, entryBeat: 0 },
    overlapBeats: 8,
    rates: { rateA: 1, rateB: 1, beatmatched: false },
    curves: {
      gainA: [{ atBeat: 0, value: 1 }],
      gainB: [{ atBeat: 0, value: 1 }],
      eqA: {
        low: [{ atBeat: 0, value: 1 }],
        mid: [{ atBeat: 0, value: 1 }],
        high: [{ atBeat: 0, value: 1 }],
      },
      eqB: {
        low: [{ atBeat: 0, value: 1 }],
        mid: [{ atBeat: 0, value: 1 }],
        high: [{ atBeat: 0, value: 1 }],
      },
      filterA: [{ atBeat: 0, value: 20_000 }],
      filterB: [{ atBeat: 0, value: 20_000 }],
    },
    blocks: [],
    authored: { evidence, notes: [] },
  };
}

describe("brain suitability — published weights, pair evidence only (§4 invariant 2)", () => {
  it("the weights sum to 1", () => {
    const sum = Object.values(SUITABILITY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1);
    expect(SUITABILITY_WEIGHTS).toEqual({
      tempoFit: 0.22,
      keyFit: 0.18,
      phraseFit: 0.15,
      structureFit: 0.15,
      energyFit: 0.12,
      vocalSafety: 0.18,
    });
  });

  it("identical evidence from different families gives identical suitability", () => {
    const evidence = {
      tempoFit: 0.9,
      keyFit: 0.8,
      phraseFit: 0.7,
      structureFit: 0.6,
      energyFit: 0.5,
      vocalSafety: 0.95,
    };
    const blend = handCandidate("blend", { ...evidence });
    const scratch = handCandidate("scratch-in", { ...evidence });
    const stop = handCandidate("stop-exit", { ...evidence });
    const brain = createBrain({ rng: mulberry32(1) });
    expect(brain.suitability(blend)).toBe(brain.suitability(scratch));
    expect(brain.suitability(blend)).toBe(brain.suitability(stop));
    expect(brain.suitability(blend)).toBeCloseTo(
      0.22 * 0.9 +
        0.18 * 0.8 +
        0.15 * 0.7 +
        0.15 * 0.6 +
        0.12 * 0.5 +
        0.18 * 0.95,
    );
    expect(suitabilityOf(blend)).toBe(brain.suitability(blend));
  });
});

describe("brain consider — the draw and the exposed pool", () => {
  it("returns null with no options, and a pick whose pool is fully exposed", () => {
    const brain = createBrain({ rng: mulberry32(7) });
    expect(
      brain.consider({
        factsA: clubA,
        optionsB: [],
        arcPosition: 0.5,
        shaping: NEUTRAL_SHAPING,
      }),
    ).toBeNull();

    const result = brain.consider({
      factsA: clubA,
      optionsB: [clubB],
      arcPosition: 0.5,
      shaping: NEUTRAL_SHAPING,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.trackB).toBe(clubB);
    expect(result.suitability).toBeGreaterThanOrEqual(POOL_MIN_SUITABILITY);

    // Amendment (2026-11-05): the pool the pick beat is exposed.
    expect(result.pool).toHaveLength(result.poolSize);
    expect(result.poolSize).toBeGreaterThan(10);
    for (const entry of result.pool) {
      expect(entry.trackId).toBe("club-b");
      expect(entry.suitability).toBeGreaterThanOrEqual(POOL_MIN_SUITABILITY);
      expect(Object.keys(entry.evidence).sort()).toEqual([
        "energyFit",
        "keyFit",
        "phraseFit",
        "structureFit",
        "tempoFit",
        "vocalSafety",
      ]);
    }
    // The pool is exactly the authored candidates at/above the floor.
    const expectedPoolSize = authorCandidates(clubA, clubB, {
      arcPosition: 0.5,
      shaping: NEUTRAL_SHAPING,
    }).candidates.filter(
      (c) => suitabilityOf(c) >= POOL_MIN_SUITABILITY,
    ).length;
    expect(result.poolSize).toBe(expectedPoolSize);
    // The pick itself is one of the exposed pool members.
    const pickInPool = result.pool.some(
      (entry) =>
        entry.trackId === result.trackB.trackId &&
        entry.family === result.recipe.family &&
        entry.technique === result.recipe.technique &&
        entry.suitability === result.suitability &&
        JSON.stringify(entry.fxKinds) ===
          JSON.stringify(fxKindsOfRecipe(result.recipe)),
    );
    expect(pickInPool).toBe(true);
  });

  it("the same seed reproduces the same pick", () => {
    const args = {
      factsA: clubA,
      optionsB: [clubB, popB],
      arcPosition: 0.5,
      shaping: NEUTRAL_SHAPING,
    };
    const first = createBrain({ rng: mulberry32(99) }).consider(args);
    const second = createBrain({ rng: mulberry32(99) }).consider(args);
    expect(first?.recipe.id).toBe(second?.recipe.id);
    expect(first?.trackB.trackId).toBe(second?.trackB.trackId);
  });

  it("draw distribution smoke: 600 seeded draws over the club pair", () => {
    const brain = createBrain({ rng: mulberry32(42) });
    const counts = new Map<string, number>();
    const draws = 600;
    for (let i = 0; i < draws; i += 1) {
      const result = brain.consider({
        factsA: clubA,
        optionsB: [clubB],
        arcPosition: 0.5,
        shaping: NEUTRAL_SHAPING,
      });
      expect(result).not.toBeNull();
      if (result) {
        counts.set(
          result.recipe.family,
          (counts.get(result.recipe.family) ?? 0) + 1,
        );
      }
    }
    const shares = [...counts.entries()]
      .map(([family, count]) => `${family} ${(count / draws).toFixed(3)}`)
      .join(", ");
    console.log(`draw distribution (600, seed 42): ${shares}`);
    expect(counts.size).toBeGreaterThanOrEqual(3);
    for (const [family, count] of counts) {
      expect(count / draws, family).toBeLessThanOrEqual(0.7);
    }
  });

  it("performance memory damps a saturated family in the draw", () => {
    const draws = 300;
    const freshBrain = createBrain({ rng: mulberry32(1234) });
    let freshBlends = 0;
    for (let i = 0; i < draws; i += 1) {
      const result = freshBrain.consider({
        factsA: clubA,
        optionsB: [clubB],
        arcPosition: 0.5,
        shaping: NEUTRAL_SHAPING,
      });
      if (result?.recipe.family === "blend") freshBlends += 1;
    }
    const memory = createPerformanceMemory();
    for (let i = 0; i < 12; i += 1) {
      memory.record({ family: "blend", fxKinds: [] });
    }
    const dampedBrain = createBrain({ rng: mulberry32(1234) });
    let dampedBlends = 0;
    for (let i = 0; i < draws; i += 1) {
      const result = dampedBrain.consider({
        factsA: clubA,
        optionsB: [clubB],
        arcPosition: 0.5,
        shaping: NEUTRAL_SHAPING,
        memory,
      });
      if (result?.recipe.family === "blend") dampedBlends += 1;
    }
    console.log(
      `blend share over ${draws} draws: fresh ${freshBlends}, memory-damped ${dampedBlends}`,
    );
    expect(dampedBlends).toBeLessThan(freshBlends);
  });

  it("considers multiple options and picks among their tracks", () => {
    const brain = createBrain({ rng: mulberry32(5) });
    const options = [popB, folkB, distantB];
    for (let i = 0; i < 20; i += 1) {
      const result = brain.consider({
        factsA: clubA,
        optionsB: options,
        arcPosition: 0.5,
        shaping: NEUTRAL_SHAPING,
      });
      expect(result).not.toBeNull();
      if (result) expect(options).toContain(result.trackB);
    }
  });
});

describe("brain assembleSet — greedy arc curation", () => {
  it("returns a permutation of the input ids with one join per step", () => {
    const brain = createBrain({ rng: mulberry32(3) });
    const list = [clubA, clubB, popA, popB, dropA, dropB];
    const set = brain.assembleSet(list, NEUTRAL_SHAPING);
    expect([...set.orderedIds].sort()).toEqual(
      list.map((f) => f.trackId).sort(),
    );
    expect(set.joins).toHaveLength(list.length - 1);
    for (let i = 0; i < set.joins.length; i += 1) {
      expect(set.joins[i].fromId).toBe(set.orderedIds[i]);
      expect(set.joins[i].toId).toBe(set.orderedIds[i + 1]);
      expect(set.joins[i].suitability).toBeGreaterThan(0);
    }
  });

  it("handles empty and single-track lists", () => {
    const brain = createBrain({ rng: mulberry32(3) });
    expect(brain.assembleSet([], NEUTRAL_SHAPING)).toEqual({
      orderedIds: [],
      joins: [],
    });
    expect(brain.assembleSet([clubA], NEUTRAL_SHAPING)).toEqual({
      orderedIds: ["club-a"],
      joins: [],
    });
  });
});
