// §28 → §15 feedback (R6): the evaluations recordPerformed
// persists must actually move later selections — as probability
// SHAPING only (§15 doctrine: shaping, never exclusion). A
// family whose joins keep grading badly counts heavier in the
// recent-use memory, so the lottery leans away from it; a
// family with no evaluations counts exactly as it did before
// R6 (parity), and a malformed evaluation is ignored rather
// than trusted.

import { describe, expect, it } from "vitest";
import { STANDARD_PROFILE } from "./decisionProfile";
import {
  evaluationOf,
  type JoinEvaluation,
  type JoinRecord,
} from "./joinHistory";
import type { ScoredCandidate } from "./scoring";
import {
  countRecentFamilyUses,
  countRecentFamilyUsesWeighted,
  evaluationUseWeight,
  selectFromBand,
} from "./selection";

function record(
  family: string,
  evaluation?: JoinEvaluation | unknown,
): JoinRecord {
  return {
    aAudioHash: "hash-a",
    bAudioHash: "hash-b",
    family,
    profileId: "standard",
    pairShape: "similar",
    blendBeats: 32,
    stretch: 0,
    heardLengthSec: 180,
    at: 1_000,
    ...(evaluation !== undefined ? { evaluation } : {}),
  } as unknown as JoinRecord;
}

function evaluation(overall: number): JoinEvaluation {
  return {
    beatAlignment: overall,
    loudnessContinuity: overall,
    harmonicStructural: overall,
    executionReliability: overall,
    overall,
  };
}

describe("evaluationUseWeight — the §15 feedback weight", () => {
  it("is exactly 1 with no evaluation — R5's counting, unchanged", () => {
    expect(evaluationUseWeight(record("standard-blend"))).toBe(1);
  });

  it("a perfect join counts half; a failed one counts one and a half", () => {
    expect(evaluationUseWeight(record("standard-blend", evaluation(1)))).toBe(
      0.5,
    );
    expect(evaluationUseWeight(record("standard-blend", evaluation(0)))).toBe(
      1.5,
    );
    expect(evaluationUseWeight(record("standard-blend", evaluation(0.5)))).toBe(
      1,
    );
  });

  it("out-of-range and malformed grades are ignored, never trusted", () => {
    // evaluationOf reads only well-formed 0..1 grades; anything
    // else is treated as no evaluation at all (weight exactly 1).
    expect(evaluationUseWeight(record("standard-blend", evaluation(2)))).toBe(
      1,
    );
    expect(
      evaluationUseWeight(record("standard-blend", { overall: "loud" })),
    ).toBe(1);
    expect(
      evaluationOf(record("standard-blend", { overall: "loud" })),
    ).toBeUndefined();
  });
});

describe("countRecentFamilyUsesWeighted", () => {
  it("equals the raw count on evaluation-free history (parity)", () => {
    const history = [
      record("standard-blend"),
      record("short-blend"),
      record("standard-blend"),
      record("standard-blend"),
    ];
    expect(countRecentFamilyUsesWeighted(history, "standard-blend", 12)).toBe(
      countRecentFamilyUses(history, "standard-blend", 12),
    );
    expect(countRecentFamilyUsesWeighted(history, "standard-blend", 12)).toBe(
      3,
    );
  });

  it("counts badly-graded repeats heavier, well-graded ones lighter", () => {
    const bad = [
      record("standard-blend", evaluation(0)),
      record("standard-blend", evaluation(0)),
    ];
    expect(countRecentFamilyUsesWeighted(bad, "standard-blend", 12)).toBe(3);
    const good = [
      record("standard-blend", evaluation(1)),
      record("standard-blend", evaluation(1)),
    ];
    expect(countRecentFamilyUsesWeighted(good, "standard-blend", 12)).toBe(1);
  });
});

describe("the feedback reaches the lottery — shaping, never exclusion", () => {
  function scored(
    family: ScoredCandidate["candidate"]["family"],
    score: number,
  ): ScoredCandidate {
    return {
      candidate: { family },
      vetoed: false,
      vetoReasons: [],
      components: [],
      historyCost: 0,
      historyNotes: [],
      score,
    } as unknown as ScoredCandidate;
  }

  function probabilities(history: JoinRecord[]): Map<string, number> {
    const a = scored("standard-blend", 0.9);
    const b = scored("short-blend", 0.9);
    const { record: selectionRecord } = selectFromBand([a, b], {
      profile: STANDARD_PROFILE,
      history,
      random: () => 0.42,
      seed: "s#1#1",
      scorerPick: a,
    });
    return new Map(
      selectionRecord.band.map((entry) => [entry.family, entry.probability]),
    );
  }

  it("equal scores and no history split the band evenly", () => {
    const probs = probabilities([]);
    expect(probs.get("standard-blend")).toBeCloseTo(0.5);
    expect(probs.get("short-blend")).toBeCloseTo(0.5);
  });

  it("badly-graded repeats lean the lottery away — but never to zero", () => {
    const unevaluated = probabilities([
      record("standard-blend"),
      record("standard-blend"),
      record("standard-blend"),
      record("standard-blend"),
    ]);
    const badlyGraded = probabilities([
      record("standard-blend", evaluation(0)),
      record("standard-blend", evaluation(0)),
      record("standard-blend", evaluation(0)),
      record("standard-blend", evaluation(0)),
    ]);
    const standard = badlyGraded.get("standard-blend")!;
    expect(standard).toBeLessThan(unevaluated.get("standard-blend")!);
    expect(standard).toBeLessThan(badlyGraded.get("short-blend")!);
    expect(standard).toBeGreaterThan(0); // §15: shaping only, never a ban
  });
});
