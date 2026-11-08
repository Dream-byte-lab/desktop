// slate.ts — the Slate (optimisation wave item 3; ADAPTATION A2).
//
// One explicit, mutable candidate list per transition. A
// candidate is a track pair + technique + entry/exit (a
// JoinRecipe) + its suitability score. Nothing in the engine
// "reaches" a decision privately: the brain assembles the slate,
// every other influence — personality modules, taste, guest
// requests, the cooldown shelf — is an EDITOR of the list, and
// one stable core (the session's ladder + draw) executes the
// final list.
//
// The operator vocabulary is deliberately tiny: push / unshift /
// replace / veto. Every edit is logged with its author, so "why
// is this candidate here / gone?" is a field, not archaeology:
//
// - push: append a candidate.
// - unshift: put a candidate first (force priority).
// - replace: swap the candidate with the same id (content is
//   last-writer-wins; the position is kept).
// - veto: remove a candidate AND tombstone its id. A tombstoned
//   candidate cannot be re-added by push/unshift/replace from a
//   different author — the veto channel is explicit, so an
//   editor's "never this" survives later editors' enthusiasm.
//   The vetoing author itself may re-add (it owns its veto).
//
// Conflict resolution: last-writer-wins per operator on the same
// candidate id, plus the veto tombstone above. The list is
// capped (SLATE_CAP): admitting beyond the cap drops the
// lowest-suitability entry, logged as a cap eviction — the cap
// exists so a night of enthusiastic editors cannot turn one
// transition into an unbounded search.

import type { TrackFacts } from "./facts";
import type { ProvenanceSource } from "./memory";
import type { JoinRecipe } from "./recipe";

/** Hard cap on candidates per transition. */
export const SLATE_CAP = 24;

export interface SlateCandidate {
  /** Stable identity: incoming track + recipe id. */
  id: string;
  trackB: TrackFacts;
  recipe: JoinRecipe;
  /** Published pair-evidence suitability (brain.ts's measure). */
  suitability: number;
  /** Who put this candidate on the slate. */
  source: ProvenanceSource;
  /**
   * Draw weight, composed by the scoring hands (suitability² ×
   * affinity × memory × crates). Starts at suitability² (the
   * planner's own term); scoring hands multiply from there.
   */
  weight: number;
  /** Crate weight applied by the crates hand (1 until applied). */
  crateWeight: number;
  /**
   * Non-null when the candidate is out of the autonomous draw
   * (e.g. the crates weight-0 class): it stays on the slate —
   * visible, stamped, and still performable by a named module
   * or the ladder's lower rungs — but the dice may not roll it.
   */
  autonomousExcluded: string | null;
}

export type SlateOpType = "push" | "unshift" | "replace" | "veto" | "evict";

export interface SlateOp {
  op: SlateOpType;
  /** The editing module's name ("planner", "personality:club", …). */
  author: string;
  candidateId: string;
  reason?: string;
}

export interface SlateVeto {
  candidate: SlateCandidate;
  author: string;
  reason: string;
}

export function slateCandidateId(trackBId: string, recipeId: string): string {
  return `${trackBId}::${recipeId}`;
}

export class Slate {
  private list: SlateCandidate[] = [];
  private tombstones = new Map<string, string>(); // id -> veto author
  readonly ops: SlateOp[] = [];
  readonly vetoes: SlateVeto[] = [];

  constructor(candidates: SlateCandidate[] = []) {
    for (const candidate of candidates) {
      this.list.push(candidate);
      this.ops.push({
        op: "push",
        author: candidate.source,
        candidateId: candidate.id,
      });
    }
  }

  /** The final list, in execution order. */
  entries(): readonly SlateCandidate[] {
    return this.list;
  }

  size(): number {
    return this.list.length;
  }

  get(id: string): SlateCandidate | null {
    return this.list.find((entry) => entry.id === id) ?? null;
  }

  /** 1-based position in the final list; null when absent. */
  positionOf(id: string): number | null {
    const index = this.list.findIndex((entry) => entry.id === id);
    return index >= 0 ? index + 1 : null;
  }

  isVetoed(id: string): boolean {
    return this.tombstones.has(id);
  }

  private blockedByTombstone(id: string, author: string): boolean {
    const vetoAuthor = this.tombstones.get(id);
    return vetoAuthor !== undefined && vetoAuthor !== author;
  }

  private admit(candidate: SlateCandidate, author: string): boolean {
    if (this.blockedByTombstone(candidate.id, author)) {
      this.ops.push({
        op: "push",
        author,
        candidateId: candidate.id,
        reason: `refused — vetoed by ${this.tombstones.get(candidate.id)}`,
      });
      return false;
    }
    if (this.tombstones.get(candidate.id) === author) {
      this.tombstones.delete(candidate.id); // the veto owner re-adds its own
    }
    const existing = this.list.findIndex((entry) => entry.id === candidate.id);
    if (existing >= 0) {
      this.list[existing] = candidate;
      this.ops.push({ op: "replace", author, candidateId: candidate.id });
      return true;
    }
    if (this.list.length >= SLATE_CAP) {
      let lowestIndex = 0;
      for (let i = 1; i < this.list.length; i += 1) {
        if (this.list[i].suitability < this.list[lowestIndex].suitability) {
          lowestIndex = i;
        }
      }
      if (candidate.suitability < this.list[lowestIndex].suitability) {
        this.ops.push({
          op: "push",
          author,
          candidateId: candidate.id,
          reason: `refused — slate is at its cap of ${SLATE_CAP}`,
        });
        return false;
      }
      const [evicted] = this.list.splice(lowestIndex, 1);
      this.ops.push({
        op: "evict",
        author: "slate-cap",
        candidateId: evicted.id,
        reason: `cap of ${SLATE_CAP} — lowest suitability evicted`,
      });
    }
    return true; // caller places the candidate
  }

  push(candidate: SlateCandidate, author: string): boolean {
    if (!this.admit(candidate, author)) return false;
    if (!this.list.some((entry) => entry.id === candidate.id)) {
      this.list.push(candidate);
    }
    this.ops.push({ op: "push", author, candidateId: candidate.id });
    return true;
  }

  unshift(candidate: SlateCandidate, author: string): boolean {
    const existing = this.list.findIndex((entry) => entry.id === candidate.id);
    if (existing >= 0) {
      // Already listed: unshift is a move-to-front by its author.
      const [entry] = this.list.splice(existing, 1);
      this.list.unshift(entry);
      this.ops.push({ op: "unshift", author, candidateId: candidate.id });
      return true;
    }
    if (!this.admit(candidate, author)) return false;
    this.list.unshift(candidate);
    this.ops.push({ op: "unshift", author, candidateId: candidate.id });
    return true;
  }

  replace(candidate: SlateCandidate, author: string): boolean {
    if (!this.list.some((entry) => entry.id === candidate.id)) return false;
    if (!this.admit(candidate, author)) return false;
    this.ops.push({ op: "replace", author, candidateId: candidate.id });
    return true;
  }

  veto(id: string, author: string, reason: string): boolean {
    const index = this.list.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [candidate] = this.list.splice(index, 1);
    this.tombstones.set(id, author);
    this.vetoes.push({ candidate, author, reason });
    this.ops.push({ op: "veto", author, candidateId: id, reason });
    return true;
  }
}

/**
 * The one weighted draw over a final slate: probability ∝ the
 * composed weight; argmax only when exactly one candidate is
 * eligible — the brain's long-standing draw contract, now over
 * the explicit list. Candidates with weight ≤ 0 or an autonomous
 * exclusion are not eligible. Returns null when nothing is
 * eligible.
 */
export function drawFromSlate(
  slate: Slate,
  rng: () => number,
  opts: { includeExcluded?: boolean } = {},
): SlateCandidate | null {
  const eligible = slate
    .entries()
    .filter(
      (entry) =>
        entry.weight > 0 && (opts.includeExcluded || !entry.autonomousExcluded),
    );
  if (eligible.length === 0) return null;
  if (eligible.length === 1) return eligible[0];
  const total = eligible.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return eligible[0];
  let draw = rng() * total;
  for (const entry of eligible) {
    draw -= entry.weight;
    if (draw <= 0) return entry;
  }
  return eligible[eligible.length - 1];
}
