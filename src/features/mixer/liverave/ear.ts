// ear.ts — the Ear (optimisation wave item 5; ADAPTATION A10+A7).
//
// Outcome recording against the STAMPED transition (item 4's
// receipts), with labels defined in advance — the same discipline
// as Block Blast's round features ("a round counts as success
// only if…"), with the objective inverted: the labels exist to
// learn what the listener loves, never to steer against them.
// Data stays on-device, in the local transition history store,
// inspectable through the session's getTransitionHistory().
//
// The label set (kept small and distinct, per A10):
//
//   "skip-in-blend" — the listener skipped DURING the join's
//       blend window. A TRANSITION failure: the join itself was
//       rejected. Carries the position inside the join.
//   "skip-after"    — the listener skipped the incoming track
//       after the join completed. A TRACK event: the song was
//       rejected, not the join. Carries the position in the track.
//       (Conflating these two is how a taste engine learns the
//       wrong lesson; they are never merged.)
//   "repeat"        — the incoming track immediately played
//       again (repeat behaviour): the pairing was re-chosen by
//       the listener's own setting.
//   "replay"        — the listener went back to the track
//       (skip-previous return, or a seek back to its start after
//       hearing most of it): positive evidence about the track.
//   "completion"    — the incoming track played through to its
//       natural end (the next join leaves FROM it) with no skip
//       recorded against it: the transition succeeded.
//
// Collection runs from day one; consumption is deliberately
// minimal in this wave — the cooldown shelf hears failures and
// successes (item 8) — because a history store cannot be
// backdated, and Block Blast's dataset is valuable precisely
// because it was collected before it was needed.

export type TransitionOutcomeLabel =
  "skip-in-blend" | "skip-after" | "repeat" | "replay" | "completion";

export const TRANSITION_OUTCOME_LABELS: readonly TransitionOutcomeLabel[] = [
  "skip-in-blend",
  "skip-after",
  "repeat",
  "replay",
  "completion",
];

export interface TransitionOutcome {
  /** `at` of the behaviour record this outcome judges. */
  recordAt: number;
  /** The stamped transition's [outgoing, incoming] track ids. */
  pairTrackIds: [string, string];
  label: TransitionOutcomeLabel;
  /** Epoch ms when the outcome was observed. */
  at: number;
  /**
   * For skips: where the skip landed — inside the join
   * (skip-in-blend) or inside the track (skip-after). Else null.
   */
  positionMs: number | null;
}

/** The persistence seam (storage.ts wires IndexedDB behind it). */
export interface OutcomeStore {
  append(outcome: TransitionOutcome): void;
  list(): TransitionOutcome[];
}

export const OUTCOME_LOG_CAP = 400;

export function createInMemoryOutcomeStore(
  cap: number = OUTCOME_LOG_CAP,
): OutcomeStore {
  const outcomes: TransitionOutcome[] = [];
  return {
    append(outcome: TransitionOutcome): void {
      outcomes.push(outcome);
      while (outcomes.length > cap) outcomes.shift();
    },
    list(): TransitionOutcome[] {
      return [...outcomes];
    },
  };
}

/** One landed join, as the Ear tracks it. */
export interface EarJoin {
  recordAt: number;
  pairTrackIds: [string, string];
  /** The incoming track — the one the outcome judges. */
  incomingTrackId: string;
}

/**
 * The Ear's state machine. The session feeds it landed joins and
 * listener acts; it owns exactly one "open" transition (the most
 * recent join, whose incoming track is still playing) and writes
 * outcomes to the store. Rules:
 *
 * - A new join landing CLOSES the previous open transition: if
 *   the new join leaves from the open transition's incoming
 *   track, that track played through — "completion", unless any
 *   outcome already judges it (a skip was already recorded; a
 *   track the listener skipped out of does not also "complete").
 *   If the new join's incoming track IS the open transition's
 *   incoming track, the label is "repeat" instead.
 * - A skip while a blend is performing judges the ACTIVE join's
 *   record (which lands as the skip completes it): skip-in-blend.
 * - A skip at any other time judges the open transition:
 *   skip-after.
 */
export class TransitionEar {
  private open: EarJoin | null = null;
  private readonly store: OutcomeStore;
  private readonly now: () => number;

  constructor(store: OutcomeStore, now: () => number = () => Date.now()) {
    this.store = store;
    this.now = now;
  }

  private record(
    join: EarJoin,
    label: TransitionOutcomeLabel,
    positionMs: number | null,
  ): void {
    this.store.append({
      recordAt: join.recordAt,
      pairTrackIds: [...join.pairTrackIds] as [string, string],
      label,
      at: this.now(),
      positionMs,
    });
  }

  private hasOutcome(recordAt: number): boolean {
    return this.store.list().some((outcome) => outcome.recordAt === recordAt);
  }

  /** A join record landed (performed / degraded / user-act). */
  joinLanded(join: EarJoin): void {
    const previous = this.open;
    if (previous && previous.recordAt !== join.recordAt) {
      if (!this.hasOutcome(previous.recordAt)) {
        if (join.pairTrackIds[1] === previous.incomingTrackId) {
          this.record(previous, "repeat", null);
        } else if (join.pairTrackIds[0] === previous.incomingTrackId) {
          this.record(previous, "completion", null);
        }
      }
    }
    this.open = join;
  }

  /** The listener skipped during the blend window of the open join. */
  skipInBlend(positionMs: number | null): void {
    if (!this.open) return;
    this.record(this.open, "skip-in-blend", positionMs);
  }

  /** The listener skipped the open transition's track after the join. */
  skipAfter(positionMs: number | null): void {
    if (!this.open) return;
    if (this.hasOutcome(this.open.recordAt)) return;
    this.record(this.open, "skip-after", positionMs);
  }

  /** The listener returned to a track: positive evidence. */
  replay(recordAt: number, pairTrackIds: [string, string]): void {
    this.record(
      { recordAt, pairTrackIds, incomingTrackId: pairTrackIds[1] },
      "replay",
      null,
    );
  }

  /** The record the Ear currently holds open, if any. */
  openJoin(): EarJoin | null {
    return this.open;
  }

  outcomes(): TransitionOutcome[] {
    return this.store.list();
  }

  outcomesFor(recordAt: number): TransitionOutcome[] {
    return this.store.list().filter((outcome) => outcome.recordAt === recordAt);
  }

  /** Forget the open transition without judging it (session end). */
  close(): void {
    this.open = null;
  }
}
