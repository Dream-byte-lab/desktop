// ladder.ts — the Ladder (optimisation wave item 2; ADAPTATION
// A5 + A1).
//
// Every transition is PROVEN against the real analysis inside a
// time budget derived from the music itself — the seconds left
// to the mix-out point. Proving runs down named rungs, and every
// degradation is a landing with a name and a stamp, never an
// exception path:
//
//   Rung 1 — a proven phrase-aligned blend (canMix "phrase-blend"
//            over the recipe's own window).
//   Rung 2 — a simpler beatmatched blend (canMix "beatmatch" over
//            a plain blend-family candidate). If no candidate is
//            PROVEN here but one is merely UNPROVEN at the blend
//            tiers — never REFUSED — the best of those performs
//            in the engine's degraded form (rate 1, recorded
//            degraded-untrusted): unknown fails closed for PROOF
//            at every tier, and the degraded lane is labelled,
//            never silent. A candidate positively refused at a
//            blend tier (vocals measured colliding, tempos
//            outside the sustainable rates, a track unresolvable
//            through the DJ path) is never performed as a blend.
//   Rung 3 — a clean phrase-boundary cut (canMix "phrase-cut"
//            proven for the pair): the plain cut, performed as a
//            proven landing and recorded as performed.
//   Rung 4 — the guaranteed plain crossfade: the old
//            fallback-unprepared plain cut, now the named bottom
//            rung. It cannot fail: it makes no claims at all.
//
// The budget governs the proving, not the music: checks run
// between rungs, and on exhaustion the ladder jumps to the
// highest rung already reachable — rung 4 always is. A session
// may degrade; it must never die silently, and the bottom rung
// is why.

import { canMix, type CanMixResult, type MixWindow } from "./canMix";
import type { TrackFacts } from "./facts";
import type { JoinRecipe } from "./recipe";
import type { Slate, SlateCandidate } from "./slate";

export type LadderRung = 1 | 2 | 3 | 4;

/** Reserve kept back from the mix-out point for the bottom rung. */
export const LADDER_RESERVE_MS = 1_000;
export const LADDER_BUDGET_MIN_MS = 500;
export const LADDER_BUDGET_MAX_MS = 30_000;

/**
 * The proving budget from the seconds remaining to the mix-out
 * point: what's left, minus the bottom rung's reserve, clamped
 * to a sane band. Unknown remaining time earns the minimum
 * budget — the ladder still runs, it just runs lean.
 */
export function transitionBudgetMs(secondsToMixOut: number | null): number {
  if (secondsToMixOut === null || !Number.isFinite(secondsToMixOut)) {
    return LADDER_BUDGET_MIN_MS;
  }
  const raw = secondsToMixOut * 1000 - LADDER_RESERVE_MS;
  return Math.min(LADDER_BUDGET_MAX_MS, Math.max(LADDER_BUDGET_MIN_MS, raw));
}

/** The blend window a recipe claims, in both tracks' own times. */
export function recipeWindow(
  recipe: JoinRecipe,
  factsA: TrackFacts,
  factsB: TrackFacts,
): MixWindow {
  const msPerBeatA =
    factsA.tempo.bpm && factsA.tempo.bpm > 0 ? 60_000 / factsA.tempo.bpm : 500;
  const msPerBeatB =
    factsB.tempo.bpm && factsB.tempo.bpm > 0 ? 60_000 / factsB.tempo.bpm : 500;
  const aEnd =
    factsA.timeAtBeatMs(recipe.outgoing.exitBeat + recipe.overlapBeats) ??
    recipe.outgoing.exitAnchorMs + recipe.overlapBeats * msPerBeatA;
  const bEnd =
    factsB.timeAtBeatMs(recipe.incoming.entryBeat + recipe.overlapBeats) ??
    recipe.incoming.entryAnchorMs + recipe.overlapBeats * msPerBeatB;
  return {
    aStartMs: recipe.outgoing.exitAnchorMs,
    aEndMs: aEnd,
    bStartMs: recipe.incoming.entryAnchorMs,
    bEndMs: bEnd,
  };
}

export type LadderOutcome =
  | {
      kind: "authored";
      candidate: SlateCandidate;
      rung: 1 | 2;
      /** True when the candidate performs in degraded form (rung 2's lane). */
      degraded: boolean;
      proof: CanMixResult;
    }
  | {
      kind: "cut";
      trackB: TrackFacts;
      rung: 3;
      proof: CanMixResult;
    }
  | { kind: "crossfade"; rung: 4 };

export interface LadderInput {
  slate: Slate;
  factsA: TrackFacts;
  rng: () => number;
  /** Clock read for budget checks (the session's injected clock). */
  now: () => number;
  budgetMs: number;
}

function drawAmong(
  entries: SlateCandidate[],
  rng: () => number,
): SlateCandidate | null {
  // Weight-0-excluded candidates are NEVER rolled by the ladder:
  // only a named module's insertion (which clears the exclusion
  // at edit time) may put one in front of the listener. If every
  // proven candidate is excluded, the rung simply does not land
  // and the ladder walks down.
  const pool = entries.filter(
    (entry) => entry.weight > 0 && !entry.autonomousExcluded,
  );
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  const total = pool.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (!(total > 0)) return pool[0];
  let draw = rng() * total;
  for (const entry of pool) {
    draw -= Math.max(0, entry.weight);
    if (draw <= 0) return entry;
  }
  return pool[pool.length - 1];
}

function bestByWeight(entries: SlateCandidate[]): SlateCandidate | null {
  let best: SlateCandidate | null = null;
  for (const entry of entries) {
    if (!best || entry.weight > best.weight) best = entry;
  }
  return best;
}

const RESOLVED = {
  resolvableA: "resolved",
  resolvableB: "resolved",
} as const;

/**
 * Prove the transition down the rungs. The caller guarantees the
 * slate's candidates are joinable (facts + decoded buffer in
 * hand — hence "resolved" throughout: canMix's DJ-path gate is
 * satisfied by construction at this point, and would refuse
 * honestly if a caller ever lied about it).
 */
export function proveLadder(input: LadderInput): LadderOutcome {
  const { slate, factsA, rng } = input;
  const startedAt = input.now();
  const exhausted = (): boolean => input.now() - startedAt >= input.budgetMs;
  const entries = [...slate.entries()];
  if (entries.length === 0) return { kind: "crossfade", rung: 4 };

  const proofs = new Map<string, { blend: CanMixResult; beat: CanMixResult }>();
  const proofOf = (candidate: SlateCandidate) => {
    let entry = proofs.get(candidate.id);
    if (!entry) {
      entry = {
        blend: canMix(factsA, candidate.trackB, {
          tier: "phrase-blend",
          window: recipeWindow(candidate.recipe, factsA, candidate.trackB),
          windowBeats: candidate.recipe.overlapBeats,
          ...RESOLVED,
        }),
        beat: canMix(factsA, candidate.trackB, {
          tier: "beatmatch",
          ...RESOLVED,
        }),
      };
      proofs.set(candidate.id, entry);
    }
    return entry;
  };

  // -- Rung 1: proven phrase-aligned blends -------------------------
  const rung1 = entries.filter(
    (entry) => proofOf(entry).blend.proof === "proven",
  );
  if (rung1.length > 0) {
    const pick = drawAmong(rung1, rng);
    if (pick) {
      return {
        kind: "authored",
        candidate: pick,
        rung: 1,
        degraded: false,
        proof: proofOf(pick).blend,
      };
    }
  }
  if (exhausted()) return { kind: "crossfade", rung: 4 };

  // -- Rung 2: proven simple beatmatched blends ----------------------
  // A candidate REFUSED at the phrase-blend tier (its own window
  // measured vocal-colliding, its rates refused) is disqualified
  // as a blend in ANY form — rung 2 takes only candidates whose
  // blend proof was merely unproven (missing phrase/key/vocal
  // evidence) while their beatmatch proof is solid.
  const rung2 = entries.filter(
    (entry) =>
      (entry.recipe.family === "blend" ||
        entry.recipe.family === "loop-blend") &&
      !entry.recipe.technique &&
      proofOf(entry).blend.proof !== "refused" &&
      proofOf(entry).beat.proof === "proven",
  );
  if (rung2.length > 0) {
    const pick = drawAmong(rung2, rng);
    if (pick) {
      return {
        kind: "authored",
        candidate: pick,
        rung: 2,
        degraded: false,
        proof: proofOf(pick).beat,
      };
    }
  }

  // -- Rung 2, degraded lane: unproven but never refused -------------
  const degradedPool = entries.filter((entry) => {
    if (entry.autonomousExcluded) return false;
    const proof = proofOf(entry);
    return proof.blend.proof !== "refused" && proof.beat.proof !== "refused";
  });
  const degradedPick = bestByWeight(degradedPool);
  if (degradedPick) {
    return {
      kind: "authored",
      candidate: degradedPick,
      rung: 2,
      degraded: true,
      proof: proofOf(degradedPick).blend,
    };
  }
  if (exhausted()) return { kind: "crossfade", rung: 4 };

  // -- Rung 3: a proven phrase-boundary cut ---------------------------
  // The best remaining track (by its best candidate's weight)
  // whose pair proves at the cut tier.
  const tracksByBest = new Map<string, SlateCandidate>();
  for (const entry of entries) {
    const current = tracksByBest.get(entry.trackB.trackId);
    if (!current || entry.weight > current.weight) {
      tracksByBest.set(entry.trackB.trackId, entry);
    }
  }
  const trackCandidates = [...tracksByBest.values()].sort(
    (a, z) => z.weight - a.weight,
  );
  for (const entry of trackCandidates) {
    const proof = canMix(factsA, entry.trackB, {
      tier: "phrase-cut",
      ...RESOLVED,
    });
    if (proof.proof === "proven") {
      return { kind: "cut", trackB: entry.trackB, rung: 3, proof };
    }
    if (exhausted()) break;
  }

  // -- Rung 4: the guaranteed plain crossfade -------------------------
  return { kind: "crossfade", rung: 4 };
}
