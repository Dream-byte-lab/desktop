// memory.ts — performance memory + the behaviour record (design §3.6).
//
// Two injected-data structures, both environment-pure:
//
// - PerformanceMemory remembers the last 12 performed joins and
//   turns recency into a draw factor in [0.55, 1.0]: a family (or
//   technique, or fx kind) heard recently is damped toward the
//   floor, never vetoed — shaping only, per BLUEPRINT §15.
// - The behaviour record is the anti-blindness log: EVERY performed
//   join and EVERY fallback/degradation is appended with its
//   reason, so the harness and the morning report quote real
//   counts. Persistence arrives through an injected store; an
//   in-memory implementation ships here for tests and as the
//   default (the session wave wires storage.ts behind the same
//   interface).

import type { FxKind, JoinFamily, ScratchTechnique } from "./recipe";

// ---------------------------------------------------------------------
// Performance memory
// ---------------------------------------------------------------------

/** How many recent joins the memory factor looks back over. */
export const MEMORY_WINDOW = 12;
/** The memory factor's floor — damping, never a veto. */
export const MEMORY_FACTOR_MIN = 0.55;

export interface JoinMemoryEntry {
  family: JoinFamily;
  technique?: ScratchTechnique;
  fxKinds: FxKind[];
}

export interface PerformanceMemory {
  record(join: JoinMemoryEntry): void;
  factorFor(query: {
    family: JoinFamily;
    technique?: ScratchTechnique;
    fxKinds?: FxKind[];
  }): number;
  /** Copy of the remembered joins, oldest first. */
  entries(): JoinMemoryEntry[];
}

export function createPerformanceMemory(): PerformanceMemory {
  const history: JoinMemoryEntry[] = [];

  return {
    record(join: JoinMemoryEntry): void {
      history.push({
        family: join.family,
        technique: join.technique,
        fxKinds: [...(join.fxKinds ?? [])],
      });
    },

    factorFor(query): number {
      const recent = history.slice(-MEMORY_WINDOW);
      if (recent.length === 0) return 1;

      // Family repeats dominate: each repeat of the same family in
      // the window halves the family's remaining headroom above the
      // 0.55 floor (0 repeats → 1.0, 1 → 0.775, 2 → 0.6625, …).
      const familyRepeats = recent.filter(
        (entry) => entry.family === query.family,
      ).length;
      const familyFactor =
        MEMORY_FACTOR_MIN +
        (1 - MEMORY_FACTOR_MIN) * Math.pow(0.5, familyRepeats);

      // Technique repeats are milder (floor 0.75 on their own).
      let techniqueFactor = 1;
      if (query.technique !== undefined) {
        const techniqueRepeats = recent.filter(
          (entry) => entry.technique === query.technique,
        ).length;
        techniqueFactor = 0.75 + 0.25 * Math.pow(0.5, techniqueRepeats);
      }

      // Fx-kind repeats are mildest (floor 0.80 on their own): a
      // past join counts once when it shares any dressed kind.
      let fxFactor = 1;
      const queryKinds = query.fxKinds ?? [];
      if (queryKinds.length > 0) {
        const fxRepeats = recent.filter((entry) =>
          entry.fxKinds.some((kind) => queryKinds.includes(kind)),
        ).length;
        fxFactor = 0.8 + 0.2 * Math.pow(0.5, fxRepeats);
      }

      const combined = familyFactor * techniqueFactor * fxFactor;
      return Math.min(1, Math.max(MEMORY_FACTOR_MIN, combined));
    },

    entries(): JoinMemoryEntry[] {
      return history.map((entry) => ({
        ...entry,
        fxKinds: [...entry.fxKinds],
      }));
    },
  };
}

// ---------------------------------------------------------------------
// Behaviour record (design §3.6)
// ---------------------------------------------------------------------

export type BehaviourReason =
  | "performed"
  | "fallback-unprepared"
  | "fallback-invalid"
  | "degraded-untrusted"
  | "user-act"
  | "set-end"
  // Supply contribution outcomes (§8.3): a locally computed
  // document offered to the mixing server's shelf in the
  // background. Counted here — never narrated to the listener —
  // so a contribution that silently failed is as visible in the
  // record as one that landed. Records carry family null and the
  // document's content hashes in pairTrackIds (supply has no
  // track ids; the hashes ARE the pair's identity there).
  | "supply-contributed"
  | "supply-contribution-conflict"
  | "supply-contribution-failed";

export const BEHAVIOUR_REASONS: readonly BehaviourReason[] = [
  "performed",
  "fallback-unprepared",
  "fallback-invalid",
  "degraded-untrusted",
  "user-act",
  "set-end",
  "supply-contributed",
  "supply-contribution-conflict",
  "supply-contribution-failed",
];

/**
 * Provenance stamp (optimisation wave item 4 — Receipts;
 * ADAPTATION A3). Every join record answers "whose idea was
 * this?" with a small, load-bearing stamp: the source that put
 * the winning candidate on the slate (or the ladder rung that
 * landed the join when no authored candidate performed), the
 * candidate's position in the final slate, the ladder rung that
 * performed it, and the crate-table version that weighted the
 * draw. Optional on the record: records written before the wave
 * (and by test doubles that replace the brain wholesale) carry
 * no stamp rather than a fabricated one.
 */
export type ProvenanceSource =
  | "planner"
  | "taste"
  | "guest"
  | "user-act"
  | `personality:${string}`
  | `ladder-rung:${number}`;

export interface ProvenanceStamp {
  source: ProvenanceSource;
  /** 1-based position in the final slate at draw time; null when no slate existed. */
  slatePosition: number | null;
  /** Ladder rung that performed the join (1–4); null when not ladder-landed. */
  ladderRung: number | null;
  /** Crate table version that weighted the draw; null when unweighted. */
  cratesVersion: string | null;
}

export interface BehaviourRecord {
  /** Epoch milliseconds when the join/fallback happened. */
  at: number;
  /** The join's family; null when no join was performed at all. */
  family: JoinFamily | null;
  technique?: ScratchTechnique;
  fxKinds: FxKind[];
  /** [outgoingTrackId, incomingTrackId]. */
  pairTrackIds: [string, string];
  /** The drawn candidate's suitability; null when none was drawn. */
  suitability: number | null;
  /** Size of the draw pool the pick came from (0 when none). */
  poolSize: number;
  reason: BehaviourReason;
  /** Wave item 4: whose idea this join was (see ProvenanceStamp). */
  provenance?: ProvenanceStamp;
}

/** The injected persistence seam for the behaviour log. */
export interface BehaviourStore {
  append(record: BehaviourRecord): void;
  list(): BehaviourRecord[];
}

/** Design §3.6: the persisted log is capped at 400 records. */
export const BEHAVIOUR_LOG_CAP = 400;

/**
 * In-memory BehaviourStore (oldest records drop past the cap).
 * The session wave wires storage.ts behind this same interface.
 */
export function createInMemoryBehaviourStore(
  cap: number = BEHAVIOUR_LOG_CAP,
): BehaviourStore {
  const records: BehaviourRecord[] = [];
  return {
    append(record: BehaviourRecord): void {
      records.push(record);
      while (records.length > cap) records.shift();
    },
    list(): BehaviourRecord[] {
      return [...records];
    },
  };
}

export interface BehaviourDistribution {
  total: number;
  byFamily: Record<string, number>;
  byTechnique: Record<string, number>;
  byReason: Record<string, number>;
}

export interface BehaviourLog {
  /** Append a fully-formed record (at defaults to now). */
  record(record: Omit<BehaviourRecord, "at"> & { at?: number }): void;
  /** Append a performed join. */
  recordPerformed(input: {
    family: JoinFamily;
    technique?: ScratchTechnique;
    fxKinds?: FxKind[];
    pairTrackIds: [string, string];
    suitability: number | null;
    poolSize: number;
    provenance?: ProvenanceStamp;
    at?: number;
  }): void;
  /** Append a fallback / degradation / non-draw outcome. */
  recordFallback(input: {
    family: JoinFamily | null;
    technique?: ScratchTechnique;
    fxKinds?: FxKind[];
    pairTrackIds: [string, string];
    suitability: number | null;
    poolSize: number;
    reason: Exclude<BehaviourReason, "performed">;
    provenance?: ProvenanceStamp;
    at?: number;
  }): void;
  /** All records, oldest first (the design's getBehaviourLog read API). */
  getBehaviourLog(): BehaviourRecord[];
  /** Counts by family / technique / reason over the whole log. */
  distribution(): BehaviourDistribution;
}

export function createBehaviourLog(
  store: BehaviourStore = createInMemoryBehaviourStore(),
): BehaviourLog {
  function append(record: BehaviourRecord): void {
    store.append(record);
  }

  return {
    record(input): void {
      append({
        at: input.at ?? Date.now(),
        family: input.family,
        technique: input.technique,
        fxKinds: [...(input.fxKinds ?? [])],
        pairTrackIds: [...input.pairTrackIds] as [string, string],
        suitability: input.suitability,
        poolSize: input.poolSize,
        reason: input.reason,
        provenance: input.provenance,
      });
    },

    recordPerformed(input): void {
      append({
        at: input.at ?? Date.now(),
        family: input.family,
        technique: input.technique,
        fxKinds: [...(input.fxKinds ?? [])],
        pairTrackIds: [...input.pairTrackIds] as [string, string],
        suitability: input.suitability,
        poolSize: input.poolSize,
        reason: "performed",
        provenance: input.provenance,
      });
    },

    recordFallback(input): void {
      append({
        at: input.at ?? Date.now(),
        family: input.family,
        technique: input.technique,
        fxKinds: [...(input.fxKinds ?? [])],
        pairTrackIds: [...input.pairTrackIds] as [string, string],
        suitability: input.suitability,
        poolSize: input.poolSize,
        reason: input.reason,
        provenance: input.provenance,
      });
    },

    getBehaviourLog(): BehaviourRecord[] {
      return store.list();
    },

    distribution(): BehaviourDistribution {
      const byFamily: Record<string, number> = {};
      const byTechnique: Record<string, number> = {};
      const byReason: Record<string, number> = {};
      const records = store.list();
      for (const record of records) {
        const familyKey = record.family ?? "none";
        byFamily[familyKey] = (byFamily[familyKey] ?? 0) + 1;
        if (record.technique !== undefined) {
          byTechnique[record.technique] =
            (byTechnique[record.technique] ?? 0) + 1;
        }
        byReason[record.reason] = (byReason[record.reason] ?? 0) + 1;
      }
      return { total: records.length, byFamily, byTechnique, byReason };
    },
  };
}
