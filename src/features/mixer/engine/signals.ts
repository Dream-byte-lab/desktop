// signals.ts — liveRave's ears, as data.
//
// liveRave is the brain; the signals are what the brain feels. Every
// entry in the room — the solo listener skipping, replaying, riding a
// song out, riding the volume; the party's guests reacting — arrives
// here as a small, timestamped event, and this module turns the event
// stream into the few slow-moving readings the brain reasons with:
// impatience, engagement, per-family charges, party momentum.
//
// The readings are deliberately SLOW. A signal is a mood, not a
// reflex: each one decays with a stated half-life, a single volume
// move is noise, and nothing here can veto a safety rule (the may-not
// rules live with the deciders — a do-not-play refusal and a
// committed join hold at any signal pressure; this module only
// shifts taste, within the bounds brain.ts applies).
//
// Room size is a recorded NON-EFFECT in v2: the renderer's party
// state carries no guest count (the server owns it and does not
// publish one), so there is nothing honest to read. If a count ever
// reaches the renderer it lands here as another event kind; until
// then the brain does not pretend to know how big the room is.

import type { JoinFamily } from "./decisionProfile";

/** Every kind of live evidence the brain accepts. */
export type SignalKind =
  | "skip-early"
  | "skip-late"
  | "completion"
  | "repeat"
  | "volume-up"
  | "volume-down"
  | "seek-back"
  | "blend-interrupted"
  | "blend-completed"
  | "party-reaction";

export interface SignalEvent {
  kind: SignalKind;
  atMs: number;
  /** The join family the event speaks about, where one applies. */
  family?: JoinFamily | string;
}

/** How strongly each event kind speaks, and how fast it fades. */
export const SIGNAL_TUNING = {
  /** Half-life of the impatience reading, ms. A mood passes. */
  impatienceHalfLifeMs: 90_000,
  /** Half-life of the engagement reading, ms. Settling lingers. */
  engagementHalfLifeMs: 240_000,
  /** Half-life of a per-family charge, ms. */
  familyChargeHalfLifeMs: 180_000,
  /** One early skip's impatience weight. Two in quick succession saturate. */
  skipEarlyImpatience: 0.7,
  /** Interrupting a sounding blend also reads as impatience. */
  blendInterruptedImpatience: 0.4,
  /** A completion relieves impatience by this much (the room settled). */
  completionRelief: 0.35,
  /** A repeat relieves impatience by this much. */
  repeatRelief: 0.2,
  /** Family charge laid by an early skip against the delivering join. */
  skipEarlyFamilyCharge: 0.6,
  /** Family charge laid by interrupting a blend against its family. */
  blendInterruptedFamilyCharge: 0.8,
  /** Family credit earned when a join is repeated back to (approval). */
  repeatFamilyCredit: -0.5,
  /** Family credit earned when a blend is ridden out to completion. */
  blendCompletedFamilyCredit: -0.15,
  /** Engagement weights per event kind (before decay). */
  engagementWeights: {
    completion: 0.5,
    repeat: 0.8,
    "blend-completed": 0.3,
    "volume-up": 0.25,
    "volume-down": -0.3,
    "skip-early": -0.2,
  } as Partial<Record<SignalKind, number>>,
  /** Party momentum: the window each side of "now" is compared over. */
  partyWindowMs: 60_000,
  /** Denominator floor for momentum, so two stray taps are not a surge. */
  partyMomentumFloor: 4,
  /** How many recent events the journal keeps. */
  journalCap: 240,
} as const;

function decayWeight(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The session's signal journal and its derived readings. One bank per
 * set; the session feeds it, the brain reads it. The clock is
 * injectable so tests can walk time deterministically.
 */
export class SignalBank {
  private events: SignalEvent[] = [];
  /** Where the listener sought back to, newest last (journal marks). */
  private seekBackMarks: number[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  record(event: Omit<SignalEvent, "atMs"> & { atMs?: number }): void {
    const atMs = event.atMs ?? this.now();
    this.events.push({ kind: event.kind, atMs, family: event.family });
    if (this.events.length > SIGNAL_TUNING.journalCap) {
      this.events.splice(0, this.events.length - SIGNAL_TUNING.journalCap);
    }
    if (event.kind === "seek-back") {
      this.seekBackMarks.push(atMs);
      if (this.seekBackMarks.length > 64) this.seekBackMarks.shift();
    }
  }

  /** The raw journal, oldest first (bounded; for tests and the trail). */
  journal(): readonly SignalEvent[] {
    return this.events;
  }

  /** Seek-back marks: recorded context, a documented non-effect on joins. */
  seekBacks(): readonly number[] {
    return this.seekBackMarks;
  }

  clear(): void {
    this.events = [];
    this.seekBackMarks = [];
  }

  /**
   * Impatience, 0..1: the room wants shorter rides and quicker
   * arrivals. Raised by early skips and interrupted blends, relieved
   * by completions and repeats, fading with a 90-second half-life.
   */
  impatience(atMs: number = this.now()): number {
    let raised = 0;
    let relief = 0;
    for (const event of this.events) {
      const weight = decayWeight(
        atMs - event.atMs,
        SIGNAL_TUNING.impatienceHalfLifeMs,
      );
      if (event.kind === "skip-early") {
        raised += SIGNAL_TUNING.skipEarlyImpatience * weight;
      } else if (event.kind === "blend-interrupted") {
        raised += SIGNAL_TUNING.blendInterruptedImpatience * weight;
      } else if (event.kind === "completion") {
        relief += SIGNAL_TUNING.completionRelief * weight;
      } else if (event.kind === "repeat") {
        relief += SIGNAL_TUNING.repeatRelief * weight;
      }
    }
    // Relief is subtracted after the raise saturates, so a room
    // that settles is heard even when it was recently impatient.
    return clamp(clamp(raised, 0, 1) - relief, 0, 1);
  }

  /**
   * Engagement, −1..1: the room is with the set (positive) or
   * drifting from it (negative). Completions, repeats and ridden-out
   * blends speak for the set; volume moves are weak evidence that
   * only a pattern makes meaningful.
   */
  engagement(atMs: number = this.now()): number {
    let total = 0;
    for (const event of this.events) {
      const weight = SIGNAL_TUNING.engagementWeights[event.kind];
      if (weight === undefined) continue;
      total +=
        weight *
        decayWeight(atMs - event.atMs, SIGNAL_TUNING.engagementHalfLifeMs);
    }
    return clamp(total, -1, 1);
  }

  /**
   * Per-family charges (positive) and credits (negative) laid by the
   * room against the joins that delivered what it reacted to. The
   * brain folds these into the derived profile's family costs.
   */
  familyCharges(atMs: number = this.now()): Map<string, number> {
    const charges = new Map<string, number>();
    const add = (family: string | undefined, amount: number) => {
      if (!family || amount === 0) return;
      charges.set(family, (charges.get(family) ?? 0) + amount);
    };
    for (const event of this.events) {
      const weight = decayWeight(
        atMs - event.atMs,
        SIGNAL_TUNING.familyChargeHalfLifeMs,
      );
      if (event.kind === "skip-early") {
        add(event.family, SIGNAL_TUNING.skipEarlyFamilyCharge * weight);
      } else if (event.kind === "blend-interrupted") {
        add(event.family, SIGNAL_TUNING.blendInterruptedFamilyCharge * weight);
      } else if (event.kind === "repeat") {
        add(event.family, SIGNAL_TUNING.repeatFamilyCredit * weight);
      } else if (event.kind === "blend-completed") {
        add(event.family, SIGNAL_TUNING.blendCompletedFamilyCredit * weight);
      }
    }
    return charges;
  }

  /**
   * Party momentum, −1..1: reactions in the last window versus the
   * window before it. Rising reactions push the arc target up a
   * gear; a dying room lets it fall. Zero when the party ear is
   * closed or silent — momentum is about change, not applause level.
   */
  partyMomentum(atMs: number = this.now()): number {
    const windowMs = SIGNAL_TUNING.partyWindowMs;
    let recent = 0;
    let prior = 0;
    for (const event of this.events) {
      if (event.kind !== "party-reaction") continue;
      const age = atMs - event.atMs;
      if (age < 0) continue;
      if (age <= windowMs) recent += 1;
      else if (age <= windowMs * 2) prior += 1;
    }
    if (recent + prior === 0) return 0;
    return clamp(
      (recent - prior) /
        Math.max(SIGNAL_TUNING.partyMomentumFloor, recent + prior),
      -1,
      1,
    );
  }

  /**
   * The arc-target bias the signals ask for, in energy units: a
   * settled room earns a gentle lift; a surging party earns more; a
   * room drifting away pulls the target down. Small by design — the
   * arc belongs to the set; signals lean on it, they do not steer it.
   */
  arcBias(atMs: number = this.now()): number {
    return this.engagement(atMs) * 0.05 + this.partyMomentum(atMs) * 0.12;
  }
}
