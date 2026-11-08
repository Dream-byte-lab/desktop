// hands.ts — Hands (optimisation wave item 6; ADAPTATION A8).
//
// Personalities stop being conditionals inside the decider and
// become trait-like modules behind named hooks. Each module is
// declared in one registry, carries its weight table, and may:
//
// - edit the Slate (hook: assemble) — push / unshift / replace /
//   veto, every edit logged with the module as author (item 3);
// - bend a candidate's draw score (hook: score).
//
// The core decider contains NO personality conditionals: it asks
// the active modules to edit, then to score, then draws. Modules
// are individually switchable (HandsConfig.disabled): disabling
// the personality module removes its edits AND its weight table
// from the draw, leaving the autonomous hand (which the 8
// sliders shape) in sole charge — exactly the pre-personality
// engine.
//
// The module set:
// - autonomous — always active; its score is the slider-bent
//   affinity (the resolved Shaping with the personality table
//   divided back out, so composition with the personality
//   module's own table reproduces resolveShaping's value
//   exactly, including its final clamp).
// - personality:<id> — the chosen personality's edits + table.
// - taste — the performance memory as a scoring hand (its only
//   output is a draw factor; it never edits).
// - crates — band weights + the weight-0 exclusion (item 7).
// - cooldown — the shelf as a veto editor (item 8).
// - guest — party requests (the session operates this editor
//   itself: it owns the party scheduler; its unshifts are
//   authored "guest" on the slate).
//
// House rules (from A8's risks): the hook surface is exactly
// these two points; every module declares which it uses; a
// module the listener cannot see or switch off does not ship.

import { fxKindsOfRecipe, isFxDressed } from "./authors";
import type { CooldownShelf } from "./cooldown";
import {
  autonomousExclusion,
  crateContextFor,
  crateWeight,
  ACTIVE_CRATE_TABLE,
  type CrateTable,
} from "./crates";
import type { TrackFacts } from "./facts";
import { clamp } from "./kernel";
import type { PerformanceMemory } from "./memory";
import type { Slate, SlateCandidate } from "./slate";
import {
  AFFINITY_GLOBAL_MAX,
  AFFINITY_GLOBAL_MIN,
  personalityAffinityTable,
  type AffinityTarget,
  type PersonalityId,
  type Shaping,
} from "./shaping";

// ---------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------

export interface HandContext {
  factsA: TrackFacts;
  arcPosition: number;
  shaping: Shaping;
  /** Session transition count (the shelf's "never first" rule reads it). */
  transitionIndex: number;
}

export interface HandModule {
  /** "autonomous" | "personality:club" | "taste" | "crates" | "cooldown". */
  id: string;
  label: string;
  /** The hooks this module declares (A8: declared, capped). */
  hooks: readonly ("assemble" | "score")[];
  /** The module's weight table, when it carries one. */
  weights?: Partial<Record<AffinityTarget, number>>;
  /** Slate-editing hook: runs before scoring. */
  assemble?(slate: Slate, ctx: HandContext): void;
  /**
   * Scoring hook: a multiplicative factor for one candidate.
   * "affinity"-kind factors are composed and clamped as one
   * affinity (mirroring resolveShaping); "factor"-kind factors
   * multiply afterwards.
   */
  score?(
    candidate: SlateCandidate,
    ctx: HandContext,
  ): { kind: "affinity" | "factor"; value: number };
}

export interface HandsConfig {
  /** Module ids to switch off (e.g. ["personality:club", "crates"]). */
  disabled?: readonly string[];
}

export function affinityTargetOf(candidate: SlateCandidate): AffinityTarget {
  return isFxDressed(candidate.recipe) ? "fx" : candidate.recipe.family;
}

// ---------------------------------------------------------------------
// The autonomous hand — sliders live here
// ---------------------------------------------------------------------

export function autonomousHand(shaping: Shaping): HandModule {
  const table = personalityAffinityTable(shaping.personalityId);
  return {
    id: "autonomous",
    label: "Autonomous — the slider-shaped base draw",
    hooks: ["score"],
    score(candidate) {
      const target = affinityTargetOf(candidate);
      // The resolved shaping's affinity with the personality
      // table divided back out: the slider bends alone. Exact
      // outside resolveShaping's clamp corners, and the final
      // composition clamp (applyHandScores) restores the shipped
      // value in the corners too.
      const tableValue = table[target] || 1;
      return {
        kind: "affinity",
        value: shaping.affinity(target) / tableValue,
      };
    },
  };
}

// ---------------------------------------------------------------------
// Personality hands — edits + their weight tables
// ---------------------------------------------------------------------

function bestOf(
  slate: Slate,
  predicate: (candidate: SlateCandidate) => boolean,
  rank: (candidate: SlateCandidate) => number,
): SlateCandidate | null {
  let best: SlateCandidate | null = null;
  for (const entry of slate.entries()) {
    if (!predicate(entry)) continue;
    if (!best || rank(entry) > rank(best)) best = entry;
  }
  return best;
}

export function personalityHand(shaping: Shaping): HandModule | null {
  const id = shaping.personalityId;
  if (id === "autonomous") return null;
  const table = personalityAffinityTable(id);
  const author = `personality:${id}`;
  const base: HandModule = {
    id: author,
    label: `${id} personality module`,
    hooks: ["assemble", "score"],
    weights: table,
    score(candidate) {
      return {
        kind: "affinity",
        value: table[affinityTargetOf(candidate)] ?? 1,
      };
    },
  };
  switch (id) {
    case "club":
      // Longer mixes, drops up front: force the strongest
      // drop-cut candidate to the head of the slate.
      base.assemble = (slate) => {
        const drop = bestOf(
          slate,
          (c) => c.recipe.family === "drop-cut",
          (c) => c.suitability,
        );
        if (drop) slate.unshift(drop, author);
      };
      break;
    case "house":
      // Extended blends: the longest-overlap blend leads.
      base.assemble = (slate) => {
        const blend = bestOf(
          slate,
          (c) =>
            c.recipe.family === "blend" || c.recipe.family === "loop-blend",
          (c) => c.recipe.overlapBeats,
        );
        if (blend) slate.unshift(blend, author);
      };
      break;
    case "battle":
      // Cuts and scratches forward — and Battle is the named
      // module that may put a weight-0 spinback in front of the
      // listener: its insertion lifts the autonomous exclusion,
      // and the candidate's source becomes Battle's, honestly.
      base.assemble = (slate) => {
        const spinback = bestOf(
          slate,
          (c) => c.autonomousExcluded !== null,
          (c) => c.suitability,
        );
        if (spinback) {
          spinback.autonomousExcluded = null;
          spinback.source = "personality:battle";
          slate.unshift(spinback, author);
        }
        const scratch = bestOf(
          slate,
          (c) =>
            c.recipe.family === "scratch-in" ||
            c.recipe.family === "scratch-out",
          (c) => c.suitability,
        );
        if (scratch) slate.unshift(scratch, author);
        const cut = bestOf(
          slate,
          (c) => c.recipe.family === "drop-cut",
          (c) => c.suitability,
        );
        if (cut) slate.unshift(cut, author);
      };
      break;
    case "radio":
      // Smooth and consistent: disruptive moves are vetoed off
      // the slate — stop-exit theatre and any spinback carrier.
      base.assemble = (slate) => {
        for (const entry of [...slate.entries()]) {
          if (
            entry.recipe.family === "stop-exit" ||
            entry.autonomousExcluded !== null
          ) {
            slate.veto(
              entry.id,
              author,
              "radio vetoes disruptive moves (stop-exit / spinback)",
            );
          }
        }
      };
      break;
    case "experimental":
      // The most-dressed candidate leads: unusual joins first.
      base.assemble = (slate) => {
        const dressed = bestOf(
          slate,
          (c) => fxKindsOfRecipe(c.recipe).length > 0,
          (c) => fxKindsOfRecipe(c.recipe).length * 10 + c.suitability,
        );
        if (dressed) slate.unshift(dressed, author);
      };
      break;
    case "open-format":
      // Balanced by declaration: no edits, table only.
      base.hooks = ["score"];
      break;
    default:
      base.hooks = ["score"];
      break;
  }
  return base;
}

// ---------------------------------------------------------------------
// Taste hand — performance memory as a score
// ---------------------------------------------------------------------

export function tasteHand(memory: PerformanceMemory): HandModule {
  return {
    id: "taste",
    label: "Taste — performance memory damping",
    hooks: ["score"],
    score(candidate) {
      return {
        kind: "factor",
        value: memory.factorFor({
          family: candidate.recipe.family,
          technique: candidate.recipe.technique,
          fxKinds: fxKindsOfRecipe(candidate.recipe),
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------
// Crates hand — band weights + the weight-0 exclusion
// ---------------------------------------------------------------------

export function cratesHand(table: CrateTable = ACTIVE_CRATE_TABLE): HandModule {
  return {
    id: "crates",
    label: `Crates — band weight table ${table.version}`,
    hooks: ["assemble", "score"],
    assemble(slate, ctx) {
      // The weight-0 class: planner-rolled candidates carrying a
      // spinback are marked out of the autonomous draw. Module-
      // inserted candidates keep their eligibility.
      for (const entry of slate.entries()) {
        if (entry.source === "planner") {
          const exclusion = autonomousExclusion(entry.recipe);
          if (exclusion) entry.autonomousExcluded = exclusion;
        }
      }
      void ctx;
    },
    score(candidate, ctx) {
      const weight = crateWeight(
        candidate.recipe,
        crateContextFor(ctx.factsA, candidate.trackB, ctx.arcPosition),
        table,
      );
      candidate.crateWeight = weight;
      return { kind: "factor", value: weight };
    },
  };
}

// ---------------------------------------------------------------------
// Cooldown hand — the shelf as a veto editor
// ---------------------------------------------------------------------

export function cooldownHand(
  shelf: CooldownShelf,
  artistByTrackId: ReadonlyMap<string, string | null>,
  techniqueKeyOfCandidate: (candidate: SlateCandidate) => string | null,
): HandModule {
  return {
    id: "cooldown",
    label: "Cooldown shelf — just-played sits out",
    hooks: ["assemble"],
    assemble(slate) {
      // Collect benches first; apply waivers before removing
      // anything, so a bench that would starve the set is
      // reported instead of enacted.
      const entries = [...slate.entries()];
      const benches = entries
        .map((entry) => ({
          entry,
          bench: shelf.benchFor({
            artist: artistByTrackId.get(entry.trackB.trackId) ?? null,
            techniqueKey: techniqueKeyOfCandidate(entry),
            trackId: entry.trackB.trackId,
          }),
        }))
        .filter((item) => item.bench !== null);
      if (benches.length === 0) return;
      const remaining = entries.filter(
        (entry) => !benches.some((item) => item.entry === entry),
      );
      // Waiver 1: every remaining candidate shares a benched
      // artist → the artist bench is a fact of the queue, waived.
      // Waiver 2: vetoes would empty the slate → spare the
      // highest-suitability benched candidate.
      let effective = benches;
      if (remaining.length === 0) {
        const spare = [...benches].sort(
          (a, z) => z.entry.suitability - a.entry.suitability,
        )[0];
        effective = benches.filter((item) => item !== spare);
        slate.ops.push({
          op: "veto",
          author: "cooldown",
          candidateId: spare.entry.id,
          reason: `waived — benching everything would empty the slate (${spare.bench!.reason})`,
        });
      } else {
        const remainingArtists = new Set(
          remaining.map(
            (entry) => artistByTrackId.get(entry.trackB.trackId) ?? null,
          ),
        );
        effective = benches.filter((item) => {
          if (
            item.bench!.kind === "artist" &&
            remainingArtists.size === 1 &&
            remainingArtists.has(item.bench!.key)
          ) {
            slate.ops.push({
              op: "veto",
              author: "cooldown",
              candidateId: item.entry.id,
              reason: `waived — every alternative shares the benched artist (${item.bench!.reason})`,
            });
            return false;
          }
          return true;
        });
      }
      for (const item of effective) {
        slate.veto(item.entry.id, "cooldown", item.bench!.reason);
      }
    },
  };
}

// ---------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------

export interface ResolveHandsDeps {
  memory?: PerformanceMemory | null;
  shelf?: CooldownShelf | null;
  artistByTrackId?: ReadonlyMap<string, string | null>;
  techniqueKeyOfCandidate?: (candidate: SlateCandidate) => string | null;
  crateTable?: CrateTable;
  config?: HandsConfig;
}

/**
 * The active module list for one decision, in application order:
 * editors first (personality, crates' exclusion pass, cooldown),
 * scorers composed by applyHandScores. Guest edits are the
 * session's own (it owns the party scheduler) and are applied by
 * the session before these modules run.
 */
export function resolveHands(
  shaping: Shaping,
  deps: ResolveHandsDeps,
): HandModule[] {
  const disabled = new Set(deps.config?.disabled ?? []);
  const modules: HandModule[] = [];
  const add = (module: HandModule | null): void => {
    if (module && !disabled.has(module.id)) modules.push(module);
  };
  add(autonomousHand(shaping));
  // Crates' assemble pass (the weight-0 exclusion) runs BEFORE
  // the personality edits: Battle claims excluded candidates and
  // Radio vetoes them, so both need the marks already down.
  add(cratesHand(deps.crateTable));
  add(personalityHand(shaping));
  if (deps.memory) add(tasteHand(deps.memory));
  if (deps.shelf && deps.artistByTrackId && deps.techniqueKeyOfCandidate) {
    add(
      cooldownHand(
        deps.shelf,
        deps.artistByTrackId,
        deps.techniqueKeyOfCandidate,
      ),
    );
  }
  return modules;
}

/** Run every module's assemble hook, in order. */
export function applyHandEdits(
  slate: Slate,
  hands: readonly HandModule[],
  ctx: HandContext,
): void {
  for (const hand of hands) {
    hand.assemble?.(slate, ctx);
  }
}

/**
 * Compose every candidate's draw weight: suitability² × the
 * affinity composition (autonomous × personality, clamped as
 * resolveShaping clamps) × the factor hands (taste, crates).
 */
export function applyHandScores(
  slate: Slate,
  hands: readonly HandModule[],
  ctx: HandContext,
): void {
  for (const entry of slate.entries()) {
    let affinity = 1;
    let factor = 1;
    for (const hand of hands) {
      if (!hand.score) continue;
      const part = hand.score(entry, ctx);
      if (part.kind === "affinity") affinity *= part.value;
      else factor *= part.value;
    }
    const clampedAffinity = clamp(
      affinity,
      AFFINITY_GLOBAL_MIN,
      AFFINITY_GLOBAL_MAX,
    );
    entry.weight =
      entry.suitability * entry.suitability * clampedAffinity * factor;
  }
}
