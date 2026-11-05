// brain.ts — selection for the liveRave rebuild (design §3.5).
//
// Suitability is a published weighted mean of the candidate's raw
// pair evidence — tempoFit, keyFit, phraseFit, structureFit,
// energyFit, vocalSafety — and NOTHING else: no family cost, no
// theatre surcharge, anywhere (§4 invariant 2). Two candidates with
// identical evidence have identical suitability whatever their
// families; families enter only afterwards, as draw weights.
//
// The draw (§4): the pool is every (track, candidate) pair with
// suitability >= 0.35 across the considered next tracks; the pick
// is drawn with probability ∝ suitability² × shaping affinity
// (the candidate's family, or "fx" when it carries an fx dressing)
// × the performance-memory factor. Argmax is forbidden unless the
// pool has exactly one member. Randomness arrives through an
// injected seeded RNG, so a seed reproduces a night exactly.
//
// Track choice: options are first ranked by track fit (kernel fits
// for the pair, bent by shaping: keyTempoTolerance widens/narrows
// the prune threshold, selectionFreedom widens/narrows how many
// options are authored against). Pure and environment-pure.

import { authorCandidates, fxKindsOfRecipe, isFxDressed } from "./authors";
import type { TrackFacts } from "./facts";
import {
  clamp01,
  energyArcFit,
  keyFitScore,
  tempoFit,
  trackEnergyLevel,
} from "./kernel";
import type { PerformanceMemory } from "./memory";
import type { FxKind, JoinRecipe, ScratchTechnique } from "./recipe";
import type { Shaping } from "./shaping";

// ---------------------------------------------------------------------
// Suitability — the published weights (design §3.5)
// ---------------------------------------------------------------------

export const SUITABILITY_WEIGHTS = {
  tempoFit: 0.22,
  keyFit: 0.18,
  phraseFit: 0.15,
  structureFit: 0.15,
  energyFit: 0.12,
  vocalSafety: 0.18,
} as const;

export type EvidenceComponent = keyof typeof SUITABILITY_WEIGHTS;

export const EVIDENCE_COMPONENTS = Object.keys(
  SUITABILITY_WEIGHTS,
) as EvidenceComponent[];

/** Candidates below this suitability never enter the draw pool. */
export const POOL_MIN_SUITABILITY = 0.35;

/**
 * Suitability of a candidate from its authored evidence alone.
 * Missing components score the neutral 0.5 (authors always emit
 * all six; the default exists so hand-built candidates in tests
 * and tools are judged on what they do carry).
 */
export function suitabilityOf(candidate: JoinRecipe): number {
  const evidence = candidate.authored.evidence;
  let weighted = 0;
  let totalWeight = 0;
  for (const component of EVIDENCE_COMPONENTS) {
    const weight = SUITABILITY_WEIGHTS[component];
    const value = evidence[component];
    weighted +=
      weight *
      (typeof value === "number" && Number.isFinite(value)
        ? clamp01(value)
        : 0.5);
    totalWeight += weight;
  }
  return totalWeight > 0 ? clamp01(weighted / totalWeight) : 0;
}

// ---------------------------------------------------------------------
// Track fit — how an option B ranks before authoring
// ---------------------------------------------------------------------

/**
 * Track fit of a candidate next track for the current one: the
 * pair's tempo and key fits plus how its energy level meets the
 * arc, in equal-ish measure. Used ONLY to rank/prune options
 * before authoring (and as assembleSet's fallback) — the draw
 * itself runs on authored suitabilities.
 */
export function trackFitFor(
  factsA: TrackFacts,
  factsB: TrackFacts,
  arcPosition: number,
  shaping: Shaping,
): number {
  const tempo = tempoFit(factsA.tempo.bpm, factsB.tempo.bpm);
  const key = keyFitScore(factsA.keyFitTo(factsB));
  const energy = energyArcFit(
    trackEnergyLevel(factsB),
    arcPosition,
    shaping.bends.arcSteepness,
  );
  return clamp01(0.4 * tempo + 0.3 * key + 0.3 * energy);
}

// ---------------------------------------------------------------------
// The brain
// ---------------------------------------------------------------------

export interface BrainDeps {
  rng: () => number;
}

export interface ConsiderArgs {
  factsA: TrackFacts;
  optionsB: TrackFacts[];
  arcPosition: number;
  shaping: Shaping;
  memory?: PerformanceMemory | null;
}

/**
 * One pool member's summary, exposed for the DJ surface's
 * next-join preview (the pick + what it beat + the evidence).
 * Covers every candidate that entered the pool (suitability
 * >= POOL_MIN_SUITABILITY) — exposure only; the pool computation
 * and the draw are unchanged by it.
 */
export interface ConsiderPoolEntry {
  trackId: string;
  family: JoinRecipe["family"];
  technique?: ScratchTechnique;
  fxKinds: FxKind[];
  suitability: number;
  evidence: Record<string, number>;
}

export interface ConsiderResult {
  trackB: TrackFacts;
  recipe: JoinRecipe;
  suitability: number;
  poolSize: number;
  /** Summaries of every candidate that entered the draw pool. */
  pool: ConsiderPoolEntry[];
}

export interface AssembledSet {
  orderedIds: string[];
  joins: {
    fromId: string;
    toId: string;
    family: string;
    suitability: number;
  }[];
}

export interface Brain {
  suitability(candidate: JoinRecipe): number;
  consider(args: ConsiderArgs): ConsiderResult | null;
  assembleSet(factsList: TrackFacts[], shaping: Shaping): AssembledSet;
}

export function createBrain(deps: BrainDeps): Brain {
  const rng = typeof deps?.rng === "function" ? deps.rng : Math.random;

  function suitability(candidate: JoinRecipe): number {
    return suitabilityOf(candidate);
  }

  function consider(args: ConsiderArgs): ConsiderResult | null {
    const { factsA, shaping } = args;
    const arcPosition = clamp01(args.arcPosition);
    if (args.optionsB.length === 0) return null;

    // Rank options by track fit; prune by the tolerance-bent
    // threshold and by the freedom-bent option cap. The single best
    // option is always kept, so pruning can never empty the set.
    const ranked = args.optionsB
      .map((factsB) => ({
        factsB,
        fit: trackFitFor(factsA, factsB, arcPosition, shaping),
      }))
      .sort((a, z) => z.fit - a.fit);
    const pruneThreshold = Math.min(
      0.75,
      Math.max(0.15, 0.45 / Math.max(0.2, shaping.bends.keyTempoTolerance)),
    );
    const maxOptions = Math.max(
      1,
      Math.round(4 * Math.max(0.2, shaping.bends.selectionFreedom)),
    );
    const kept = ranked
      .filter((entry, index) => index === 0 || entry.fit >= pruneThreshold)
      .slice(0, maxOptions);

    // One joint pool of (track, candidate) across all kept options.
    interface PoolEntry {
      trackB: TrackFacts;
      recipe: JoinRecipe;
      suitability: number;
      weight: number;
    }
    const pool: PoolEntry[] = [];
    for (const { factsB } of kept) {
      const { candidates } = authorCandidates(factsA, factsB, {
        arcPosition,
        shaping,
      });
      for (const recipe of candidates) {
        const score = suitabilityOf(recipe);
        if (score < POOL_MIN_SUITABILITY) continue;
        const affinity = shaping.affinity(
          isFxDressed(recipe) ? "fx" : recipe.family,
        );
        const memoryFactor = args.memory
          ? args.memory.factorFor({
              family: recipe.family,
              technique: recipe.technique,
              fxKinds: fxKindsOfRecipe(recipe),
            })
          : 1;
        pool.push({
          trackB: factsB,
          recipe,
          suitability: score,
          weight: score * score * affinity * memoryFactor,
        });
      }
    }
    if (pool.length === 0) return null;
    // The pool summaries ride along on every return path so the
    // session can expose a nextJoinPreview (pick + pool + evidence).
    const poolSummaries: ConsiderPoolEntry[] = pool.map((entry) => ({
      trackId: entry.trackB.trackId,
      family: entry.recipe.family,
      technique: entry.recipe.technique,
      fxKinds: fxKindsOfRecipe(entry.recipe),
      suitability: entry.suitability,
      evidence: { ...entry.recipe.authored.evidence },
    }));
    const toResult = (entry: PoolEntry): ConsiderResult => ({
      trackB: entry.trackB,
      recipe: entry.recipe,
      suitability: entry.suitability,
      poolSize: pool.length,
      pool: poolSummaries,
    });
    if (pool.length === 1) {
      return toResult(pool[0]);
    }
    const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
    if (!(totalWeight > 0)) {
      return toResult(pool[0]);
    }
    let draw = rng() * totalWeight;
    for (const entry of pool) {
      draw -= entry.weight;
      if (draw <= 0) {
        return toResult(entry);
      }
    }
    return toResult(pool[pool.length - 1]);
  }

  function assembleSet(
    factsList: TrackFacts[],
    shaping: Shaping,
  ): AssembledSet {
    if (factsList.length === 0) return { orderedIds: [], joins: [] };
    // Strongest opener: the track whose own energy level is highest
    // (ties keep list order, so assembly is deterministic).
    let opener = factsList[0];
    let openerLevel = trackEnergyLevel(opener);
    for (const facts of factsList.slice(1)) {
      const level = trackEnergyLevel(facts);
      if (level > openerLevel) {
        opener = facts;
        openerLevel = level;
      }
    }
    const ordered: TrackFacts[] = [opener];
    const joins: AssembledSet["joins"] = [];
    const remaining = factsList.filter((facts) => facts !== opener);
    while (remaining.length > 0) {
      const current = ordered[ordered.length - 1];
      const arcPosition =
        factsList.length <= 1 ? 0 : ordered.length / (factsList.length - 1);
      let bestIndex = 0;
      let bestScore = -Infinity;
      let bestFamily = "blend";
      for (let i = 0; i < remaining.length; i += 1) {
        const candidate = remaining[i];
        const { candidates } = authorCandidates(current, candidate, {
          arcPosition: clamp01(arcPosition),
          shaping,
        });
        let score = -Infinity;
        let family = "blend";
        for (const recipe of candidates) {
          const value = suitabilityOf(recipe);
          if (value > score) {
            score = value;
            family = recipe.family;
          }
        }
        if (score === -Infinity) {
          // No authored join at all: fall back to raw track fit so
          // the track still orders by evidence, honestly labelled.
          score = trackFitFor(current, candidate, arcPosition, shaping);
          family = "fallback-fit";
        }
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
          bestFamily = family;
        }
      }
      const [next] = remaining.splice(bestIndex, 1);
      ordered.push(next);
      joins.push({
        fromId: current.trackId,
        toId: next.trackId,
        family: bestFamily,
        suitability: clamp01(bestScore),
      });
    }
    return { orderedIds: ordered.map((facts) => facts.trackId), joins };
  }

  return { suitability, consider, assembleSet };
}
