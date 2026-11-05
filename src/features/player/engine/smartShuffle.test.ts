// Smart Shuffle ordering — the pure layer, proven without ears:
// determinism under a seed, variety across seeds, cold-start
// honesty (a good seeded shuffle, never the identity order
// labelled smart), artist separation, taste surfacing, recency
// rest, neighbour flow, and the guest gates (never first, ratio
// at every prefix).

import { describe, expect, it } from "vitest";
import {
  emptyProfile,
  type TasteProfile,
} from "@/features/mixer/engine/tasteProfile";
import {
  maxGuestsFor,
  mulberry32,
  smartShuffleOrder,
  smartStaticScores,
  type SmartCandidateInput,
} from "./smartShuffle";

const NOW = 1_700_000_000_000;

function profile(overrides: Partial<TasteProfile> = {}): TasteProfile {
  return {
    artists: {},
    tags: {},
    tracks: {},
    updatedAtMs: NOW,
    ...overrides,
  };
}

function cand(
  id: string,
  artist: string,
  extra: Partial<SmartCandidateInput> = {},
): SmartCandidateInput {
  return { trackId: id, artist, artistKey: artist.toLowerCase(), ...extra };
}

function ids(list: readonly SmartCandidateInput[]): string[] {
  return list.map((c) => c.trackId);
}

describe("mulberry32", () => {
  it("reproduces its stream per seed and diverges across seeds", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const streamA = [a(), a(), a(), a(), a()];
    expect([b(), b(), b(), b(), b()]).toEqual(streamA);
    expect([c(), c(), c(), c(), c()]).not.toEqual(streamA);
    for (const value of streamA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("maxGuestsFor — at most one guest in four", () => {
  it("is a quarter of the resulting queue, counted honestly", () => {
    expect(maxGuestsFor(0)).toBe(0);
    expect(maxGuestsFor(2)).toBe(0);
    expect(maxGuestsFor(3)).toBe(1);
    expect(maxGuestsFor(5)).toBe(1);
    expect(maxGuestsFor(6)).toBe(2);
    expect(maxGuestsFor(11)).toBe(3);
    expect(maxGuestsFor(12)).toBe(4);
    expect(maxGuestsFor(-4)).toBe(0);
  });
});

describe("smartShuffleOrder — determinism and variety", () => {
  const dozen = Array.from({ length: 12 }, (_, i) =>
    cand(`t${i}`, `Artist ${i % 6}`),
  );

  it("reproduces the same order for the same seed", () => {
    const input = {
      current: null,
      candidates: dozen,
      profile: emptyProfile(),
      nowMs: NOW,
      recentPlays: [],
    };
    expect(ids(smartShuffleOrder({ ...input, seed: 42 }))).toEqual(
      ids(smartShuffleOrder({ ...input, seed: 42 })),
    );
  });

  it("returns a complete permutation and varies across seeds", () => {
    const input = {
      current: null,
      candidates: dozen,
      profile: emptyProfile(),
      nowMs: NOW,
      recentPlays: [],
    };
    const orders = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const out = smartShuffleOrder({ ...input, seed });
      expect(out).toHaveLength(dozen.length);
      expect([...ids(out)].sort()).toEqual([...ids(dozen)].sort());
      orders.add(ids(out).join(","));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it("cold start is a real shuffle, not the identity order in a costume", () => {
    const out = smartShuffleOrder({
      current: null,
      candidates: dozen,
      profile: emptyProfile(),
      nowMs: NOW,
      recentPlays: [],
      seed: 7,
    });
    expect(ids(out)).not.toEqual(ids(dozen));
  });

  it("handles empty and single-candidate inputs", () => {
    const base = {
      current: null,
      profile: emptyProfile(),
      nowMs: NOW,
      recentPlays: [],
      seed: 1,
    };
    expect(smartShuffleOrder({ ...base, candidates: [] })).toEqual([]);
    const one = [cand("only", "Solo")];
    expect(smartShuffleOrder({ ...base, candidates: one })).toEqual(one);
  });
});

describe("smartShuffleOrder — artist separation", () => {
  it("does not open with the playing track's artist when an alternative exists", () => {
    const out = smartShuffleOrder({
      current: cand("now", "Alpha"),
      candidates: [cand("a2", "Alpha"), cand("b1", "Beta")],
      profile: emptyProfile(),
      nowMs: NOW,
      recentPlays: [],
      seed: 3,
    });
    expect(out[0].trackId).toBe("b1");
  });

  it("keeps same-artist adjacencies to the unavoidable endgame", () => {
    const pairs = Array.from({ length: 6 }, (_, a) => [
      cand(`a${a}x`, `Artist ${a}`),
      cand(`a${a}y`, `Artist ${a}`),
    ]).flat();
    for (let seed = 1; seed <= 20; seed++) {
      const out = smartShuffleOrder({
        current: null,
        candidates: pairs,
        profile: emptyProfile(),
        nowMs: NOW,
        recentPlays: [],
        seed,
      });
      let adjacencies = 0;
      for (let i = 1; i < out.length; i++) {
        if (out[i].artist === out[i - 1].artist) adjacencies += 1;
      }
      expect(adjacencies).toBeLessThanOrEqual(1);
    }
  });

  it("still orders a single-artist playlist completely", () => {
    const mono = Array.from({ length: 5 }, (_, i) => cand(`m${i}`, "Mono"));
    const out = smartShuffleOrder({
      current: null,
      candidates: mono,
      profile: emptyProfile(),
      nowMs: NOW,
      recentPlays: [],
      seed: 9,
    });
    expect([...ids(out)].sort()).toEqual([...ids(mono)].sort());
  });
});

describe("smartShuffleOrder — taste and recency", () => {
  it("static scores normalise taste and sink the recently heard", () => {
    const candidates = [cand("x", "X"), cand("y", "Y"), cand("z", "Z")];
    const scores = smartStaticScores(
      candidates,
      profile({ artists: { X: 4, Y: 2, Z: -2 } }),
      ["x", "y"],
    );
    expect(scores[0].taste).toBe(1);
    expect(scores[1].taste).toBe(0.5);
    expect(scores[2].taste).toBe(-1);
    expect(scores[0].recencySink).toBeCloseTo(0.5);
    expect(scores[1].recencySink).toBeCloseTo(0.5 * Math.exp(-0.2));
    expect(scores[2].recencySink).toBe(0);
  });

  it("surfaces the loved artist at the head of the order", () => {
    const candidates = [
      cand("o1", "Other 1"),
      cand("b1", "Beloved"),
      cand("o2", "Other 2"),
      cand("b2", "Beloved"),
      cand("o3", "Other 3"),
      cand("b3", "Beloved"),
    ];
    for (const seed of [1, 2, 3, 4]) {
      const out = smartShuffleOrder({
        current: null,
        candidates,
        profile: profile({ artists: { Beloved: 5 } }),
        nowMs: NOW,
        recentPlays: [],
        seed,
      });
      // Artist separation spreads the loved artist through the head
      // rather than stacking them: the earliest slots separation
      // allows are 0, 2 and 4, and taste claims all three.
      const belovedPositions = out
        .map((entry, index) => (entry.artist === "Beloved" ? index : -1))
        .filter((index) => index >= 0);
      expect(belovedPositions).toEqual([0, 2, 4]);
    }
  });

  it("rests a just-heard track behind an otherwise equal fresh one", () => {
    const candidates = [cand("heard", "A"), cand("fresh", "B")];
    for (let seed = 1; seed <= 10; seed++) {
      const out = smartShuffleOrder({
        current: null,
        candidates,
        profile: emptyProfile(),
        nowMs: NOW,
        recentPlays: ["heard"],
        seed,
      });
      expect(out[0].trackId).toBe("fresh");
    }
  });
});

describe("smartShuffleOrder — flow", () => {
  it("follows the playing track's tempo and energy when facts exist", () => {
    const candidates = [cand("near", "A"), cand("far", "B")];
    const facts = new Map([
      ["near", { bpm: 122, energy: 0.52 }],
      ["far", { bpm: 70, energy: 0.95 }],
    ]);
    for (let seed = 1; seed <= 10; seed++) {
      const out = smartShuffleOrder({
        current: cand("now", "Current"),
        currentFacts: { bpm: 120, energy: 0.5 },
        candidates,
        factsById: facts,
        profile: emptyProfile(),
        nowMs: NOW,
        recentPlays: [],
        seed,
      });
      expect(out[0].trackId).toBe("near");
    }
  });

  it("orders completely when no facts exist at all", () => {
    const candidates = [cand("a", "A"), cand("b", "B"), cand("c", "C")];
    const out = smartShuffleOrder({
      current: cand("now", "Current"),
      currentFacts: null,
      candidates,
      profile: emptyProfile(),
      nowMs: NOW,
      recentPlays: [],
      seed: 5,
    });
    expect([...ids(out)].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("smartShuffleOrder — guest gates", () => {
  it("never opens with a guest and holds the ratio at every prefix", () => {
    const playlist = Array.from({ length: 6 }, (_, i) =>
      cand(`p${i}`, `Artist ${i}`),
    );
    const guests = [cand("g1", "Guest 1", { guest: true })];
    const out = smartShuffleOrder({
      current: null,
      candidates: [...playlist, ...guests],
      profile: emptyProfile(),
      nowMs: NOW,
      recentPlays: [],
      seed: 11,
    });
    expect(out).toHaveLength(7);
    expect(out[0].guest).toBeUndefined();
    expect(out.findIndex((c) => c.guest)).toBeGreaterThanOrEqual(3);
    let guestCount = 0;
    out.forEach((entry, index) => {
      if (entry.guest) guestCount += 1;
      expect(guestCount * 4).toBeLessThanOrEqual(index + 1);
    });
  });

  it("places the single guest of a tiny queue at its tail", () => {
    const playlist = [cand("p0", "A"), cand("p1", "B"), cand("p2", "C")];
    const out = smartShuffleOrder({
      current: null,
      candidates: [...playlist, cand("g", "G", { guest: true })],
      profile: emptyProfile(),
      nowMs: NOW,
      recentPlays: [],
      seed: 2,
    });
    expect(out[out.length - 1].trackId).toBe("g");
  });
});
