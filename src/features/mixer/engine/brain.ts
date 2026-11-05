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
  authorJuggle,
  authorManualJuggle,
  authorManualScratch,
  authorManualStopExit,
  candidatesForPair,
  deriveCandidateEvidence,
  familyOfRecipe,
  isManualStopMove,
  type AuthoredJuggle,
  type Candidate,
  type ManualDeckMove,
} from "./candidates";
import { scoreCandidates, type ScoredCandidate } from "./scoring";
import {
  chooseBySoftmax,
  countRecentFamilyUsesWeighted,
  decisionSeed,
  NO_TRANSITION_FAMILY,
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
  repetitionCost,
  type JoinEvaluation,
  type JoinHistoryLog,
  type JoinRecord,
} from "./joinHistory";
import type { JugglePerformance } from "./juggle";
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

/** A juggle consideration, as the brain sees it at spend time. */
export interface JuggleConsiderInput {
  /** The track playing now — both of the act's copies are of it. */
  current: PreparedTrack;
  /** The playhead, in track seconds. */
  positionSec: number;
  /** Where the set sits on its arc, 0..1 (arcFit's coordinate). */
  arcPosition: number;
  /**
   * Party mode with guest requests waiting: the parent ruling is
   * that no autonomous juggle is authored while the room's
   * requests are pending. The manual trigger is not bound by it.
   */
  partyRequestsPending: boolean;
}

/** A spent juggle consideration: the verdict and its audit trail. */
export interface JuggleSpend {
  outcome: "juggle" | "restraint";
  /** The authored act, whichever way the spend fell. */
  authored: AuthoredJuggle;
  /** The [juggle, restraint] spend's §16/§15 selection record. */
  selection: SelectionRecord;
  /** The derived profile the spend was authored and scored with. */
  profile: DecisionProfile;
  /** The arc target energy actually spent on this consideration. */
  arcTargetEnergy: number;
  consideredAtMs: number;
}

/** Total beats across a juggle performance (the history probe's geometry). */
function juggleTotalBeats(performance: JugglePerformance): number {
  return performance.segments.reduce((sum, s) => sum + s.beats, 0);
}

/**
 * A juggle window's wall-clock length, in seconds: a repeat hears
 * its segment span once per segment; a continue hears the walk.
 */
function juggleWindowSec(performance: JugglePerformance): number {
  return performance.pattern === "repeat"
    ? performance.segments.length *
        (performance.exitSec - performance.breakStartSec)
    : performance.exitSec - performance.breakStartSec;
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
  /**
   * The juggle window most recently spent (track + break), so a
   * standing break is spent exactly once — a restraint verdict is
   * a verdict, never re-rolled while the same break stands ahead.
   * Cleared when a new track instance begins (the session's
   * resetJuggleWindow call) and at each new set.
   */
  private lastJuggleWindowKey: string | null = null;

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
    this.lastJuggleWindowKey = null;
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
    // Without usable section data the floor is derived from the
    // track's own proportions (Note 33); it abstains only when
    // the track's length itself is unknown.
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
   * A new track instance begins: the spent-juggle window belongs
   * to the play that spent it, so the same break on a later play
   * of the same track is a new window, spendable again.
   */
  resetJuggleWindow(): void {
    this.lastJuggleWindowKey = null;
  }

  /**
   * Consider a beat juggle on the CURRENT track (the
   * crab-and-juggling plan's admission spend): not a join — there
   * is no pair, no incoming, nothing to hand over to. The question
   * is of a moment: does the brain cut this track's break between
   * its two copies here, or let the track play? The spend is the
   * [juggle, restraint] band, spent with R5's own lottery —
   * chooseBySoftmax at the profile's temperature, §15-shaped by
   * both families' recent uses, drawn from the same seeded stream
   * at the next decision coordinate, and audited by a
   * SelectionRecord in selectFromBand's exact shape. (It is not
   * routed through selectFromBand itself for one honest reason:
   * that function's band is made of join Candidates, and a
   * Candidate carries a recipe — a juggle has none, and inventing
   * one to satisfy the type would put a performable-looking lie
   * in the record. The lottery, the shaping, the seed discipline
   * and the audit shape are R5's; only the envelope differs.)
   * Restraint stands IN this lottery, not held out of it — with
   * no rival joins in the band, holding it out would make the
   * spend a formality, and the plan's construction is that
   * restraint wins most bands on its score.
   *
   * The scores are scoring.ts's arithmetic, mirrored: weighed
   * evidence (the author's JuggleEvidence, arcFit against the
   * night's target) less the family cost less the repetition
   * charge. The juggle's repetition probe pairs the track with
   * itself — the same self-pair its history record will carry —
   * so a juggle of this track charges a later one at the
   * same-pair rate, as §15 intends. Restraint's weighed evidence
   * is the engine's neutral 0.5 on every term (the weights sum to
   * 1): it has no pair, so no pair evidence exists to weigh, and
   * no pair-repetition charge can honestly be computed for it —
   * its §15 pressure enters through recentUses in the lottery,
   * exactly where selectFromBand applies it.
   *
   * The party ruling binds first, before anything is authored:
   * while guest requests are pending the brain authors no juggle
   * at all, and the window is not consumed — if the requests
   * clear while the break is still ahead, the spend may still
   * happen. One spend per window: once a break has been spent
   * (either verdict), the same break never re-rolls.
   */
  considerJuggle(input: JuggleConsiderInput): JuggleSpend | null {
    if (input.partyRequestsPending) return null;
    const atMs = this.now();
    const profile = this.effectiveProfile(atMs);
    const authored = authorJuggle(
      input.current.analysis,
      profile,
      input.positionSec,
    );
    if (!authored) return null;
    const windowKey = `${input.current.track.id}@${authored.performance.breakStartSec}`;
    if (windowKey === this.lastJuggleWindowKey) return null;
    this.lastJuggleWindowKey = windowKey;

    const arcTargetEnergy = this.arcTargetAt(input.arcPosition, atMs);
    const history = this.history.all();
    const e = authored.evidence;
    const w = profile.weights;
    const arcFit =
      e.entryEnergy === null
        ? 0.5
        : clamp(1 - Math.abs(e.entryEnergy - arcTargetEnergy), 0, 1);
    const weighed =
      w.keyFit * e.keyFit +
      w.vocalClarity * e.vocalClarity +
      w.stretchFit * e.stretchFit +
      w.structureFit * e.structureFit +
      w.loopValue * e.loopValue +
      w.arcFit * arcFit;
    const analysis = input.current.analysis;
    const historyCost = repetitionCost(
      history,
      {
        family: "juggle",
        pairShape: pairShapeOf(analysis, analysis),
        blendBeats: juggleTotalBeats(authored.performance),
        heardLengthSec: juggleWindowSec(authored.performance),
        aAudioHash: analysis.audioHash ?? null,
        bAudioHash: analysis.audioHash ?? null,
      },
      profile,
    ).cost;
    const juggleScore = weighed - profile.familyCosts.juggle - historyCost;
    const restraintScore = 0.5 - profile.familyCosts[NO_TRANSITION_FAMILY];

    this.decisionIndex += 1;
    const seed = decisionSeed(
      this.sessionSeed,
      this.setIndex,
      this.decisionIndex,
    );
    const temperature = temperatureForProfile(profile);
    const sensitivity = recentUseSensitivity(profile);
    const entries = [
      {
        score: juggleScore,
        recentUses: countRecentFamilyUsesWeighted(
          history,
          "juggle",
          profile.antiRepetition.windowJoins,
        ),
      },
      {
        score: restraintScore,
        recentUses: countRecentFamilyUsesWeighted(
          history,
          NO_TRANSITION_FAMILY,
          profile.antiRepetition.windowJoins,
        ),
      },
    ];
    const outcome = chooseBySoftmax(entries, {
      temperature,
      sensitivity,
      random: randomForDecision(
        this.sessionSeed,
        this.setIndex,
        this.decisionIndex,
      ),
    });
    const chosenIndex = Math.max(0, outcome.index);
    const record: SelectionRecord = {
      method: "softmax",
      seed,
      temperature,
      sensitivity,
      band: [
        {
          family: "juggle",
          score: juggleScore,
          historyCost,
          recentUses: entries[0].recentUses,
          penalty: outcome.penalties[0],
          probability: outcome.probabilities[0],
        },
        {
          family: NO_TRANSITION_FAMILY,
          score: restraintScore,
          historyCost: 0,
          recentUses: entries[1].recentUses,
          penalty: outcome.penalties[1],
          probability: outcome.probabilities[1],
        },
      ],
      // Restraint stood IN this lottery (see the method's note):
      // nothing was held out of the pool.
      restraintHeld: [],
      chosenIndex,
      agreedWithScorer: (chosenIndex === 0) === juggleScore >= restraintScore,
    };
    return {
      outcome: chosenIndex === 0 ? "juggle" : "restraint",
      authored,
      selection: record,
      profile,
      arcTargetEnergy,
      consideredAtMs: atMs,
    };
  }

  /**
   * Author a juggle for the HOST's hand (the stage's Juggle
   * control): no price gate, no lottery, no window consumed — the
   * host named the act, so the act is authored if the track
   * honestly offers it (authorManualJuggle keeps every material
   * and structural gate), exactly as authorManualMove stands
   * behind the manual deck moves. The performed act still lands
   * in history through recordPerformedJuggle: anti-repetition
   * charges what the room heard, whoever called for it.
   */
  authorManualJuggleMove(input: {
    current: PreparedTrack;
    positionSec: number;
  }): { performance: JugglePerformance; profile: DecisionProfile } | null {
    const profile = this.effectiveProfile();
    const authored = authorManualJuggle(
      input.current.analysis,
      profile,
      input.positionSec,
    );
    if (!authored) return null;
    return { performance: authored.performance, profile };
  }

  /**
   * Remember a performed juggle. The record pairs the track with
   * ITSELF (aAudioHash = bAudioHash): the act's two copies are one
   * track, and the self-pair is what makes a repeat juggle of the
   * same track draw repetitionCost's same-pair charge later — the
   * §15 doctrine working as written, bending the odds without
   * ever zeroing them. Blueprint §28 ABSTAINS here (the decided
   * ruling): the evaluation's terms are a join's — beat alignment
   * across a handover, loudness continuity across a blend — and a
   * juggle has no handover to grade, so no outcome is reported
   * and the record carries no evaluation, counting at exactly
   * weight 1 in the §15 feedback weighting like every
   * unevaluated record.
   */
  recordPerformedJuggle(input: {
    current: PreparedTrack;
    performance: JugglePerformance;
    profile: DecisionProfile;
  }): void {
    const analysis = input.current.analysis;
    void this.history.record({
      aAudioHash: analysis.audioHash ?? null,
      bAudioHash: analysis.audioHash ?? null,
      family: "juggle",
      profileId: input.profile.id,
      pairShape: pairShapeOf(analysis, analysis),
      blendBeats: juggleTotalBeats(input.performance),
      stretch: 0,
      heardLengthSec: juggleWindowSec(input.performance),
      at: this.now(),
    });
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
