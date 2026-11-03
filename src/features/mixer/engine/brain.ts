// brain.ts — liveRave itself: the loop that thinks before each join.
//
// The brain is where liveRave's ruling lives: mixing decisions are
// made from the tracks as they unfold, the set's context, and the
// live signals — always, not only when a party runs. The decks are
// its hands; the party is one of its ears; a solo listener's skips,
// repeats, volume moves and completions are the same mechanic with a
// room of one.
//
// The loop, per join (the S5-3 seam, §8 of that slice's report):
//
//   candidatesForPair(pair, { profiles: [derivedProfile] })
//     → scoreCandidates(candidates,
//         { history, arcPosition, arcTargetEnergy }, derivedProfile)
//     → selection.selectFromBand(scored.band, …) — blueprint §16's
//       temperature-softmax over the near-equal band, shaped by
//       §15's recent-use penalties, drawn from a generator seeded
//       by session state (seed + set index + decision index)
//     → the session performs the sampled candidate's recipe
//       through the executor, then recordPerformed() writes the
//       join to history.
//
// Scoring's own deterministic pick (lowest history cost in the
// band) survives as the reference the selection record is checked
// against (`agreedWithScorer`) — the audit trail keeps both what
// the old rule would have done and what the lottery did.
//
// "Derived profile" is how signals move decisions: the session's
// base temperament (the decision profile) is adjusted by the signal
// bank's current readings — impatience raises the cost of long
// rides, the room's charges land on the families that earned them —
// and the ADJUSTED profile is what authors and scores. Signals
// therefore change real weights (the blueprint's Req 2 test reads
// them here), never a hidden side channel. The arc target likewise
// comes from the night's chosen arc shape, leaned on by the
// signals' arc bias.
//
// The brain owns no decks and no timers. It reads prepared tracks
// (their cached v2 analyses — preparation is the session's job, on
// the one-track horizon), decides, and remembers. It cannot alter a
// committed join: once the session performs a recipe the brain's
// next consideration is about the NEXT pair, and the may-not rules
// (a do-not-play refusal, a locked join) are enforced by the layers
// that own them, at any signal pressure — signals shift taste only.

import { candidatesForPair, type Candidate } from "./candidates";
import { scoreCandidates, type ScoredCandidate } from "./scoring";
import {
  decisionSeed,
  randomForDecision,
  selectFromBand,
  type SelectionRecord,
} from "./selection";
import { STANDARD_PROFILE, type DecisionProfile } from "./decisionProfile";
import {
  joinHistory,
  type JoinHistoryLog,
  type JoinRecord,
} from "./joinHistory";
import { SignalBank } from "./signals";
import { arcTarget, type ArcShapeName } from "./curatedSet";
import type { TransitionRecipe } from "./recipe";
import type { PreparedTrack } from "./trackSource";

/** How hard the signal readings lean on the profile's family costs. */
export const SIGNAL_PROFILE_TUNING = {
  /** Impatience's added cost on each long-ride family, at full impatience. */
  longRideCostAtFullImpatience: 0.1,
  /** The families that count as long rides for impatience. */
  longRideFamilies: ["long-blend", "loop-extended-blend"] as const,
  /** A family charge's conversion into profile cost (charges are ~0..1). */
  familyChargeToCost: 0.15,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The profile a decision is actually made with: the base temperament
 * adjusted by the room's current readings. Pure and exported so the
 * effect of every signal on the weights is directly testable.
 */
export function deriveProfile(
  base: DecisionProfile,
  signals: SignalBank,
  atMs?: number,
): DecisionProfile {
  const familyCosts: DecisionProfile["familyCosts"] = {
    ...base.familyCosts,
  };
  const impatience = signals.impatience(atMs);
  if (impatience > 0) {
    for (const family of SIGNAL_PROFILE_TUNING.longRideFamilies) {
      familyCosts[family] +=
        impatience * SIGNAL_PROFILE_TUNING.longRideCostAtFullImpatience;
    }
  }
  for (const [family, charge] of signals.familyCharges(atMs)) {
    if (family in familyCosts) {
      const key = family as keyof DecisionProfile["familyCosts"];
      familyCosts[key] = Math.max(
        0,
        familyCosts[key] + charge * SIGNAL_PROFILE_TUNING.familyChargeToCost,
      );
    }
  }
  return { ...base, familyCosts };
}

/** One pair, as the brain sees it at decision time. */
export interface BrainPairInput {
  outgoing: PreparedTrack;
  outgoingPositionSec: number;
  incoming: PreparedTrack;
}

/** A decision the brain stands behind: perform this recipe. */
export interface BrainDecision {
  recipe: TransitionRecipe;
  candidate: Candidate;
  scored: ScoredCandidate;
  /**
   * How the performed candidate was chosen from the scored band
   * (R5): the §16/§15 selection record — temperature, seed
   * coordinate, every band member's probability, and whether the
   * sample agreed with scoring's deterministic pick.
   */
  selection: SelectionRecord;
  /** The derived profile the decision was authored and scored with. */
  profile: DecisionProfile;
  arcPosition: number;
  /** The arc target energy actually spent on this decision. */
  arcTargetEnergy: number;
  consideredAtMs: number;
}

/** What the decks actually did with a decision, reported back. */
export interface PerformedJoin {
  /** Seconds of the outgoing the room actually heard before the join. */
  heardLengthSec: number;
}

export interface DjBrainOptions {
  /** Base temperament; STANDARD unless the session says otherwise. */
  profile?: DecisionProfile;
  /** Join history log; the app-wide singleton unless injected. */
  history?: JoinHistoryLog;
  /** The night's arc shape; "classic" unless chosen otherwise. */
  arcShape?: ArcShapeName;
  /**
   * The seed the selection lottery's coordinates hang from (R5).
   * A fixed default keeps a replayed call sequence reproducible;
   * a caller wanting per-occasion streams of its own injects one.
   */
  sessionSeed?: string;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** The default selection seed: a brain replays its picks exactly. */
export const DEFAULT_SESSION_SEED = "linerave";

export class DjBrain {
  readonly signals: SignalBank;
  private baseProfile: DecisionProfile;
  private readonly history: JoinHistoryLog;
  private arcShapeName: ArcShapeName;
  private readonly now: () => number;
  private readonly sessionSeed: string;
  /** Sets begun on this brain (the seed's set coordinate). */
  private setIndex = 0;
  /** Selections made in the current set (the decision coordinate). */
  private decisionIndex = 0;

  constructor(options: DjBrainOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.signals = new SignalBank(this.now);
    this.baseProfile = options.profile ?? STANDARD_PROFILE;
    this.history = options.history ?? joinHistory;
    this.arcShapeName = options.arcShape ?? "classic";
    this.sessionSeed = options.sessionSeed ?? DEFAULT_SESSION_SEED;
  }

  /** A new set: history loaded, yesterday's signals gone. */
  async beginSet(): Promise<void> {
    await this.history.load();
    this.signals.clear();
    // A new set is a new seed coordinate: the same playlist on a
    // later set of the same session draws a different stream.
    this.setIndex += 1;
    this.decisionIndex = 0;
  }

  get profile(): DecisionProfile {
    return this.baseProfile;
  }

  setProfile(profile: DecisionProfile): void {
    this.baseProfile = profile;
  }

  get arcShape(): ArcShapeName {
    return this.arcShapeName;
  }

  setArcShape(shape: ArcShapeName): void {
    this.arcShapeName = shape;
  }

  /** The profile decisions are made with right now, signals included. */
  effectiveProfile(atMs?: number): DecisionProfile {
    return deriveProfile(this.baseProfile, this.signals, atMs ?? this.now());
  }

  /**
   * The energy the set wants the next entry to land at: the night's
   * arc shape at this position, leaned on by the room's bias.
   */
  arcTargetAt(position: number, atMs?: number): number {
    const at = atMs ?? this.now();
    return clamp(
      arcTarget(position, this.arcShapeName) + this.signals.arcBias(at),
      0.05,
      0.98,
    );
  }

  /** The joins this brain remembers (oldest first). */
  historySnapshot(): readonly JoinRecord[] {
    return this.history.all();
  }

  /**
   * Decide the join for one pair. Returns null when nothing may be
   * performed — no candidate survived authoring, or scoring vetoed
   * them all — and the caller falls back to its floor (a plain cut),
   * announced as such. Reads only the pair's prepared analyses; the
   * whole-queue tail is never touched here.
   */
  consider(input: BrainPairInput, arcPosition: number): BrainDecision | null {
    const atMs = this.now();
    const profile = this.effectiveProfile(atMs);
    const arcTargetEnergy = this.arcTargetAt(arcPosition, atMs);
    const candidates = candidatesForPair(
      {
        outgoing: input.outgoing.analysis,
        outgoingPositionSec: input.outgoingPositionSec,
        incoming: input.incoming.analysis,
      },
      { profiles: [profile] },
    );
    if (candidates.length === 0) return null;
    const scored = scoreCandidates(
      candidates,
      {
        history: this.history.all(),
        arcPosition,
        arcTargetEnergy,
      },
      profile,
    );
    if (!scored.pick) return null;
    // R5: the performed candidate is SAMPLED from the near-equal
    // band (blueprint §16 softmax, §15-shaped), not taken from
    // scoring's deterministic pick — that pick is kept in the
    // record as the reference the sample is audited against. The
    // draw's stream is a pure function of the session coordinates
    // (seed, set, decision), so a replayed session reproduces its
    // picks exactly and a different set draws differently.
    this.decisionIndex += 1;
    const seed = decisionSeed(
      this.sessionSeed,
      this.setIndex,
      this.decisionIndex,
    );
    const { chosen, record } = selectFromBand(scored.band, {
      profile,
      history: this.history.all(),
      random: randomForDecision(
        this.sessionSeed,
        this.setIndex,
        this.decisionIndex,
      ),
      seed,
      scorerPick: scored.pick,
    });
    return {
      recipe: chosen.candidate.recipe,
      candidate: chosen.candidate,
      scored: chosen,
      selection: record,
      profile,
      arcPosition,
      arcTargetEnergy,
      consideredAtMs: atMs,
    };
  }

  /**
   * Remember a performed join. Called by the session once the decks
   * have actually done it (or, for an interrupted blend, once the
   * room has heard what it heard) — history records performances,
   * never intentions, because anti-repetition must charge what the
   * room experienced.
   */
  recordPerformed(decision: BrainDecision, performed: PerformedJoin): void {
    const evidence = decision.candidate.evidence;
    void this.history.record({
      aAudioHash: decision.recipe.fingerprints.aAudioHash,
      bAudioHash: decision.recipe.fingerprints.bAudioHash,
      family: decision.candidate.family,
      profileId: decision.profile.id,
      pairShape: decision.candidate.evidence.pairShape,
      blendBeats: evidence.blendBeats,
      stretch: evidence.stretch,
      heardLengthSec: performed.heardLengthSec,
      at: this.now(),
    });
  }
}
