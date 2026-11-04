// Join history (Step 5, slice S5-3): the session's memory of the
// joins ACTUALLY PERFORMED — the blueprint §4.4 job, and the input
// the Note 4/11 charter's second requirement names: "memory of
// previous joins", without which anti-repetition is impossible in
// principle (v1's decider signature admitted neither context nor
// history, so it could repeat the same shape forever and never know).
//
// Two halves live here:
//
// - The LOG: an append-only record (pair identity by analysis
//   fingerprint, family, profile, pair-shape, geometry, heard
//   length, when), capped and persisted across sessions in linerDb's
//   `joins` store — the analysis cache's storage pattern, one record
//   holding the whole log. The in-memory array is the synchronous
//   source of truth; persistence is fire-and-forget, and a corrupt
//   stored log reads as an empty one, never a crash: a lost memory
//   must cost variety, not the set.
//
// - The READ: `repetitionCost` — the anti-repetition rule as a pure
//   function over the log. Scoring calls it; nothing else may invent
//   repetition judgements. Its exact shape:
//
//     · Only the profile's window of most recent joins is weighed.
//     · A record's weight decays with recency rank: 1/(1 + rank),
//       rank 0 = the most recent join.
//     · Same family: the profile's familyRepeatCost when the record's
//       pair-shape matches the probe's, familyRepeatCostOtherShape
//       when it does not — repetition of a MOVE is the disease;
//       repetition across unlike pairs is a milder symptom.
//     · Same family AND near-identical geometry (blend length within
//       2 beats): geometryRepeatCost on top.
//     · The exact pair again (both fingerprints equal): samePairCost,
//       whatever the family.
//     · Heard length: when the probe's heard length would make THREE
//       in a row within ±5% (the last two joins both near it),
//       heardLengthRepeatCost, once.
//     · The total is clamped at the profile's maxCost, so history can
//       demote a candidate within and across the near-equal band but
//       can never single-handedly bury a family's only honest join.
//
//   A fresh (empty) history costs every probe exactly 0 — the rule is
//   only history-deep, by construction.

import { linerDb, JOINS_LOG_RECORD_ID } from "@/shared/storage";
import type { TrackAnalysis } from "./analyseTrack";
import {
  JOIN_FAMILIES,
  type DecisionProfile,
  type JoinFamily,
} from "./decisionProfile";
import { meanVocalActivity } from "./detectVocals";
import { keyCompatibility } from "./keyCompatibility";

/** One performed join, as the log remembers it. */
export interface JoinRecord {
  /** Outgoing track's analysis fingerprint (null when unhashed). */
  aAudioHash: string | null;
  /** Incoming track's analysis fingerprint (null when unhashed). */
  bAudioHash: string | null;
  /** The family that was actually performed. */
  family: JoinFamily;
  /** The profile the winning candidate was scored under. */
  profileId: string;
  /** The pair-shape the join was performed for (see pairShapeOf). */
  pairShape: string;
  /** Blend length in beats of the outgoing (0 for cuts). */
  blendBeats: number;
  /** |rateB − 1| of the performed join. */
  stretch: number;
  /**
   * How long the outgoing track had been playing when the join
   * began, in seconds — the "heard length" whose repetition the
   * charter counts (three similar exits in a row is a pattern a
   * listener feels even when the families differ).
   */
  heardLengthSec: number | null;
  /** When the join was performed, epoch milliseconds. */
  at: number;
  /**
   * Blueprint §28's transition evaluation (revamp R6): how well
   * this performed join actually went, scored after the fact and
   * judged relative to the personality that authored it. Absent
   * on records written before R6 and on records whose caller
   * supplied no performance outcome — absence is neutral, never
   * a failing grade (see evaluationWeight in selection.ts).
   */
  evaluation?: JoinEvaluation;
}

/**
 * §28's post-transition scorecard. Every component is 0..1,
 * higher is better; `overall` is their personality-relative
 * weighted mean (see evaluatePerformedJoin in brain.ts).
 */
export interface JoinEvaluation {
  /** Did the join land on the musical grid it aimed at? */
  beatAlignment: number;
  /** Did the level stay continuous across the join? */
  loudnessContinuity: number;
  /** Harmonic + structural compatibility, as performed. */
  harmonicStructural: number;
  /** Did the decks execute the plan fully (vs cut short)? */
  executionReliability: number;
  /** The weighted mean the feedback loop spends. */
  overall: number;
}

/**
 * Reads a record's §28 evaluation defensively: stored payloads
 * are never trusted, so a malformed evaluation reads as absent
 * (neutral) rather than poisoning the feedback loop.
 */
export function evaluationOf(record: JoinRecord): JoinEvaluation | undefined {
  const e = record.evaluation;
  if (!e || typeof e !== "object") return undefined;
  const fields = [
    e.beatAlignment,
    e.loudnessContinuity,
    e.harmonicStructural,
    e.executionReliability,
    e.overall,
  ];
  if (
    fields.some(
      (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1,
    )
  ) {
    return undefined;
  }
  return e;
}

/** The stored log never grows past this many records. */
export const MAX_STORED_JOINS = 400;

/** The linerDb record id the log persists under (shared home:
 * shared/storage, beside the `joins` store — S2 seams (d)). */
export const JOIN_LOG_ID = JOINS_LOG_RECORD_ID;

// ---------------------------------------------------------------------
// Pair shape
// ---------------------------------------------------------------------

/**
 * Whole-track vocal density 0..1, or null when the analysis carries
 * no usable vocal evidence. Mirrors the author's own density read
 * (graded curve first, section means second, legacy ranges last) so
 * the shape vocabulary and the author's vocabulary agree.
 */
export function vocalDensityOf(analysis: TrackAnalysis): number | null {
  if (analysis.vocalActivity && analysis.vocalActivity.points.length > 0) {
    return meanVocalActivity(
      analysis.vocalActivity,
      0,
      analysis.beatMap.durationSec,
    );
  }
  if (analysis.sections && analysis.sections.length > 0) {
    const total = analysis.sections.reduce(
      (sum, s) => sum + (s.endSec - s.startSec),
      0,
    );
    if (total > 0) {
      return (
        analysis.sections.reduce(
          (sum, s) => sum + s.vocalActivity * (s.endSec - s.startSec),
          0,
        ) / total
      );
    }
  }
  if (analysis.vocalRanges.length > 0) {
    const covered = analysis.vocalRanges.reduce(
      (sum, r) => sum + Math.max(0, r.endSec - r.startSec),
      0,
    );
    return covered / Math.max(1, analysis.beatMap.durationSec);
  }
  return null;
}

/**
 * A compact description of WHAT KIND of pair a join served — the
 * similarity the anti-repetition rule compares. Three facets, all
 * derived from structure, never from track identity: the tempo
 * relation, the key relation, and which sides sing. Two joins for
 * the same shape are "similar pairs" for repetition purposes even
 * when the tracks are entirely different.
 */
export function pairShapeOf(
  outgoing: TrackAnalysis,
  incoming: TrackAnalysis,
): string {
  const ratio = incoming.beatMap.bpm / Math.max(1, outgoing.beatMap.bpm);
  const tempo = ratio > 1.02 ? "faster" : ratio < 0.98 ? "slower" : "matched";
  const key =
    keyCompatibility(outgoing.key, incoming.key)?.relation ?? "unknown";
  const outDensity = vocalDensityOf(outgoing);
  const inDensity = vocalDensityOf(incoming);
  let vocal: string;
  if (outDensity === null || inDensity === null) {
    vocal = "vocal-unknown";
  } else {
    const outVocal = outDensity > 0.25;
    const inVocal = inDensity > 0.25;
    vocal =
      outVocal && inVocal
        ? "both-vocal"
        : outVocal || inVocal
          ? "one-vocal"
          : "no-vocal";
  }
  return `${tempo}/${key}/${vocal}`;
}

// ---------------------------------------------------------------------
// The anti-repetition read
// ---------------------------------------------------------------------

/** What a candidate would repeat, if performed now. */
export interface RepetitionProbe {
  family: JoinFamily;
  pairShape: string;
  blendBeats: number;
  heardLengthSec: number | null;
  aAudioHash: string | null;
  bAudioHash: string | null;
}

export interface RepetitionCost {
  /** 0..profile.antiRepetition.maxCost. Exactly 0 for a fresh history. */
  cost: number;
  /** Human-readable account of every charge, for the evidence trail. */
  notes: string[];
}

const FAMILY_SET: ReadonlySet<string> = new Set(JOIN_FAMILIES);

export function repetitionCost(
  history: readonly JoinRecord[],
  probe: RepetitionProbe,
  profile: DecisionProfile,
): RepetitionCost {
  const anti = profile.antiRepetition;
  const notes: string[] = [];
  if (history.length === 0) return { cost: 0, notes };

  const window = history.slice(-anti.windowJoins);
  let cost = 0;

  for (let rank = 0; rank < window.length; rank += 1) {
    const record = window[window.length - 1 - rank];
    const decay = 1 / (1 + rank);
    const ago = rank === 0 ? "the last join" : `${rank + 1} joins ago`;

    if (record.family === probe.family) {
      const sameShape = record.pairShape === probe.pairShape;
      const base = sameShape
        ? anti.familyRepeatCost
        : anti.familyRepeatCostOtherShape;
      cost += base * decay;
      notes.push(
        `${probe.family} was performed ${ago}` +
          (sameShape
            ? ` for a similar pair (−${(base * decay).toFixed(3)})`
            : ` for a different pair-shape (−${(base * decay).toFixed(3)})`),
      );
      if (
        probe.blendBeats > 0 &&
        record.blendBeats > 0 &&
        Math.abs(record.blendBeats - probe.blendBeats) <= 2
      ) {
        cost += anti.geometryRepeatCost * decay;
        notes.push(
          `…with near-identical geometry (${record.blendBeats} vs ${probe.blendBeats} beats, −${(anti.geometryRepeatCost * decay).toFixed(3)})`,
        );
      }
    }

    if (
      probe.aAudioHash !== null &&
      probe.bAudioHash !== null &&
      record.aAudioHash === probe.aAudioHash &&
      record.bAudioHash === probe.bAudioHash
    ) {
      cost += anti.samePairCost * decay;
      notes.push(
        `this exact pair was joined ${ago} (−${(anti.samePairCost * decay).toFixed(3)})`,
      );
    }
  }

  if (probe.heardLengthSec !== null && probe.heardLengthSec > 0) {
    const lastTwo = window.slice(-2);
    const near = (value: number | null): boolean =>
      value !== null &&
      Math.abs(value - probe.heardLengthSec!) <= probe.heardLengthSec! * 0.05;
    if (lastTwo.length === 2 && lastTwo.every((r) => near(r.heardLengthSec))) {
      cost += anti.heardLengthRepeatCost;
      notes.push(
        `the last two joins also left after ~${Math.round(probe.heardLengthSec)}s heard — a third would pattern (−${anti.heardLengthRepeatCost.toFixed(3)})`,
      );
    }
  }

  return { cost: Math.min(cost, anti.maxCost), notes };
}

// ---------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------

/** Persistence seam — the linerDb-backed default, fakes in tests. */
export interface JoinLogStorage {
  /** The raw stored payload (validated by the log, never trusted). */
  read(): Promise<unknown>;
  write(joins: readonly JoinRecord[]): Promise<void>;
}

export const linerDbJoinStorage: JoinLogStorage = {
  async read(): Promise<unknown> {
    const record = await linerDb.getJoinLog(JOIN_LOG_ID);
    return record ? record.joins : null;
  },
  async write(joins: readonly JoinRecord[]): Promise<void> {
    await linerDb.putJoinLog({
      id: JOIN_LOG_ID,
      joins: [...joins],
      savedAt: Date.now(),
    });
  },
};

function isJoinRecord(value: unknown): value is JoinRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.family === "string" &&
    FAMILY_SET.has(r.family) &&
    typeof r.profileId === "string" &&
    typeof r.pairShape === "string" &&
    typeof r.blendBeats === "number" &&
    Number.isFinite(r.blendBeats) &&
    typeof r.stretch === "number" &&
    Number.isFinite(r.stretch) &&
    (r.heardLengthSec === null ||
      (typeof r.heardLengthSec === "number" &&
        Number.isFinite(r.heardLengthSec))) &&
    (r.aAudioHash === null || typeof r.aAudioHash === "string") &&
    (r.bAudioHash === null || typeof r.bAudioHash === "string") &&
    typeof r.at === "number" &&
    Number.isFinite(r.at)
  );
}

/**
 * Validate a raw stored payload into a log. Anything unrecognised is
 * dropped; a wholly corrupt payload is an empty log. Exported for
 * tests and for any future import path.
 */
export function validateJoinLog(raw: unknown): JoinRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isJoinRecord).slice(-MAX_STORED_JOINS);
}

/**
 * The join log. The in-memory array (oldest first) is the source of
 * truth for reads; `load()` hydrates it from storage once, `record()`
 * appends synchronously and persists fire-and-forget — a performed
 * join must never wait on a disk.
 */
export class JoinHistoryLog {
  private joins: JoinRecord[] = [];
  private loaded = false;

  constructor(private readonly storage: JoinLogStorage) {}

  /** Hydrate from storage (idempotent). Returns the full log. */
  async load(): Promise<readonly JoinRecord[]> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.joins = validateJoinLog(await this.storage.read());
      } catch {
        this.joins = [];
      }
    }
    return this.all();
  }

  /** Append a performed join; trims the oldest beyond the cap. */
  record(join: JoinRecord): void {
    this.joins.push(join);
    if (this.joins.length > MAX_STORED_JOINS) {
      this.joins = this.joins.slice(-MAX_STORED_JOINS);
    }
    void this.storage.write(this.joins).catch(() => {
      // Persistence is best-effort: the in-memory log still serves
      // this session's anti-repetition.
    });
  }

  /** The whole log, oldest first. */
  all(): readonly JoinRecord[] {
    return this.joins;
  }

  /** The n most recent joins, oldest first. */
  recent(n: number): JoinRecord[] {
    return n <= 0 ? [] : this.joins.slice(-n);
  }

  get size(): number {
    return this.joins.length;
  }

  /** Forget everything, in memory and in storage. */
  async clear(): Promise<void> {
    this.joins = [];
    this.loaded = true;
    try {
      await this.storage.write([]);
    } catch {
      // Same best-effort rule as record().
    }
  }
}

export function createJoinHistory(
  storage: JoinLogStorage = linerDbJoinStorage,
): JoinHistoryLog {
  return new JoinHistoryLog(storage);
}

/**
 * The app-wide log. S5-4's session loads it at set start and records
 * each performed join into it; until then it simply exists, empty.
 */
export const joinHistory = createJoinHistory();
