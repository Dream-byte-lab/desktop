// crates.ts — Crates (optimisation wave item 7; ADAPTATION A6).
//
// Technique weights as VERSIONED CONFIG DATA, not literals in
// decision code. What the dice may roll changes with where the
// set is: the context band is (energy direction × set position ×
// key distance), each band bends the draw weight of a technique
// class (a join family, a scratch technique, or "fx" dressing),
// and the table's version is stamped into every record it
// weighted (Receipts, item 4) so a night can be re-read against
// the exact table that produced it.
//
// The weight-0 class (A6's sharpest detail): moves the
// autonomous engine may NEVER roll — here, any candidate
// carrying a spinback jog. A weight-0 candidate is not deleted;
// it is marked excluded-from-the-dice on the slate, visible and
// stamped, and only a named module (the Battle hand) or a guest
// request may put it in front of the listener. Intent may choose
// what chance may not.

import type { TrackFacts } from "./facts";
import { keyFitScore, trackEnergyLevel } from "./kernel";
import type { JoinFamily, JoinRecipe, ScratchTechnique } from "./recipe";
import { isFxDressed } from "./authors";

// ---------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------

export type EnergyDirection = "up" | "flat" | "down";
export type SetPositionBand = "opening" | "building" | "peak" | "wind-down";
export type KeyDistanceBand = "same" | "near" | "far" | "unknown";

export interface CrateContext {
  energyDirection: EnergyDirection;
  setPosition: SetPositionBand;
  keyDistance: KeyDistanceBand;
}

/** A technique class the tables can weight: family, scratch, or fx. */
export type TechniqueClass = JoinFamily | ScratchTechnique | "fx";

export function setPositionBand(arcPosition: number): SetPositionBand {
  if (arcPosition < 0.25) return "opening";
  if (arcPosition < 0.55) return "building";
  if (arcPosition < 0.8) return "peak";
  return "wind-down";
}

export function crateContextFor(
  factsA: TrackFacts,
  factsB: TrackFacts,
  arcPosition: number,
): CrateContext {
  const delta = trackEnergyLevel(factsB) - trackEnergyLevel(factsA);
  const energyDirection: EnergyDirection =
    delta > 0.05 ? "up" : delta < -0.05 ? "down" : "flat";
  const fit = factsA.keyFitTo(factsB);
  const keyScore = keyFitScore(fit);
  const keyDistance: KeyDistanceBand =
    fit === null
      ? "unknown"
      : fit.relation === "same"
        ? "same"
        : keyScore >= 0.6
          ? "near"
          : "far";
  return {
    energyDirection,
    setPosition: setPositionBand(arcPosition),
    keyDistance,
  };
}

/** The classes a candidate belongs to (family + technique + fx). */
export function techniqueClassesOf(recipe: JoinRecipe): TechniqueClass[] {
  const classes: TechniqueClass[] = [recipe.family];
  if (recipe.technique) classes.push(recipe.technique);
  if (isFxDressed(recipe)) classes.push("fx");
  return classes;
}

/** True when the candidate carries a spinback jog block. */
export function carriesSpinback(recipe: JoinRecipe): boolean {
  return recipe.blocks.some(
    (block) => block.type === "jog" && block.kind === "spinback",
  );
}

// ---------------------------------------------------------------------
// The table (versioned config data)
// ---------------------------------------------------------------------

type BandTable = Partial<Record<TechniqueClass, number>>;

export interface CrateTable {
  version: string;
  bySetPosition: Record<SetPositionBand, BandTable>;
  byEnergyDirection: Record<EnergyDirection, BandTable>;
  byKeyDistance: Record<KeyDistanceBand, BandTable>;
}

export const CRATE_TABLE_V1: CrateTable = {
  version: "crates-v1",
  bySetPosition: {
    opening: {
      blend: 1,
      "loop-blend": 0.95,
      "drop-cut": 0.7,
      "filter-fade": 1,
      "echo-out": 0.9,
      "stop-exit": 0.7,
      "scratch-in": 0.8,
      "scratch-out": 0.8,
      fx: 0.95,
    },
    building: {
      blend: 1,
      "loop-blend": 1.1,
      "drop-cut": 0.95,
      "filter-fade": 1,
      "echo-out": 1,
      "stop-exit": 0.85,
      "scratch-in": 0.95,
      "scratch-out": 0.95,
      fx: 1,
    },
    peak: {
      blend: 1,
      "loop-blend": 1.1,
      "drop-cut": 1.2,
      "filter-fade": 1,
      "echo-out": 1.05,
      "stop-exit": 0.9,
      "scratch-in": 1.15,
      "scratch-out": 1.15,
      fx: 1.1,
    },
    "wind-down": {
      blend: 1.05,
      "loop-blend": 0.95,
      "drop-cut": 0.75,
      "filter-fade": 1.05,
      "echo-out": 1.15,
      "stop-exit": 0.8,
      "scratch-in": 0.85,
      "scratch-out": 0.85,
      fx: 1,
    },
  },
  byEnergyDirection: {
    up: { "drop-cut": 1.1, blend: 0.95 },
    flat: {},
    down: { "echo-out": 1.1, "filter-fade": 1.05, "drop-cut": 0.8 },
  },
  byKeyDistance: {
    same: {},
    near: {},
    far: { blend: 0.9, "loop-blend": 0.9, "drop-cut": 1.05 },
    unknown: {},
  },
};

/** The active table. One place changes the night's dice. */
export const ACTIVE_CRATE_TABLE: CrateTable = CRATE_TABLE_V1;
export const CRATES_VERSION: string = ACTIVE_CRATE_TABLE.version;

/**
 * The crate weight for one candidate in one context: the product
 * of its classes' bends across the three band tables (a class
 * absent from a table bends by 1). The weight-0 class is NOT a
 * table row — it is structural (see autonomousExclusion).
 */
export function crateWeight(
  recipe: JoinRecipe,
  ctx: CrateContext,
  table: CrateTable = ACTIVE_CRATE_TABLE,
): number {
  let weight = 1;
  const tables: BandTable[] = [
    table.bySetPosition[ctx.setPosition],
    table.byEnergyDirection[ctx.energyDirection],
    table.byKeyDistance[ctx.keyDistance],
  ];
  for (const cls of techniqueClassesOf(recipe)) {
    for (const bandTable of tables) {
      const bend = bandTable[cls];
      if (typeof bend === "number" && Number.isFinite(bend)) weight *= bend;
    }
  }
  return weight;
}

/**
 * The weight-0 class: why this candidate may never be rolled by
 * the autonomous draw, or null when the dice may roll it. Only a
 * named module's insertion (a slate entry whose source is not
 * the planner) lifts the exclusion — see the session's draw.
 */
export function autonomousExclusion(recipe: JoinRecipe): string | null {
  if (carriesSpinback(recipe)) {
    return "weight-0 class: spinback — the autonomous draw never rolls it; only a named module or request may insert it";
  }
  return null;
}
