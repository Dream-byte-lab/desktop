// Selection (R5) — the §16/§15 mechanism, proven without ears.
//
// The properties the revamp stakes on this module:
//   · reproducibility — same seed + same session state ⇒ the same
//     pick sequence, exactly;
//   · divergence — different session seeds ⇒ distributions that
//     actually differ, converging on the softmax probabilities;
//   · vetoes are absolute — an excluded candidate's mass is
//     exactly zero, not small;
//   · the §16 floor holds at extremes;
//   · §15's penalty matches its formula and never excludes;
//   · temperature orders temperament — conservative concentrates
//     on the argmax far more than adventurous;
//   · R4's bends (creativity's band, track-selection freedom's
//     epsilon/incumbency) move the distribution the documented way.
//
// Distribution assertions run over SEEDED streams, so they are
// deterministic: the tolerances below are several standard errors
// wide, and a failure means the mechanism changed, not luck.

import { describe, expect, it } from "vitest";
import {
  ADVENTUROUS_PROFILE,
  CONSERVATIVE_PROFILE,
  STANDARD_PROFILE,
  type DecisionProfile,
} from "./decisionProfile";
import type { JoinRecord } from "./joinHistory";
import { DEFAULT_SLIDERS, resolveDecisionSettings } from "./personality";
import type { ScoredCandidate } from "./scoring";
import {
  MIN_TEMPERATURE,
  chooseBySoftmax,
  clampTemperature,
  countRecentFamilyUses,
  createSeededRandom,
  decisionSeed,
  hashSeed,
  randomForDecision,
  recentUseMultiplier,
  recentUsePenalty,
  recentUseSensitivity,
  selectFromBand,
  selectTrackCandidate,
  softmaxProbabilities,
  temperatureForProfile,
  type SoftmaxEntry,
} from "./selection";

function frequencies(
  entries: readonly SoftmaxEntry[],
  options: { temperature: number; sensitivity?: number; seed: string },
  draws: number,
): number[] {
  const random = createSeededRandom(options.seed);
  const counts = entries.map(() => 0);
  for (let i = 0; i < draws; i += 1) {
    const outcome = chooseBySoftmax(entries, {
      temperature: options.temperature,
      sensitivity: options.sensitivity ?? 0,
      random,
    });
    counts[outcome.index] += 1;
  }
  return counts.map((c) => c / draws);
}

describe("the seeded generator", () => {
  it("reproduces its stream exactly from the same seed", () => {
    const a = createSeededRandom("linerave#1#1");
    const b = createSeededRandom("linerave#1#1");
    const streamA = Array.from({ length: 100 }, () => a());
    const streamB = Array.from({ length: 100 }, () => b());
    expect(streamA).toEqual(streamB);
    for (const value of streamA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("diverges for different seeds, and hashes stably", () => {
    expect(hashSeed("alpha")).toBe(hashSeed("alpha"));
    expect(hashSeed("alpha")).not.toBe(hashSeed("beta"));
    const a = createSeededRandom("alpha");
    const b = createSeededRandom("beta");
    const streamA = Array.from({ length: 20 }, () => a());
    const streamB = Array.from({ length: 20 }, () => b());
    expect(streamA).not.toEqual(streamB);
  });

  it("keys decision streams by (session seed, set, decision)", () => {
    expect(decisionSeed("s", 2, 3)).toBe("s#2#3");
    const first = randomForDecision("s", 1, 1);
    const replay = randomForDecision("s", 1, 1);
    expect(first()).toBe(replay());
    const nextDecision = randomForDecision("s", 1, 2);
    expect(nextDecision()).not.toBe(randomForDecision("s", 1, 1)());
  });
});

describe("§16 — the softmax core", () => {
  it("matches exp((s − max) / T), normalised, at hand-computed points", () => {
    const { probabilities } = softmaxProbabilities(
      [{ score: 0.9 }, { score: 0.87 }, { score: 0.84 }],
      0.05,
      0,
    );
    // weights: 1, exp(−0.6) ≈ 0.5488, exp(−1.2) ≈ 0.3012
    expect(probabilities[0]).toBeCloseTo(0.5405, 3);
    expect(probabilities[1]).toBeCloseTo(0.2967, 3);
    expect(probabilities[2]).toBeCloseTo(0.1628, 3);
    expect(probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it("gives an ineligible (vetoed) entry exactly zero mass, forever", () => {
    const entries: SoftmaxEntry[] = [
      { score: 0.9 },
      { score: 0.99, eligible: false }, // the best score, and vetoed
      { score: 0.88 },
    ];
    const { probabilities } = softmaxProbabilities(entries, 0.05, 0);
    expect(probabilities[1]).toBe(0);
    const random = createSeededRandom("veto");
    for (let i = 0; i < 5_000; i += 1) {
      const outcome = chooseBySoftmax(entries, {
        temperature: 0.05,
        random,
      });
      expect(outcome.index).not.toBe(1);
    }
  });

  it("floors the temperature at §16's 0.01, at every extreme", () => {
    expect(MIN_TEMPERATURE).toBe(0.01);
    expect(clampTemperature(0)).toBe(0.01);
    expect(clampTemperature(-3)).toBe(0.01);
    expect(clampTemperature(Number.NaN)).toBe(0.01);
    expect(clampTemperature(0.05)).toBe(0.05);
    // A million-point gap at the floor: no NaN, the argmax takes all.
    const { probabilities } = softmaxProbabilities(
      [{ score: 1_000_000 }, { score: 0 }],
      0.001, // below the floor on purpose
      0,
    );
    expect(probabilities[0]).toBeCloseTo(1, 12);
    expect(probabilities[1]).toBe(0);
    // Identical scores share the mass evenly at any temperature.
    const even = softmaxProbabilities(
      [{ score: 0.5 }, { score: 0.5 }, { score: 0.5 }],
      0.01,
      0,
    );
    for (const p of even.probabilities) expect(p).toBeCloseTo(1 / 3, 9);
  });

  it("converges on the softmax distribution over many seeded draws", () => {
    const entries: SoftmaxEntry[] = [
      { score: 0.9 },
      { score: 0.87 },
      { score: 0.84 },
    ];
    const expected = softmaxProbabilities(entries, 0.05, 0).probabilities;
    const observed = frequencies(
      entries,
      { temperature: 0.05, seed: "distribution" },
      20_000,
    );
    for (let i = 0; i < entries.length; i += 1) {
      expect(Math.abs(observed[i] - expected[i])).toBeLessThan(0.015);
    }
  });

  it("orders temperament: conservative concentrates on the argmax far more than adventurous", () => {
    const field: SoftmaxEntry[] = [
      { score: 0.9 },
      { score: 0.88 },
      { score: 0.86 },
      { score: 0.84 },
    ];
    const conservative = frequencies(
      field,
      {
        temperature: temperatureForProfile(CONSERVATIVE_PROFILE),
        seed: "temperament",
      },
      20_000,
    );
    const adventurous = frequencies(
      field,
      {
        temperature: temperatureForProfile(ADVENTUROUS_PROFILE),
        seed: "temperament",
      },
      20_000,
    );
    // Hand-computed argmax shares: ≈0.523 at T=0.03, ≈0.339 at T=0.09.
    expect(conservative[0]).toBeGreaterThan(0.48);
    expect(adventurous[0]).toBeLessThan(0.38);
    expect(conservative[0] - adventurous[0]).toBeGreaterThan(0.1);
  });
});

describe("temperature — derived from the profile's band", () => {
  it("is the near-equal band, ordered by temperament, floored at 0.01", () => {
    expect(temperatureForProfile(CONSERVATIVE_PROFILE)).toBe(0.03);
    expect(temperatureForProfile(STANDARD_PROFILE)).toBe(0.05);
    expect(temperatureForProfile(ADVENTUROUS_PROFILE)).toBe(0.09);
    const synthetic: DecisionProfile = {
      ...STANDARD_PROFILE,
      nearEqualBand: 0,
    };
    expect(temperatureForProfile(synthetic)).toBe(0.01);
  });

  it("makes the band edge exactly the e-fold point (the near-equal invariant)", () => {
    const band = STANDARD_PROFILE.nearEqualBand;
    const { probabilities } = softmaxProbabilities(
      [{ score: 1 }, { score: 1 - band }],
      temperatureForProfile(STANDARD_PROFILE),
      0,
    );
    expect(probabilities[1] / probabilities[0]).toBeCloseTo(Math.exp(-1), 9);
  });

  it("is bent by creativity through the resolved band (R4's dial)", () => {
    const neutral = resolveDecisionSettings("autonomous", DEFAULT_SLIDERS);
    expect(temperatureForProfile(neutral.profile)).toBe(0.05);
    const creative = resolveDecisionSettings("autonomous", {
      ...DEFAULT_SLIDERS,
      creativity: 1,
    });
    expect(temperatureForProfile(creative.profile)).toBeCloseTo(0.08, 12);
    const restrained = resolveDecisionSettings("autonomous", {
      ...DEFAULT_SLIDERS,
      creativity: 0,
    });
    expect(temperatureForProfile(restrained.profile)).toBeCloseTo(0.02, 12);
    // And the bend moves the distribution the documented way:
    // a hotter temperature flattens the lottery.
    const field: SoftmaxEntry[] = [
      { score: 0.9 },
      { score: 0.88 },
      { score: 0.86 },
    ];
    const flat = frequencies(
      field,
      { temperature: 0.08, seed: "creativity" },
      20_000,
    );
    const sharp = frequencies(
      field,
      { temperature: 0.02, seed: "creativity" },
      20_000,
    );
    expect(sharp[0]).toBeGreaterThan(flat[0] + 0.1);
  });
});

describe("§15 — recent-use shaping (probability only, never exclusion)", () => {
  it("matches clamp(1 − exp(−sensitivity × recentUses)) at sampled points", () => {
    expect(recentUsePenalty(0, 0.1)).toBe(0);
    expect(recentUsePenalty(1, 0.1)).toBeCloseTo(0.0951626, 6);
    expect(recentUsePenalty(2, 0.1)).toBeCloseTo(0.1812692, 6);
    expect(recentUsePenalty(5, 0.1)).toBeCloseTo(0.3934693, 6);
    expect(recentUsePenalty(10, 0.1)).toBeCloseTo(0.6321206, 6);
    // Monotone, bounded, and only asymptotic to full penalty.
    expect(recentUsePenalty(3, 0.1)).toBeGreaterThan(recentUsePenalty(2, 0.1));
    expect(recentUsePenalty(100, 0.1)).toBeLessThan(1);
    expect(recentUsePenalty(100, 0.1)).toBeGreaterThan(0.9999);
  });

  it("never reaches a hard zero: the multiplier stays positive at any finite use count", () => {
    expect(recentUseMultiplier(0, 0.1)).toBe(1);
    expect(recentUseMultiplier(1, 0.1)).toBeCloseTo(Math.exp(-0.1), 12);
    expect(recentUseMultiplier(1_000, 0.1)).toBeGreaterThan(0);
    // …so even a thousand-times-used candidate keeps nonzero mass.
    const { probabilities } = softmaxProbabilities(
      [{ score: 0.9, recentUses: 1_000 }, { score: 0.9 }],
      0.05,
      0.1,
    );
    expect(probabilities[0]).toBeGreaterThan(0);
  });

  it("leans the lottery away from what the room just heard", () => {
    const field: SoftmaxEntry[] = [
      { score: 0.9, recentUses: 5 },
      { score: 0.9, recentUses: 0 },
    ];
    const shaped = frequencies(
      field,
      {
        temperature: 0.05,
        sensitivity: recentUseSensitivity(ADVENTUROUS_PROFILE),
        seed: "shaping",
      },
      20_000,
    );
    // exp(−0.16 × 5) ≈ 0.449 → shares ≈ 0.31 / 0.69.
    expect(shaped[0]).toBeLessThan(0.36);
    expect(shaped[1]).toBeGreaterThan(0.64);
    const unshaped = frequencies(
      field,
      { temperature: 0.05, sensitivity: 0, seed: "shaping" },
      20_000,
    );
    expect(unshaped[0]).toBeCloseTo(0.5, 0.02);
  });

  it("takes its sensitivity from the profile's anti-repetition constant", () => {
    expect(recentUseSensitivity(STANDARD_PROFILE)).toBe(0.1);
    expect(recentUseSensitivity(CONSERVATIVE_PROFILE)).toBe(0.06);
    expect(recentUseSensitivity(ADVENTUROUS_PROFILE)).toBe(0.16);
  });

  it("counts recent uses inside the profile's window only", () => {
    const record = (family: JoinRecord["family"]): JoinRecord => ({
      aAudioHash: "a",
      bAudioHash: "b",
      family,
      profileId: "standard",
      pairShape: "matched/same/both-vocal",
      blendBeats: 16,
      stretch: 0,
      heardLengthSec: 100,
      at: 0,
    });
    const history: JoinRecord[] = [
      record("drop-cut"), // outside a 3-window once four more land
      record("standard-blend"),
      record("drop-cut"),
      record("standard-blend"),
      record("standard-blend"),
    ];
    expect(countRecentFamilyUses(history, "standard-blend", 12)).toBe(3);
    expect(countRecentFamilyUses(history, "standard-blend", 3)).toBe(2);
    expect(countRecentFamilyUses(history, "drop-cut", 3)).toBe(1);
    expect(countRecentFamilyUses([], "drop-cut", 12)).toBe(0);
  });
});

describe("reproducibility and divergence of pick sequences", () => {
  const field: SoftmaxEntry[] = [
    { score: 0.9 },
    { score: 0.885 },
    { score: 0.87 },
    { score: 0.86 },
  ];

  function pickSequence(sessionSeed: string, decisions: number): number[] {
    const picks: number[] = [];
    for (let d = 1; d <= decisions; d += 1) {
      const outcome = chooseBySoftmax(field, {
        temperature: 0.05,
        random: randomForDecision(sessionSeed, 1, d),
      });
      picks.push(outcome.index);
    }
    return picks;
  }

  it("replays a session's picks exactly from the same coordinates", () => {
    expect(pickSequence("linerave", 60)).toEqual(pickSequence("linerave", 60));
  });

  it("draws a different sequence for a different session", () => {
    const a = pickSequence("linerave", 60);
    const b = pickSequence("another-night", 60);
    expect(a).not.toEqual(b);
    const differing = a.filter((pick, i) => pick !== b[i]).length;
    expect(differing).toBeGreaterThan(15);
  });
});

describe("selectFromBand — the engine adapter", () => {
  function scored(
    family: ScoredCandidate["candidate"]["family"],
    score: number,
    historyCost = 0,
  ): ScoredCandidate {
    return {
      candidate: { family },
      vetoed: false,
      vetoReasons: [],
      components: [],
      historyCost,
      historyNotes: [],
      score,
    } as unknown as ScoredCandidate;
  }

  it("spends exactly one draw and returns the only member of a singleton band", () => {
    let draws = 0;
    const random = () => {
      draws += 1;
      return 0.42;
    };
    const only = scored("standard-blend", 0.9);
    const { chosen, record } = selectFromBand([only], {
      profile: STANDARD_PROFILE,
      history: [],
      random,
      seed: "s#1#1",
      scorerPick: only,
    });
    expect(draws).toBe(1);
    expect(chosen).toBe(only);
    expect(record.band).toHaveLength(1);
    expect(record.band[0].probability).toBe(1);
    expect(record.agreedWithScorer).toBe(true);
    expect(record.temperature).toBe(0.05);
    expect(record.seed).toBe("s#1#1");
  });

  it("records every band member's probability, summing to 1", () => {
    const band = [
      scored("standard-blend", 0.9),
      scored("short-blend", 0.875),
      scored("loop-extended-blend", 0.865),
    ];
    const { chosen, record } = selectFromBand(band, {
      profile: STANDARD_PROFILE,
      history: [],
      random: createSeededRandom("record"),
      seed: "s#1#2",
      scorerPick: band[0],
    });
    expect(band).toContain(chosen);
    const total = record.band.reduce((sum, b) => sum + b.probability, 0);
    expect(total).toBeCloseTo(1, 12);
    expect(record.band.map((b) => b.family)).toEqual([
      "standard-blend",
      "short-blend",
      "loop-extended-blend",
    ]);
    expect(record.chosenIndex).toBe(band.indexOf(chosen));
  });

  it("charges §15 uses from the history the caller supplies", () => {
    const band = [scored("standard-blend", 0.9), scored("short-blend", 0.9)];
    const history: JoinRecord[] = Array.from({ length: 3 }, () => ({
      aAudioHash: "a",
      bAudioHash: "b",
      family: "standard-blend" as const,
      profileId: "standard",
      pairShape: "matched/same/both-vocal",
      blendBeats: 16,
      stretch: 0,
      heardLengthSec: 100,
      at: 0,
    }));
    const { record } = selectFromBand(band, {
      profile: STANDARD_PROFILE,
      history,
      random: createSeededRandom("uses"),
      seed: "s#1#3",
      scorerPick: band[0],
    });
    expect(record.band[0].recentUses).toBe(3);
    expect(record.band[0].penalty).toBeCloseTo(1 - Math.exp(-0.3), 9);
    expect(record.band[1].recentUses).toBe(0);
    expect(record.band[0].probability).toBeLessThan(record.band[1].probability);
  });

  it("holds the no-transition family out of the lottery while a performed join stands in the band", () => {
    const band = [
      scored("standard-blend", 0.901),
      scored("short-blend", 0.881),
      scored("let-it-play", 0.895),
    ];
    const random = createSeededRandom("restraint");
    for (let i = 0; i < 2_000; i += 1) {
      const { chosen, record } = selectFromBand(band, {
        profile: STANDARD_PROFILE,
        history: [],
        random,
        seed: "s#1#4",
        scorerPick: band[0],
      });
      expect(chosen.candidate.family).not.toBe("let-it-play");
      expect(record.restraintHeld).toEqual([
        { family: "let-it-play", score: 0.895 },
      ]);
      expect(record.band.map((b) => b.family)).toEqual([
        "standard-blend",
        "short-blend",
      ]);
    }
  });

  it("performs the no-transition family when the band holds nothing else (evidence elected it)", () => {
    const lip = scored("let-it-play", 0.9);
    const { chosen, record } = selectFromBand([lip], {
      profile: STANDARD_PROFILE,
      history: [],
      random: () => 0.5,
      seed: "s#1#5",
      scorerPick: lip,
    });
    expect(chosen).toBe(lip);
    expect(record.restraintHeld).toEqual([]);
    expect(record.agreedWithScorer).toBe(true);
  });

  it("does not hold early-cut out: a boundary cut performs a transition", () => {
    const band = [scored("let-it-play", 0.9), scored("early-cut", 0.88)];
    const { chosen, record } = selectFromBand(band, {
      profile: STANDARD_PROFILE,
      history: [],
      random: () => 0.5,
      seed: "s#1#6",
      scorerPick: band[0],
    });
    expect(chosen.candidate.family).toBe("early-cut");
    expect(record.restraintHeld).toEqual([
      { family: "let-it-play", score: 0.9 },
    ]);
  });
});

describe("selectTrackCandidate — the R6 entry point", () => {
  interface Track {
    id: string;
  }
  const entries = [
    { item: { id: "a" } as Track, score: 1.0, incumbent: true },
    { item: { id: "b" } as Track, score: 0.97 },
    { item: { id: "c" } as Track, score: 0.9 },
  ];

  it("returns null for an empty field", () => {
    expect(
      selectTrackCandidate([], {
        epsilon: 0.05,
        incumbencyPenalty: 0.1,
        temperature: 0.05,
        random: () => 0.5,
      }),
    ).toBeNull();
  });

  it("admits only the epsilon band; outside entries carry exactly zero", () => {
    const random = createSeededRandom("tracks");
    for (let i = 0; i < 3_000; i += 1) {
      const result = selectTrackCandidate(entries, {
        epsilon: 0.05,
        incumbencyPenalty: 0.1,
        temperature: 0.05,
        random,
      })!;
      expect(result.bandSize).toBe(2);
      expect(result.entry.item.id).not.toBe("c");
      expect(result.probabilities[2]).toBe(0);
      expect(entries).toContain(result.entry);
    }
  });

  it("spends the incumbency penalty as the incumbent's head start", () => {
    const share = (incumbencyPenalty: number): number => {
      const random = createSeededRandom("incumbency");
      let incumbentWins = 0;
      const draws = 10_000;
      for (let i = 0; i < draws; i += 1) {
        const result = selectTrackCandidate(entries, {
          epsilon: 0.05,
          incumbencyPenalty,
          temperature: 0.05,
          random,
        })!;
        if (result.entry.item.id === "a") incumbentWins += 1;
      }
      return incumbentWins / draws;
    };
    // No head start: a leads on score alone (1.00 vs 0.97 at T .05 → ≈0.65).
    expect(share(0)).toBeGreaterThan(0.55);
    expect(share(0)).toBeLessThan(0.75);
    // A 0.2 head start at T 0.05 is decisive but not absolute.
    expect(share(0.2)).toBeGreaterThan(0.9);
  });

  it("widens with track-selection freedom's epsilon (R4's resolved values)", () => {
    const bent = resolveDecisionSettings("autonomous", {
      ...DEFAULT_SLIDERS,
      "track-selection-freedom": 1,
    });
    // epsilon 0.05 × (1 + 1.6 × 0.5) = 0.09 — still short of c's 0.10 gap…
    expect(bent.curation.nearEqualEpsilon).toBeCloseTo(0.09, 12);
    const result = selectTrackCandidate(entries, {
      epsilon: bent.curation.nearEqualEpsilon,
      incumbencyPenalty: bent.curation.incumbencyPenalty,
      temperature: 0.05,
      random: () => 0.5,
    })!;
    expect(result.bandSize).toBe(2);
    // …while a hand-widened epsilon of 0.11 admits all three.
    const wide = selectTrackCandidate(entries, {
      epsilon: 0.11,
      incumbencyPenalty: 0.1,
      temperature: 0.05,
      random: () => 0.5,
    })!;
    expect(wide.bandSize).toBe(3);
  });
});
