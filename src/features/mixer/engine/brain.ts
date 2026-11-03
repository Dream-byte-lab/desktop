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

import {
  authorManualScratch,
  authorManualStopExit,
  candidatesForPair,
  deriveCandidateEvidence,
  familyOfRecipe,
  isManualStopMove,
  type Candidate,
  type ManualDeckMove,
} from "./candidates";
import { scoreCandidates, type ScoredCandidate } from "./scoring";
import {
  countRecentFamilyUsesWeighted,
  decisionSeed,
  randomForDecision,
  recentUseSensitivity,
  selectFromBand,
  selectTrackCandidate,
  temperatureForProfile,
  type SelectionRecord,
} from "./selection";
import { STANDARD_PROFILE, type DecisionProfile } from "./decisionProfile";
import {
  joinHistory,
  pairShapeOf,
  type JoinEvaluation,
  type JoinHistoryLog,
  type JoinRecord,
} from "./joinHistory";
import { SignalBank } from "./signals";
import {
  arcTarget,
  NEAR_EQUAL_EPSILON,
  SHARED_LABEL_CREDIT,
  type ArcShapeName,
} from "./curatedSet";
import {
  minimumPlayEndSec,
  trackFitScore,
  type TrackFacts,
} from "./playlistIntel";
import { validateRecipe, type TransitionRecipe } from "./recipe";
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
  /**
   * The performance outcome (§28, R6): supplied by the session,
   * which alone knows whether the join completed or was cut
   * short and how the levels met. When present, the performed
   * record carries a §28 evaluation; when absent (callers that
   * only report the join itself), the record stays exactly as
   * it was before R6 — unevaluated, and therefore neutral in
   * the §15 feedback weighting.
   */
  outcome?: {
    /** The join was interrupted before its blend completed. */
    interrupted: boolean;
    /** 0..1 — level continuity across the join, as performed. */
    loudnessContinuity?: number;
  };
}

/** Families whose loudness step is the point of the move. */
const CUT_FAMILIES: ReadonlySet<string> = new Set(["drop-cut", "early-cut"]);

/**
 * Blueprint §28's transition evaluation: after a transition is
 * performed, score how it actually went — beat alignment,
 * loudness continuity, harmonic/structural compatibility,
 * execution reliability — judged RELATIVE TO THE ACTIVE
 * PERSONALITY'S INTENT as expressed by the family it chose: a
 * cut family spends a loudness step on purpose, so continuity
 * is weighed lightly for cuts and the landing (beat alignment,
 * harmonic fit) carries the grade; a blend is graded on the
 * continuity it promised. Pure: everything reads from the
 * decision's own evidence and the reported outcome.
 */
export function evaluatePerformedJoin(
  decision: BrainDecision,
  performed: PerformedJoin,
): JoinEvaluation {
  const e = decision.candidate.evidence;
  const component = (name: string): number =>
    decision.scored.components.find((c) => c.name === name)?.value ?? 0.5;

  let beatAlignment: number;
  if (e.beatmatched) {
    // A beatmatched join is judged on the grid it trusted.
    beatAlignment = clamp(e.gridConfidence ?? e.tempoConfidence, 0, 1);
  } else {
    // A cut or cold start is judged on where it landed.
    beatAlignment =
      e.entryKind === "drop"
        ? 0.9
        : e.entryKind === "section"
          ? 0.85
          : e.entryKind === "intro-end"
            ? 0.75
            : e.entryKind === "track-start"
              ? 0.6
              : 0.5;
  }
  const loudnessContinuity = clamp(
    performed.outcome?.loudnessContinuity ?? 0.5,
    0,
    1,
  );
  const harmonicStructural = clamp(
    (component("keyFit") + component("structureFit")) / 2,
    0,
    1,
  );
  const executionReliability = performed.outcome?.interrupted ? 0.35 : 1;

  const cut = CUT_FAMILIES.has(decision.candidate.family);
  const weights = cut
    ? { beat: 0.4, loudness: 0.1, harmonic: 0.35, execution: 0.15 }
    : { beat: 0.3, loudness: 0.25, harmonic: 0.3, execution: 0.15 };
  const overall = clamp(
    weights.beat * beatAlignment +
      weights.loudness * loudnessContinuity +
      weights.harmonic * harmonicStructural +
      weights.execution * executionReliability,
    0,
    1,
  );
  return {
    beatAlignment,
    loudnessContinuity,
    harmonicStructural,
    executionReliability,
    overall,
  };
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
    // The minimum-play floor (Note 19, ruling 1), spent as an
    // ANCHOR VETO: a started song is owed through its first big
    // section before the DJ may move on — and moving on is the
    // join's ANCHOR, the moment the overlap begins. Planning is
    // not moving on: the brain authors and revises decisions
    // from the moment the planning window opens, exactly as a
    // DJ plans an exit during the chorus — but no candidate
    // whose anchor lands before the floor is eligible, so the
    // performed join can never start inside the owed length.
    // let-it-play anchors at the natural end and always stands.
    // With no usable section data the floor abstains (no veto).
    const floorSec = minimumPlayEndSec(input.outgoing.analysis);
    const eligible =
      floorSec === null
        ? candidates
        : candidates.filter(
            (candidate) =>
              candidate.recipe.overlap.startAMs === null ||
              candidate.recipe.overlap.startAMs >= floorSec * 1000,
          );
    if (eligible.length === 0) return null;
    const scored = scoreCandidates(
      eligible,
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
   * Author a join for the HOST's hand (the DJ stage engine
   * seams): one of the R1 stop moves or R2 scratches, triggered
   * deliberately from the stage at the outgoing's current
   * position. This is not consider(): there is no candidate set,
   * no minimum-play veto (the floor binds the DJ, never the
   * host), and no lottery — the host named the move, so the move
   * is authored, scored for the record, and returned as the
   * decision. The manual authors keep their structural and
   * material gates (a landing to hand to, a spinback's runway, a
   * scratch window that is witnessed, low-vocal and
   * transient-rich), and validateRecipe has the last word; when
   * any of them refuses, this returns null and the session's
   * standing decision — if any — is untouched.
   *
   * The selection record says what happened, honestly: method
   * "manual", the single candidate at probability 1, the profile's
   * temperature and sensitivity as standing context, and the seed
   * of the CURRENT lottery coordinate — named, not consumed: the
   * decision index is not advanced, so the brain's next own draw
   * samples the stream exactly as if the host had never acted.
   * The performed join still lands in history through
   * recordPerformed, like any other: anti-repetition charges what
   * the room heard, whoever called for it.
   */
  authorManualMove(
    input: BrainPairInput,
    arcPosition: number,
    move: ManualDeckMove,
  ): BrainDecision | null {
    const atMs = this.now();
    const profile = this.effectiveProfile(atMs);
    const arcTargetEnergy = this.arcTargetAt(arcPosition, atMs);
    const request = {
      outgoing: input.outgoing.analysis,
      outgoingPositionSec: input.outgoingPositionSec,
      incoming: input.incoming.analysis,
    };
    const recipe = isManualStopMove(move)
      ? authorManualStopExit(request, profile, move)
      : authorManualScratch(request, profile, move);
    if (!recipe) return null;
    if (validateRecipe(recipe).length > 0) return null;
    const candidate: Candidate = {
      recipe,
      family: familyOfRecipe(recipe),
      profileId: profile.id,
      origin: "manual-trigger",
      evidence: deriveCandidateEvidence(
        input.outgoing.analysis,
        input.incoming.analysis,
        recipe,
        pairShapeOf(input.outgoing.analysis, input.incoming.analysis),
      ),
    };
    const scored = scoreCandidates(
      [candidate],
      {
        history: this.history.all(),
        arcPosition,
        arcTargetEnergy,
      },
      profile,
    );
    const chosen = scored.ranked[0];
    if (!chosen) return null;
    const record: SelectionRecord = {
      method: "manual",
      seed: decisionSeed(this.sessionSeed, this.setIndex, this.decisionIndex),
      temperature: temperatureForProfile(profile),
      sensitivity: recentUseSensitivity(profile),
      band: [
        {
          family: candidate.family,
          score: chosen.score,
          historyCost: chosen.historyCost,
          recentUses: countRecentFamilyUsesWeighted(
            this.history.all(),
            candidate.family,
            profile.antiRepetition.windowJoins,
          ),
          // No draw was made, so no lottery penalty was applied;
          // the candidate's repetition standing is carried by
          // historyCost and recentUses above.
          penalty: 0,
          probability: 1,
        },
      ],
      restraintHeld: [],
      chosenIndex: 0,
      agreedWithScorer: true,
    };
    return {
      recipe,
      candidate,
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
   * room experienced. When the caller reports the performance
   * outcome, the record also carries §28's evaluation of the join
   * (R6); that evaluation is what later selections are shaped by.
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
      ...(performed.outcome
        ? { evaluation: evaluatePerformedJoin(decision, performed) }
        : {}),
    });
  }

  /**
   * Choose the next TRACK (R6 — playlist-bounded autonomy,
   * Addendum A): which of the active playlist's remaining tracks
   * the set plays next, from the field the session supplies (the
   * known prefix of the remaining tail, in standing order — the
   * session owns the queue and the field's construction; the
   * brain owns the judgement). The field's first entry is the
   * standing order's holder and carries the incumbency head
   * start; every entry is scored by playlist intelligence
   * (§14.1's weights spent on track evidence, the arc's target
   * at the slot the winner would occupy — the ruled hybrid:
   * set-level arc steering, pair-level execution), then R5's
   * entry point spends the lottery: epsilon band (R4's resolved
   * nearEqualEpsilon; the track-selection-freedom per-join half),
   * incumbency (R4's resolved penalty), temperature from the
   * effective profile's band, §15 shaping from how often each
   * track was recently joined INTO. The draw takes the next
   * coordinate of the same session stream the join lottery
   * draws from, so a night replays exactly and occasions
   * diverge. Returns null when the field holds fewer than two
   * candidates — with one candidate there is no choice to make
   * and the standing order simply stands.
   */
  chooseNextTrack(input: {
    /** The playing track's facts; null when choosing an opener. */
    current: TrackFacts | null;
    /** Scoreable candidates in standing order; [0] is the incumbent. */
    field: readonly { trackId: string; facts: TrackFacts }[];
    /** Where the winner would sit in the set, 0..1. */
    arcPosition: number;
    /** R4's resolved curation bends; absent = the shipped constants. */
    curation?: {
      nearEqualEpsilon: number;
      incumbencyPenalty: number;
      sharedLabelCredit: number;
    };
  }): TrackChoice | null {
    if (input.field.length < 2) return null;
    const profile = this.effectiveProfile();
    const arcTargetEnergy = this.arcTargetAt(input.arcPosition);
    const curation = input.curation ?? {
      nearEqualEpsilon: NEAR_EQUAL_EPSILON,
      incumbencyPenalty: 0.1,
      sharedLabelCredit: SHARED_LABEL_CREDIT,
    };
    const history = this.history.all();
    const window =
      profile.antiRepetition.windowJoins > 0
        ? history.slice(-profile.antiRepetition.windowJoins)
        : [];
    const recentPlays = (facts: TrackFacts): number =>
      facts.audioHash === null
        ? 0
        : window.reduce(
            (n, record) => (record.bAudioHash === facts.audioHash ? n + 1 : n),
            0,
          );
    const entries = input.field.map((entry, index) => ({
      item: entry,
      score: trackFitScore(input.current, entry.facts, {
        arcTargetEnergy,
        sharedLabelCredit: curation.sharedLabelCredit,
      }).score,
      recentUses: recentPlays(entry.facts),
      incumbent: index === 0,
    }));
    // One coordinate per selection, shared with the join lottery:
    // the stream is a function of how many selections preceded.
    this.decisionIndex += 1;
    const selection = selectTrackCandidate(entries, {
      epsilon: curation.nearEqualEpsilon,
      incumbencyPenalty: curation.incumbencyPenalty,
      temperature: temperatureForProfile(profile),
      sensitivity: recentUseSensitivity(profile),
      random: randomForDecision(
        this.sessionSeed,
        this.setIndex,
        this.decisionIndex,
      ),
    });
    if (!selection) return null;
    return {
      trackId: selection.entry.item.trackId,
      record: {
        seed: decisionSeed(this.sessionSeed, this.setIndex, this.decisionIndex),
        temperature: selection.temperature,
        sensitivity: recentUseSensitivity(profile),
        bandSize: selection.bandSize,
        chosenIndex: selection.index,
        field: input.field.map((entry, index) => ({
          trackId: entry.trackId,
          score: entries[index].score,
          recentPlays: entries[index].recentUses ?? 0,
          probability: selection.probabilities[index],
        })),
      },
    };
  }
}

/** One candidate in a track choice, as the brain scored it. */
export interface TrackChoiceFieldRecord {
  trackId: string;
  score: number;
  /** Joins into this track inside the anti-repetition window. */
  recentPlays: number;
  /** The probability the lottery gave this candidate. */
  probability: number;
}

/** The auditable record of one track choice (R6). */
export interface TrackChoiceRecord {
  seed: string;
  temperature: number;
  sensitivity: number;
  bandSize: number;
  chosenIndex: number;
  field: TrackChoiceFieldRecord[];
}

/** A track choice the brain stands behind. */
export interface TrackChoice {
  trackId: string;
  record: TrackChoiceRecord;
}
