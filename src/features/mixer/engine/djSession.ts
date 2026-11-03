import type { Track } from "@/shared/types";
import { showToast } from "@/shared/ui/Toast";
import { labelsForTrack } from "../../genres/trackGenres";
import { usePlayerStore } from "../../player/store/playerStore";
import { usePartyStore } from "../store/partyStore";
import { DjBrain, type BrainDecision, type TrackChoice } from "./brain";
import { beatsAtTime, timeAtBeat } from "./beatMap";
import type { ManualDeckMove } from "./candidates";
import {
  assembleSet,
  candidateFromAnalysis,
  chooseArcShape,
} from "./curatedSet";
import { levelGainFor } from "./levelMatch";
import {
  buildPlaylistIntel,
  buyTimeLoopSpan,
  type PlaylistIntel,
  type TrackFacts,
} from "./playlistIntel";
import type { ResolvedDecisionSettings } from "./personality";
import type { RaveDecision, RaveRequest, RaveTrackInfo } from "./liveRave";
import { LiveRaveQueue, type RaveQueueEntry } from "./liveRaveQueue";
import {
  automationValueAt,
  recipeFromPlan,
  type TransitionRecipe,
} from "./recipe";
import { recordListen } from "./tasteTracker";
import {
  loadStretchRendition,
  loadTrackForMixing,
  preparedTrack,
  stretchRendition,
  type PreparedTrack,
} from "./trackSource";
import type { TransitionPlan } from "./transitionPlanner";
import { TwoDeckMixer, type DeckIndex } from "./twoDeckMixer";
import {
  createAnalyserTap,
  registerVisualizerTap,
  VISUALIZER_TAP_ID,
  VISUALIZER_TAP_PRIORITY,
} from "@/features/greeting/lib/visualizerSource";
import {
  STAGE_EFFECT_KINDS,
  type DjControlLevel,
  type StageCrossfaderCurve,
  type StageCurrentMove,
  type StageEffectKind,
  type StageFxAssign,
  type StageSnapshot,
} from "../ui/stage/stageSnapshot";

// The DJ session, v2: a whole queue played on the two decks, mixed
// by the brain (brain.ts). It is a guest in Liner's house, and
// behaves like one:
//
// - the normal player is paused through its own command channel
//   before the session makes any sound;
// - everything the interface shows — current track, queue, position,
//   duration, playing/paused — is written into the player's own
//   store through its public setters, so the existing UI follows;
// - tracks are prepared (downloaded, decoded, analysed) on a
//   TWO-TRACK horizon — the playing track and the two after it,
//   prepared concurrently — walking past any that cannot be
//   prepared at all. A track that decodes but cannot be analysed
//   in time is still prepared, as a playable shell: it is played
//   plainly, never blended, and counts through the fallback
//   accounting (Note 20). The whole queue tail is never prepared
//   by the decision loop (v1 did, per evaluation poll); tonight's
//   facts are read from the analysis cache instead;
// - every preparation the session awaits carries a deadline: a
//   stalled download, decode or analysis is a failure RESULT within
//   the deadline, never a promise that pends forever (guarantee 2);
// - a failed track is marked, not branded: the mark expires and the
//   track may be retried later in the same session (guarantee 5);
// - at each join the brain considers the pair — cached v2 analyses,
//   candidates authored and scored with arc position, join history
//   and live signals — and the winning recipe is performed through
//   the executor. The decision is revised every tick until it
//   commits; once performed, the join is locked (nothing re-plans
//   it) and its completion is owned by exactly one callback
//   (guarantee 6);
// - a winning recipe that calls for a pitch-preserved rendition
//   (overlap.stretchB) starts that render at decision time, in
//   preparation's rendition cache; the commit performs the
//   rendition buffer or not at all — a rendition that is not ready
//   when the anchor passes leaves the join to the fallback floor,
//   never to a mismatched buffer;
// - the fallback floor still stands: a pair with no performable
//   recipe, or a track end reached with nothing mix-ready, falls
//   back to a plain cut instead of stalling the session — but the
//   floor now ANNOUNCES itself: fallback cuts are counted, crossing
//   the stated threshold raises the session's public degraded state
//   and says so on the toast surface, and every session end carries
//   an enumerated reason (guarantees 3 and 7);
// - the Step 2 contracts stand verbatim in behaviour: a user's
//   explicit hand-pick beats the brain (the command router stops
//   this session; nothing restarts it over a deliberate stop — the
//   DJ intent wiring in store/djIntentWiring.ts arms its
//   auto-resume ONLY on queue-exhausted / start-no-playable ends,
//   never on user-stop), unready tracks are immune (preparation
//   walks past them), the party's lifecycle is supreme (it lives
//   and dies with this session's running state), and an auth flip
//   never wipes playback (nothing here reads auth).
// R6 (playlist-bounded autonomy) adds, inside the same contracts:
//
// - the next track is CHOSEN, not merely walked to: at each
//   landing the brain weighs the known prefix of the remaining
//   playlist (playlist intelligence, built progressively from
//   the analysis cache) and may move its pick to the front of
//   the tail; the horizon machinery then prepares and performs
//   exactly as before. The set's opener is chosen the same way
//   when the cache already knows the playlist's head. A
//   deliberate ordering act — curation, request scheduling — is
//   the choice for its landing and is never re-rolled;
// - §3's double validation: a candidate is validated when it is
//   chosen (it must stand in the active playlist, preparable,
//   unblocked) and again immediately before the decks are told
//   to load it (commit, the floor's promotion, the end-of-track
//   cut) — a track that stopped qualifying in between is evicted
//   and the choice re-runs, never a dead deck;
// - §34's resume-inspection: any manual intervention (a seek, a
//   skip, a stage grab, a pause/resume) flags the session, and
//   the next tick inspects the ACTUAL deck/queue state — horizon
//   slots, the standing decision's pair — and repairs or cancels
//   what no longer matches before anything is planned (§22's
//   priority/cancellation, spent at the seam where it bites);
// - the minimum-play floor (Note 19, ruling 1): no autonomous
//   join may START before the current song's first big section
//   has played — enforced as an anchor veto in the brain (the
//   join's overlap may not begin inside the owed length), while
//   planning and revision run freely ahead of it. The floor
//   binds the DJ only — every manual transport acts instantly,
//   as always;
// - the buy-time loop (Note 19, ruling 2): when a join is not
//   ready at the track's end (its rendition still rendering, or
//   the next track still preparing) the current song's tail
//   loops on its beat grid to buy the preparation its time —
//   bounded wraps, bounded seconds — before the standing floor
//   applies, unchanged;
// - §28's evaluations: every performed join is scored after the
//   fact and written into join history, where it shapes later
//   selections (§15's currency, never an exclusion).
//
// Positions are tracked as rate segments against the audio clock, so
// pausing (which freezes the clock) freezes the position for free.

interface RateSegment {
  fromCtxTime: number;
  trackTimeAtStart: number;
  rate: number;
}

const TICK_MS = 250;
/** Consider joins once the current track has less than this left. */
const PLAN_WHEN_REMAINING_SEC = 150;
/**
 * Guarantee 2's deadline: no preparation the session awaits may pend
 * longer than this. It is a safety bound, not a performance target —
 * healthy preparation lands far inside it.
 */
export const PREPARATION_DEADLINE_MS = 45_000;
/** How long a preparation failure is remembered before a retry. */
export const FAILURE_MARK_TTL_MS = 30_000;
/**
 * Failure marks back off, they never bury (Note 20): a mark blocks
 * its track for FAILURE_MARK_TTL_MS × attempts, capped here — a
 * flaky patch of a night cannot permanently erase a song from a
 * session, however many times it has failed.
 */
export const FAILURE_BACKOFF_CAP_MS = 300_000;
/** Fallback plain cuts beyond this count degrade the session, announced. */
export const PLAIN_CUT_ANNOUNCE_THRESHOLD = 3;
/**
 * The buy-time loop's hard bound (Note 19, ruling 2): at most this
 * many wraps of the current track's tail, and at most this many
 * bought seconds in total, per track landing — after which the
 * loop lets go and the standing plain-cut floor applies exactly
 * as it always has. The loop buys time for preparations already
 * in flight; it never extends the 45-second preparation deadline
 * and never loops without a grid-true span to loop on.
 */
export const MAX_BUY_TIME_LOOPS = 3;
export const MAX_BUY_TIME_SEC = 30;

/**
 * The tempo bias envelope (the DJ stage engine seams): a bias is
 * a planner-belief correction, and a belief outside every
 * profile's rendition reach could only author joins no profile
 * may perform — so the bias clamps to the widest stretch envelope
 * the engine ships (the adventurous profile's +15% / −9%).
 */
export const TEMPO_BIAS_MIN = 0.91;
export const TEMPO_BIAS_MAX = 1.15;

/**
 * The manual roll's slice envelope, in beats: recipe validation's
 * own roll range. A hand-opened roll circulates in the same
 * network a recipe roll block drives, so it speaks the same
 * slice language.
 */
export const MANUAL_ROLL_MIN_BEATS = 0.25;
export const MANUAL_ROLL_MAX_BEATS = 2;
/**
 * How far the position may run past the current track's duration
 * before the tick's watchdog presumes the end-of-track floor is
 * stuck and forces it (Note 21). Small on purpose: a healthy floor
 * lands or ends the set within a tick or two of the end; anything
 * still unrecovered two seconds past the end is not recovering.
 */
export const WATCHDOG_OVERRUN_SEC = 2;
/** A decision commits once its overlap anchor is this close. */
const COMMIT_HORIZON_SEC = 1.0;

/** Why a session ended — every end carries one (guarantee 7). */
export type DjSessionEndReason =
  "user-stop" | "queue-exhausted" | "start-no-playable" | "replaced";

/** How the most recent start() attempt resolved (guarantee 7). */
export type DjStartOutcome = "started" | "no-playable" | "empty" | "superseded";

interface FailureMark {
  attempts: number;
  lastFailedAtMs: number;
}

/** A join the decks have been told to perform; completion is its owner's. */
interface ActiveJoin {
  token: number;
  /** The brain's decision, or null for a legacy-plan performance. */
  decision: BrainDecision | null;
  incoming: PreparedTrack;
  landedIndex: number;
  pendingSegments: RateSegment[];
  /** Seconds of the outgoing heard at the moment the overlap begins. */
  heardLengthSec: number;
}

/** A guest request carrying the playable track the guest chose. */
export interface LiveRaveRequestInput {
  id: string;
  guestId: string;
  track: Track;
  requestedAtSec: number;
}

function raveQueueEntry(prepared: PreparedTrack): RaveQueueEntry<Track> {
  const labels = labelsForTrack(prepared.track.id);
  const candidate = candidateFromAnalysis(
    prepared.track.id,
    prepared.analysis,
    labels,
  );
  const info: RaveTrackInfo = {
    trackId: prepared.track.id,
    artist: prepared.track.artists,
    bpm: candidate.bpm,
    key: candidate.key,
    energy: candidate.energy,
  };
  return { track: prepared.track, info };
}

/**
 * Narration of a standing decision for the stage, written FROM
 * THE ARTEFACT: the candidate's family plus what the recipe
 * itself carries (its scratch loop's technique, a brake block,
 * its effect kinds). Nothing is invented — a family with nothing
 * performed ("let-it-play") narrates to null, and the stage's
 * derivable base lines speak instead.
 */
export function describeDecisionMove(
  decision: BrainDecision | null,
): StageCurrentMove | null {
  if (!decision) return null;
  const family = decision.candidate.family;
  const recipe = decision.recipe;
  switch (family) {
    case "let-it-play":
      return null;
    case "scratch": {
      const technique =
        recipe.loops.find((loop) => loop.type === "scratch")?.technique ?? null;
      return {
        label: technique
          ? `Performing a ${technique} scratch`
          : "Performing a scratch",
        family,
        technique,
      };
    }
    case "spinback":
      return {
        label: "Spinback into the next track",
        family,
        technique: "spinback",
      };
    case "vinyl-stop": {
      const brake = recipe.loops.some((loop) => loop.type === "brake");
      return brake
        ? {
            label: "Brake stop into the next track",
            family,
            technique: "brake",
          }
        : {
            label: "Vinyl stop into the next track",
            family,
            technique: "vinyl-stop",
          };
    }
    case "fx": {
      const kinds = [
        ...new Set((recipe.effects ?? []).map((effect) => effect.kind)),
      ];
      return {
        label:
          kinds.length === 1
            ? `Blending with ${kinds[0]}`
            : kinds.length > 1
              ? "Blending with layered effects"
              : "Blending with effects",
        family,
        technique: kinds[0] ?? null,
      };
    }
    case "long-blend":
      return {
        label: "Long blend into the next track",
        family,
        technique: null,
      };
    case "standard-blend":
      return {
        label: "Blending into the next track",
        family,
        technique: null,
      };
    case "short-blend":
      return {
        label: "Short blend into the next track",
        family,
        technique: null,
      };
    case "loop-extended-blend":
      return {
        label: "Loop-extended blend into the next track",
        family,
        technique: null,
      };
    case "drop-cut":
      return {
        label: "Cutting to the next track's drop",
        family,
        technique: null,
      };
    case "section-swap":
      return {
        label: "Section swap into the next track",
        family,
        technique: null,
      };
    case "echo-out":
      return {
        label: "Echoing out into the next track",
        family,
        technique: null,
      };
    case "filter-fade":
      return {
        label: "Filter fade into the next track",
        family,
        technique: null,
      };
    case "early-cut":
      return {
        label: "Early cut into the next track",
        family,
        technique: null,
      };
    default:
      return null;
  }
}

/**
 * §28's loudness continuity between two tracks, as the decks
 * actually met them: the level-match gains the session applied
 * to each, compared in decibels. A 12 dB step reads as a total
 * discontinuity; matched gains read as perfect continuity.
 */
export function loudnessContinuityBetween(
  outgoing: PreparedTrack,
  incoming: PreparedTrack,
): number {
  const gainA = levelGainFor(outgoing.analysis.loudness);
  const gainB = levelGainFor(incoming.analysis.loudness);
  if (!(gainA > 0) || !(gainB > 0)) return 0.5;
  const db = Math.abs(20 * Math.log10(gainB / gainA));
  return Math.min(1, Math.max(0, 1 - db / 12));
}

export class DjSession {
  /**
   * The brain this session thinks with: its signal bank is the
   * session's ears, its join history the night's memory. Public so
   * surfaces and tests can read the room the session hears.
   */
  readonly brain: DjBrain;

  private context: AudioContext | null = null;
  private mixer: TwoDeckMixer | null = null;
  private queue: Track[] = [];
  private index = -1;
  private current: PreparedTrack | null = null;
  private next: PreparedTrack | null = null;
  /** Queue index of `next` — not always index + 1: preparation walks past unpreparable tracks. */
  private nextIndex = -1;
  /**
   * The horizon's second slot: the playable track after `next`,
   * prepared concurrently with it (Note 20) so one slow download
   * cannot strand the set at a track end. Invariant at every
   * settle point: the slots hold distinct queue indices, both
   * beyond the current index, ordered nextIndex < afterNextIndex.
   */
  private afterNext: PreparedTrack | null = null;
  /** Queue index of `afterNext`. */
  private afterNextIndex = -1;
  /**
   * Preparation failures in this session, with attempts and age.
   * A mark blocks a track only while its backoff window runs, and
   * the window grows with attempts (capped): the one-strike
   * branding of v1 is gone, and so is the later 3-strikes burial
   * (guarantee 5; Note 20).
   */
  private readonly failures = new Map<string, FailureMark>();
  /** Bumped whenever the queue is replaced, so in-flight preparation can tell it is stale. */
  private queueGeneration = 0;
  /** True while the end-of-track plain-cut advance is looking for a playable track. */
  private endAdvanceInFlight = false;
  /**
   * Set when the floor's walk discarded itself because the queue
   * generation moved under it (Note 24): the finally that
   * releases the floor latch re-runs the floor once against the
   * rebuilt queue instead of letting the discard be read as
   * exhaustion.
   */
  private floorRetryAfterDiscard = false;
  /**
   * The queue index the Note 21 watchdog has already rescued once:
   * the watchdog fires at most once per track, so a floor it
   * unlatched that wedges again on the same track is surfaced by
   * the standing end branch rather than rescued in a loop.
   */
  private watchdogRescuedIndex = -1;
  private segments: RateSegment[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastVolume = -1;
  private readonly liveRaveQueue = new LiveRaveQueue<Track>();
  private readonly liveRavePlayedTrackIds = new Set<string>();
  private liveRaveDoNotPlay: string[] = [];

  // ---- brain-loop state ----

  /** The brain's current decision for the playing pair, uncommitted. */
  private decision: BrainDecision | null = null;
  /** What the current decision was made from; a change re-opens it. */
  private decisionInputs: {
    outgoingAnalysis: unknown;
    incomingAnalysis: unknown;
    signalEvents: number;
  } | null = null;
  /** A join currently sounding on the decks (locked; completion-owned). */
  private activeJoin: ActiveJoin | null = null;
  /**
   * The rendition the standing decision calls for, when its recipe
   * carries stretchB: requested the moment the decision is made
   * (the decision window opens up to 150 s before the anchor, far
   * beyond any render's cost), tracked here so the commit can tell
   * ready from still-rendering without ever awaiting it.
   */
  private renditionRequest: {
    trackId: string;
    factor: number;
    buffer: AudioBuffer | null;
  } | null = null;
  private joinTokenCounter = 0;
  /** Which join family delivered each track (for signal attribution). */
  private readonly deliveredBy = new Map<string, string>();
  /** Fallback plain cuts this session — degradation, counted honestly. */
  private plainCutFallbacks = 0;
  private degradationAnnounced = false;
  private endReasonValue: DjSessionEndReason | null = null;
  private startOutcomeValue: DjStartOutcome | null = null;
  private partyUnsubscribe: (() => void) | null = null;
  /**
   * The standing temperament the personality wiring owns (R4): the
   * resolved decision settings the wiring hands in, or null when no
   * wiring has spoken. A session that never receives them behaves
   * exactly as before R4 — the brain keeps its shipped profile, the
   * arc shape is chosen from the pool, and curation spends its
   * shipped constants.
   */
  private decisionSettingsValue: ResolvedDecisionSettings | null = null;

  // ---- R6 state ----

  /** The playlist-intelligence picture, rebuilt as the cache deepens. */
  private intelCache: { key: string; intel: PlaylistIntel } | null = null;
  /**
   * The landing the per-join track choice was last spent for, as
   * `${queueGeneration}:${index}`. One choice per landing: a
   * deliberate ordering act (curation, request scheduling) marks
   * its own landing spent, and horizon refills never re-roll.
   */
  private choiceSpentKey: string | null = null;
  /** The most recent track choice the brain made, if any. */
  private lastTrackChoiceValue: TrackChoice | null = null;
  /**
   * §34: a manual intervention (seek, skip, stage grab, resume)
   * sets this; the next tick inspects the actual state and
   * repairs/cancels stale plans before anything is planned.
   */
  private inspectionNeeded = false;
  /** The buy-time loop's standing state, while it turns. */
  private buyTime: {
    startSec: number;
    wraps: number;
    boughtSec: number;
    /** A wrap-bookkeeping timer is currently scheduled for it. */
    scheduled: boolean;
  } | null = null;
  /** The queue index whose buy-time bound is spent for this landing. */
  private buyTimeExhaustedIndex = -1;
  /** Total buy-time wraps this session (the honest count). */
  private buyTimeWrapsTotal = 0;

  // --- The DJ stage engine seams (Interface Build 6's filing) ---
  /**
   * The control level (the spec's three, made real). Session
   * state, deliberately NOT reset by stop(): like the decision
   * settings it is the host's standing choice about how the decks
   * are run, and nothing re-hands it at start() — the snapshot
   * reports it and the stage's switcher writes it. Default
   * "autonomous": exactly the behaviour every session had before
   * the seams. The per-level contracts live on setControlLevel.
   */
  private controlLevelValue: DjControlLevel = "autonomous";
  /**
   * The standing per-deck tempo bias (a ratio; 1 = neutral),
   * clamped to the engine's widest stretch envelope at set time.
   * A planner-belief correction: considerJoin and the manual-move
   * authoring read the pair's analyses with the biased decks'
   * tempos scaled, so the authored rates honour the bias; the
   * decks' live rates are never touched by it. Standing across
   * stop() like the control level — the host's correction stays
   * until the host resets it.
   */
  private tempoBiasByDeck: [number, number] = [1, 1];
  /**
   * The manual loop the host armed on the playing deck, while it
   * turns: the region, its deck, and whether a wrap-bookkeeping
   * timer is currently scheduled (the buy-time loop's pattern).
   * Held until released — a host's loop is a hand on the deck,
   * not a bounded rescue — but any performance (a commit), any
   * track change, a seek, or a stop ends it: from a blend's start
   * the executor owns the decks.
   */
  private manualLoop: {
    deckIndex: DeckIndex;
    startSec: number;
    endSec: number;
    beats: number;
    scheduled: boolean;
  } | null = null;
  /**
   * The manual slip roll open on a deck, while it sounds: its
   * deck and slice length in beats. Released by the host, by any
   * performance, by a track change, or by stop — a standing roll
   * send must never bleed into a track it was not opened on.
   */
  private manualRoll: { deckIndex: DeckIndex; beats: number } | null = null;
  /** True while this session has placed assisted holds at the mixer.
   *  The session is the mixer's only hold client, so this is exact
   *  knowledge: no holds placed means a clear would be a no-op, and
   *  the clear call is skipped rather than made. */
  private holdsOutstanding = false;

  /** Notified whenever the session starts or stops, for UI state. */
  onRunningChange: ((running: boolean) => void) | null = null;

  /** Notified when a blend starts sounding and when it completes. */
  onBlendChange: ((blending: boolean) => void) | null = null;

  constructor(brain: DjBrain = new DjBrain()) {
    this.brain = brain;
  }

  get isRunning(): boolean {
    return this.mixer !== null;
  }

  get isPaused(): boolean {
    return this.context?.state === "suspended";
  }

  /** Which physical deck holds the playing track (for Pro readouts). */
  get currentDeckIndex(): DeckIndex {
    return this.mixer?.currentDeckIndex ?? 0;
  }

  /** True while a blend is sounding on the decks. */
  get blendingNow(): boolean {
    return this.activeJoin !== null;
  }

  /** True while a join is decided or sounding (the locked-join holds). */
  private get joinLocked(): boolean {
    return this.decision !== null || this.activeJoin !== null;
  }

  /** Why the last live session ended; null while one is running fresh. */
  get endReason(): DjSessionEndReason | null {
    return this.endReasonValue;
  }

  /** How the most recent start() resolved. */
  get startOutcome(): DjStartOutcome | null {
    return this.startOutcomeValue;
  }

  /** Fallback plain cuts so far this session. */
  get plainCutCount(): number {
    return this.plainCutFallbacks;
  }

  /** Buy-time loop wraps so far this session (Note 19, ruling 2). */
  get buyTimeLoopCount(): number {
    return this.buyTimeWrapsTotal;
  }

  /** The most recent track choice the brain made (R6), if any. */
  get lastTrackChoice(): TrackChoice | null {
    return this.lastTrackChoiceValue;
  }

  /**
   * The playlist-intelligence picture (R6) as the cache currently
   * supports it: known facts, pending tracks, energy groups and
   * transition clusters for the active queue. Rebuilt lazily as
   * preparation deepens the cache.
   */
  get playlistIntel(): PlaylistIntel {
    return this.currentIntel();
  }

  /**
   * Guarantee 3's public state: the session is degraded when its
   * joins have fallen back to plain cuts beyond the stated
   * threshold. Readable by any surface; also toasted once, when the
   * threshold is crossed.
   */
  get degraded(): boolean {
    return this.plainCutFallbacks >= PLAIN_CUT_ANNOUNCE_THRESHOLD;
  }

  /** The standing temperament the wiring last handed in, if any. */
  get decisionSettings(): ResolvedDecisionSettings | null {
    return this.decisionSettingsValue;
  }

  /**
   * Hands the session its standing temperament (R4): the resolved
   * settings are stored for curation, and the brain's profile is
   * the resolved profile from this moment on. The wiring owns
   * these settings — it re-hands them whenever the listener's
   * personality or sliders change.
   */
  setDecisionSettings(settings: ResolvedDecisionSettings): void {
    this.decisionSettingsValue = settings;
    this.brain.setProfile(settings.profile);
  }

  // The manual stage (Pro layer). These lean on the mix through the
  // mixer's trim stage; they never touch the automation's scheduling.

  setCrossfade(position: number): void {
    this.inspectionNeeded = true;
    this.mixer?.setCrossfade(position);
  }

  setDeckTrim(index: DeckIndex, level: number): void {
    this.inspectionNeeded = true;
    this.mixer?.setDeckTrim(index, level);
  }

  setDeckBassCut(index: DeckIndex, cut: boolean): void {
    this.inspectionNeeded = true;
    this.mixer?.setDeckBassCut(index, cut);
  }

  setDeckEq(index: DeckIndex, band: "bass" | "mid" | "high", db: number): void {
    this.inspectionNeeded = true;
    this.mixer?.setDeckEq(index, band, db);
    // Assisted: a grab on a shared automated parameter becomes a
    // HOLD — the executor's next performance skips that band's
    // automation on this deck, so the hand's value stands.
    if (this.controlLevelValue === "assisted") {
      this.mixer?.holdManualParam(index, { kind: "eq", band });
      this.holdsOutstanding = true;
    }
  }

  setDeckFilter(index: DeckIndex, hz: number): void {
    this.inspectionNeeded = true;
    this.mixer?.setDeckFilter(index, hz);
    if (this.controlLevelValue === "assisted") {
      this.mixer?.holdManualParam(index, { kind: "filter" });
      this.holdsOutstanding = true;
    }
  }

  setCrossfaderCurve(curve: StageCrossfaderCurve): void {
    this.inspectionNeeded = true;
    this.mixer?.setCrossfaderCurve(curve);
  }

  setFxAssign(kind: StageEffectKind, assign: StageFxAssign): void {
    this.inspectionNeeded = true;
    this.mixer?.setManualFxAssign(kind, assign);
  }

  setFxSendLevel(kind: StageEffectKind, side: "A" | "B", level: number): void {
    this.inspectionNeeded = true;
    this.mixer?.setManualFxSend(kind, side, level);
    // Assisted: the send grab holds that deck's send of this
    // kind. The stage's sides are deck indices in disguise (the
    // snapshot's own sideForDeck mapping: A = deck 0, B = deck 1).
    if (this.controlLevelValue === "assisted") {
      this.mixer?.holdManualParam(side === "A" ? 0 : 1, {
        kind: "send",
        effect: kind,
      });
      this.holdsOutstanding = true;
    }
  }

  /** The mixer's master analyser for taps, or null when no session runs. */
  masterAnalyser(): AnalyserNode | null {
    return this.mixer?.masterAnalyser() ?? null;
  }

  /**
   * Which physical deck holds the PLAYING track. The mixer flips
   * its current deck at PERFORM time, so while a join sounds its
   * current deck is the INCOMING one and the session's playing
   * deck is the other; outside a join the two agree. Every
   * per-deck truth below is derived from this, never from the
   * mixer's raw current alone.
   */
  private get playingDeckIndex(): DeckIndex {
    if (!this.mixer) return 0;
    return this.activeJoin
      ? ((1 - this.mixer.currentDeckIndex) as DeckIndex)
      : this.mixer.currentDeckIndex;
  }

  /**
   * The standing incoming (the engine seams' first request): the
   * track a sounding join is bringing in, and the deck it sounds
   * on. Null whenever no join is sounding — a PREPARED next track
   * is not standing anywhere: preparation is in-memory, and the
   * standby deck holds nothing until a performance loads it.
   */
  get standingIncoming(): { track: Track; deckIndex: DeckIndex } | null {
    if (!this.activeJoin || !this.mixer) return null;
    return {
      track: this.activeJoin.incoming.track,
      deckIndex: (1 - this.playingDeckIndex) as DeckIndex,
    };
  }

  /**
   * One deck's truthful playhead: the playing deck reads the
   * session's own position integration; the incoming deck of a
   * sounding join integrates the join's pending segments with
   * the same math. Any other deck has no playhead — null.
   */
  private deckPositionSec(index: DeckIndex): number | null {
    if (!this.context || !this.current) return null;
    if (index === this.playingDeckIndex) {
      return Math.min(
        Math.max(0, this.positionNow()),
        this.current.buffer.duration,
      );
    }
    const join = this.activeJoin;
    if (!join || index !== 1 - this.playingDeckIndex) return null;
    const now = this.context.currentTime;
    let segment = join.pendingSegments[0];
    if (!segment) return null;
    for (const candidate of join.pendingSegments) {
      if (candidate.fromCtxTime <= now) segment = candidate;
    }
    const position =
      segment.trackTimeAtStart + (now - segment.fromCtxTime) * segment.rate;
    return Math.min(Math.max(0, position), join.incoming.buffer.duration);
  }

  /** One deck's truthful sounding track id, or null when it holds nothing. */
  private deckTrackId(index: DeckIndex): string | null {
    if (!this.current) return null;
    if (index === this.playingDeckIndex) return this.current.track.id;
    if (this.activeJoin && index === 1 - this.playingDeckIndex) {
      return this.activeJoin.incoming.track.id;
    }
    return null;
  }

  /**
   * The stage snapshot (Build 2A contract, extended by the
   * engine seams): the mixer's current readings assembled
   * read-only, plus the session's per-deck truth (trackId /
   * positionSec), the standing tempo biases, the manual loop and
   * roll state, the control level, and the standby deck's cue
   * read. This writes no session state; its only side effect is
   * the lazy tap construction the session-unlock contract
   * already allows. Null when there is no mixer (no session
   * running).
   */
  stageSnapshot(): StageSnapshot | null {
    if (!this.mixer) return null;
    const mixer = this.mixer;
    const deckSnapshot = (index: DeckIndex) => ({
      ...mixer.stageDeckReadings(index),
      meter: mixer.deckMeterSummary(index),
      trackId: this.deckTrackId(index),
      positionSec: this.deckPositionSec(index),
      tempoBias: this.tempoBiasByDeck[index],
      manualLoop:
        this.manualLoop && this.manualLoop.deckIndex === index
          ? { startSec: this.manualLoop.startSec, beats: this.manualLoop.beats }
          : null,
      manualRollBeats:
        this.manualRoll && this.manualRoll.deckIndex === index
          ? this.manualRoll.beats
          : null,
    });
    const cueDeck = (1 - this.playingDeckIndex) as DeckIndex;
    return {
      decks: [deckSnapshot(0), deckSnapshot(1)],
      master: { meter: mixer.masterMeterSummary() },
      effects: STAGE_EFFECT_KINDS.map((kind) => ({
        kind,
        ...mixer.stageEffectReadings(kind),
        assign: mixer.manualFxAssign(kind),
      })),
      currentMove: describeDecisionMove(
        this.activeJoin?.decision ?? this.decision,
      ),
      crossfaderCurve: mixer.crossfaderCurveName(),
      controlLevel: this.controlLevelValue,
      cue: { deckIndex: cueDeck, meter: mixer.cueMeterSummary(cueDeck) },
    };
  }

  /**
   * The standby deck's cue tap (the engine seams): the pre-fader
   * analyser on the deck that is NOT playing — the deck a DJ
   * would cue. Lazy, on the session-unlock pattern: built on
   * first read, null when no session runs or the tap cannot be
   * built. A metering tap only — this architecture has one
   * output route, so no pre-fader LISTEN path exists to expose
   * (the seam report names that residual).
   */
  cueAnalyser(): AnalyserNode | null {
    if (!this.mixer) return null;
    return this.mixer.cueAnalyser((1 - this.playingDeckIndex) as DeckIndex);
  }

  // --- The control levels ---------------------------------------
  // The spec's three control levels, as behavioural contracts:
  //
  // - "autonomous" (the default): exactly the behaviour every
  //   session had before the seams. The brain authors, revises
  //   and commits joins; the R6 chooser spends; manual grabs on
  //   shared parameters are transient writes the next performance
  //   overwrites (the session-unlock table).
  // - "assisted": the brain authors and commits as in autonomous,
  //   BUT a manual grab on a shared automated parameter — an EQ
  //   band, the filter, or an FX send, per deck — becomes a HOLD:
  //   the executor skips automation for held parameters, so the
  //   hand's value stands through performances and plain starts
  //   until the host moves that control again (the hold stays;
  //   the new value replaces the old), the level leaves assisted
  //   (holds release; the values stay in the nodes), or the
  //   session stops. Trim, bass cut and the crossfader were never
  //   automated, so they are unchanged at every level.
  // - "manual": the brain stops authoring — considerJoin never
  //   runs, no decision is made or committed, the R6 chooser
  //   never spends and the opener is the host's pressed track.
  //   Switching INTO manual drops any standing decision (a
  //   sounding join is already performed and lands as usual).
  //   Horizon preparation CONTINUES — the host's triggers and
  //   the floor need prepared tracks — and the end-of-track
  //   FLOOR stays in every level: plain cut to the prepared
  //   next, the buy-time loop, the advance. The floor is the
  //   session's never-go-silent guarantee, not the brain; in
  //   manual the host's moves (triggers, loops, transport) are
  //   the performance, and the floor is only the safety net
  //   under a host who does nothing.
  //
  // At every level, Addendum A stands: a manual act is never
  // silently overridden by the brain's next tick. Holds are how
  // assisted keeps that promise for grabs; the trigger's
  // superseding decision and the manual level's silence are how
  // the others keep it.

  /** The session's control level, as it stands. */
  get controlLevel(): DjControlLevel {
    return this.controlLevelValue;
  }

  /**
   * Sets the control level. A manual surface: §34 inspection is
   * flagged, so the next tick plans against the inspected state.
   * Leaving assisted releases every hold (the values stay in the
   * nodes; only the protection lifts). Entering manual drops the
   * standing decision — the brain's unperformed intent does not
   * follow the host into manual — while a sounding join, already
   * performed, is untouched and lands as usual.
   */
  setControlLevel(level: DjControlLevel): void {
    this.inspectionNeeded = true;
    const previous = this.controlLevelValue;
    this.controlLevelValue = level;
    if (previous === "assisted" && level !== "assisted") {
      this.clearHolds();
    }
    if (level === "manual" && this.decision) {
      this.decision = null;
      this.decisionInputs = null;
    }
  }

  /** Releases this session's assisted holds at the mixer — only
   *  when holds were actually placed (see holdsOutstanding). */
  private clearHolds(): void {
    if (!this.holdsOutstanding) return;
    this.holdsOutstanding = false;
    this.mixer?.clearManualHolds();
  }

  // --- The tempo bias --------------------------------------------

  /**
   * Sets one deck's standing tempo bias: a ratio (1 = neutral)
   * clamped to the engine's stretch envelope. The planner
   * honours it in its next decisions — setting it flags §34
   * inspection AND drops the standing decision's inputs, so the
   * standing join is re-authored under the biased tempos at the
   * next consideration (a sounding join is already performed and
   * is never re-planned). The decks' live rates are not touched:
   * the bias corrects what the planner BELIEVES about the deck's
   * tempo, which is what its rate authoring spends.
   */
  setDeckTempoBias(index: DeckIndex, ratio: number): void {
    this.inspectionNeeded = true;
    const clamped = Math.min(
      TEMPO_BIAS_MAX,
      Math.max(TEMPO_BIAS_MIN, Number.isFinite(ratio) ? ratio : 1),
    );
    if (clamped === this.tempoBiasByDeck[index]) return;
    this.tempoBiasByDeck[index] = clamped;
    // Force the re-plan: the decision inputs' identity check
    // reads the real analyses, so without this the biased
    // re-authoring would never trigger.
    this.decisionInputs = null;
  }

  /**
   * The prepared pair as the PLANNER should see it: the track on
   * a biased deck is handed over with its analysis's tempo
   * scaled by the deck's bias. The outgoing sits on the playing
   * deck, the incoming will sit on the standby. At neutral bias
   * the originals pass through untouched — zero behaviour change,
   * and the decision-inputs identity in considerJoin keeps
   * reading the real analyses either way (the clones are rebuilt
   * per consideration and never stored). The clone is shallow:
   * sections, drops and the grid are shared, and the audioHash —
   * the executor's fingerprint — is unchanged, so a biased
   * decision still validates against the real analyses at the
   * deck door.
   */
  private biasedPair(): {
    outgoing: PreparedTrack;
    incoming: PreparedTrack;
  } | null {
    if (!this.current || !this.next) return null;
    const scaleTempo = (
      prepared: PreparedTrack,
      bias: number,
    ): PreparedTrack => {
      if (bias === 1) return prepared;
      return {
        ...prepared,
        analysis: {
          ...prepared.analysis,
          beatMap: {
            ...prepared.analysis.beatMap,
            bpm: prepared.analysis.beatMap.bpm * bias,
          },
        },
      };
    };
    const playing = this.playingDeckIndex;
    return {
      outgoing: scaleTempo(this.current, this.tempoBiasByDeck[playing]),
      incoming: scaleTempo(
        this.next,
        this.tempoBiasByDeck[(1 - playing) as DeckIndex],
      ),
    };
  }

  // --- Manual loop and slip roll ---------------------------------

  /**
   * Arms a manual loop on the playing deck, by hand: the region
   * starts where the host says and runs for the given beats on
   * the track's own grid. Returns false — the loop does not arm —
   * when the session cannot honestly perform it: no session, the
   * deck is not the playing deck, a join is sounding (the
   * executor owns the decks), the buy-time loop owns the deck, a
   * loop is already turning (release it first), the track is a
   * playable shell or its timeline is rate-shifted (a rendition's
   * buffer time is a different timeline than the region's track
   * time), the grid cannot convert the beats, or the region
   * would end past the track. With null, releases the standing
   * manual loop (on whichever deck holds it) and returns true.
   *
   * While the loop turns, the session's position bookkeeping
   * wraps with it — the buy-time loop's own pattern — so no
   * position the session reports is ever a lie. §34 applies:
   * the call flags inspection.
   */
  setManualLoop(
    index: DeckIndex,
    region: { startSec: number; beats: number } | null,
  ): boolean {
    this.inspectionNeeded = true;
    if (region === null) {
      this.disarmManualLoop();
      return true;
    }
    if (!this.mixer || !this.context || !this.current) return false;
    if (index !== this.playingDeckIndex) return false;
    if (this.activeJoin) return false;
    if (this.buyTime) return false;
    if (this.manualLoop) return false;
    if (this.current.mixable === false) return false;
    if (this.activeRate() !== 1) return false;
    const beatMap = this.current.analysis.beatMap;
    if (!(beatMap.bpm > 0) || !(region.beats > 0)) return false;
    const startBeat = beatsAtTime(beatMap, region.startSec);
    const endSec = timeAtBeat(beatMap, startBeat + region.beats);
    if (!Number.isFinite(endSec) || endSec <= region.startSec) return false;
    if (endSec > this.current.buffer.duration) return false;
    this.mixer.setDeckLoopRegion(index, region.startSec, endSec);
    const state = {
      deckIndex: index,
      startSec: region.startSec,
      endSec,
      beats: region.beats,
      scheduled: false,
    };
    this.manualLoop = state;
    this.scheduleManualLoopWrap(state);
    return true;
  }

  /** Disarms the manual loop (the deck plays on linearly). */
  private disarmManualLoop(): void {
    if (!this.manualLoop) return;
    const deckIndex = this.manualLoop.deckIndex;
    this.manualLoop = null;
    this.mixer?.clearDeckLoop(deckIndex);
  }

  /**
   * Schedules the bookkeeping for the manual loop's next wrap,
   * mirroring the buy-time loop's: the wrap moment is derived
   * from the audio clock through the active segment, so a pause
   * (which freezes the clock, not the timer) simply reschedules.
   * A manual loop has no bound: it wraps until released, each
   * wrap replacing the position segments so the playhead's track
   * time stays true.
   */
  private scheduleManualLoopWrap(state: {
    deckIndex: DeckIndex;
    startSec: number;
    endSec: number;
    beats: number;
    scheduled: boolean;
  }): void {
    if (!this.context || !this.current) return;
    state.scheduled = true;
    const segment = this.activeSegment();
    const wrapCtxTime = segment
      ? segment.fromCtxTime +
        (state.endSec - segment.trackTimeAtStart) / segment.rate
      : this.context.currentTime;
    const delaySec = Math.max(0, wrapCtxTime - this.context.currentTime);
    this.after(delaySec * 1000, () => {
      state.scheduled = false;
      if (this.manualLoop !== state || !this.context || !this.current) return;
      if (this.context.currentTime < wrapCtxTime - 0.05) {
        // The clock was frozen (a pause) while the timer ran:
        // the wrap has not happened yet — wait for it properly.
        this.scheduleManualLoopWrap(state);
        return;
      }
      this.segments = [
        {
          fromCtxTime: wrapCtxTime,
          trackTimeAtStart: state.startSec,
          rate: segment?.rate ?? 1,
        },
      ];
      this.scheduleManualLoopWrap(state);
    });
  }

  /**
   * Opens (or, with null beats, releases) a manual slip roll on
   * the playing deck: the captured slice — the host's beats,
   * clamped to recipe validation's roll range — circulates in
   * the one roll network while the deck plays on, through the
   * mixer's manual roll hand. Only the playing deck can roll,
   * and never under a sounding join; a call that cannot apply is
   * ignored (the snapshot keeps reporting the truth either way).
   * Re-opening with a different slice length retunes the standing
   * roll. §34 applies: the call flags inspection.
   */
  setManualRoll(index: DeckIndex, beats: number | null): void {
    this.inspectionNeeded = true;
    if (beats === null) {
      this.releaseManualRoll();
      return;
    }
    if (!this.mixer || !this.current) return;
    if (index !== this.playingDeckIndex) return;
    if (this.activeJoin) return;
    const clamped = Math.min(
      MANUAL_ROLL_MAX_BEATS,
      Math.max(MANUAL_ROLL_MIN_BEATS, beats),
    );
    const bpm = this.current.analysis.beatMap.bpm;
    if (!(bpm > 0) || !Number.isFinite(clamped)) return;
    this.mixer.openDeckRoll(index, (clamped * 60) / bpm);
    this.manualRoll = { deckIndex: index, beats: clamped };
  }

  /** Releases the standing manual roll, if any. */
  private releaseManualRoll(): void {
    if (!this.manualRoll) return;
    const deckIndex = this.manualRoll.deckIndex;
    this.manualRoll = null;
    this.mixer?.closeDeckRoll(deckIndex);
  }

  // --- Manual deck moves ------------------------------------------

  /**
   * Triggers one of the R1 stop moves (brake / vinyl-stop /
   * spinback) or R2 scratches on the playing deck, by hand. The
   * move is authored by the brain's manual authors — the same
   * recipes, the same executor — and committed through the
   * standing commit path, so §3's deck-door validation, the
   * rendition discipline, and §28's performed-join record all
   * apply unchanged. The manual decision REPLACES any standing
   * decision (§22's priority: the host's deliberate act outranks
   * the brain's standing intent) and, anchored at the current
   * position, it is inside considerJoin's imminent-anchor guard
   * from the moment it stands — the brain's next tick cannot
   * re-plan over it.
   *
   * Returns false — nothing is performed, and any standing
   * decision is left exactly as it was — when the move cannot be
   * performed: no session, the deck is not the playing deck, a
   * join is already sounding, no prepared incoming is standing,
   * either side is a playable shell, or the author refuses (no
   * landing to hand to, a spinback without runway, a scratch
   * window the material refuses).
   */
  triggerDeckMove(index: DeckIndex, move: ManualDeckMove): boolean {
    this.inspectionNeeded = true;
    if (!this.mixer || !this.context || !this.current || !this.next) {
      return false;
    }
    if (index !== this.playingDeckIndex) return false;
    if (this.activeJoin) return false;
    if (this.current.mixable === false || this.next.mixable === false) {
      return false;
    }
    const pair = this.biasedPair();
    if (!pair) return false;
    const arcPosition =
      (this.index + this.nextIndex) / (2 * Math.max(1, this.queue.length - 1));
    const decision = this.brain.authorManualMove(
      {
        outgoing: pair.outgoing,
        outgoingPositionSec: this.positionNow(),
        incoming: pair.incoming,
      },
      arcPosition,
      move,
    );
    if (!decision) return false;
    this.decision = decision;
    this.decisionInputs = {
      outgoingAnalysis: this.current.analysis as unknown,
      incomingAnalysis: this.next.analysis as unknown,
      signalEvents: this.brain.signals.journal().length,
    };
    this.noteStretchNeed();
    this.commitDecision();
    return true;
  }

  async start(queue: Track[], startIndex = 0): Promise<void> {
    this.stop("replaced");
    if (queue.length === 0 || startIndex >= queue.length) {
      this.startOutcomeValue = "empty";
      return;
    }

    // Ask the normal player to be quiet before the decks make a sound.
    usePlayerStore.getState().dispatch({ type: "PAUSE_REQUESTED" });

    this.context = new AudioContext();
    this.mixer = new TwoDeckMixer(this.context);
    this.failures.clear();
    this.queue = queue;
    this.queueGeneration += 1;
    const generation = this.queueGeneration;
    const store = usePlayerStore.getState();
    store.setQueue(queue);
    store.setStatus("loading", null);
    this.endReasonValue = null;
    // The brain opens the set: history loaded, signals fresh.
    void this.brain.beginSet();
    this.subscribePartyReactions();
    // The opener is liveRave's choice too (Addendum A), spent
    // when the analysis cache already knows the playlist's head
    // — a repeat visit, a second set. On a first play the cache
    // is empty, the field is empty, and the walked opener is the
    // user's pressed track, exactly as before R6.
    this.applyOpeningChoice(startIndex);
    if (this.queue !== queue) store.setQueue(this.queue);

    // The start walks, like every other door into the session: from
    // the requested position forward to the first track that can
    // actually be prepared, stepping over the ones that cannot. One
    // unpreparable track at the press position must not refuse the
    // whole session (Note 14; guarantee 1).
    const found = await this.findNextPlayable(startIndex);
    if (this.queueGeneration !== generation) {
      // A stop or a newer start took over while tracks were being
      // prepared; that attempt owns the session now, so this one
      // leaves quietly instead of dismantling it.
      this.startOutcomeValue = "superseded";
      return;
    }
    if (!found || !this.mixer) {
      // Nothing from the requested position onward can be prepared.
      // The refusal must be seen: the store's error field has no
      // reader in the interface, so the failure is also said on the
      // toast surface the player itself uses for playback failures.
      const message = "None of those tracks could be prepared for mixing.";
      store.setStatus("error", message);
      showToast(message, "error");
      this.startOutcomeValue = "no-playable";
      this.stop("start-no-playable");
      return;
    }
    this.startOutcomeValue = "started";
    this.beginTrack(found.prepared, found.index);
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.onRunningChange?.(true);
  }

  pause(): void {
    if (!this.context) return;
    void this.context.suspend();
    usePlayerStore.getState().setStatus("paused");
  }

  resume(): void {
    if (!this.context) return;
    // Autonomous control resumes after a human pause: the next
    // tick inspects the actual state before planning (§34).
    this.inspectionNeeded = true;
    void this.context.resume();
    usePlayerStore.getState().setStatus("playing");
  }

  /**
   * Reorders everything still to come into a curated set — the
   * remaining tracks get the night's energy arc (its shape chosen
   * from the pool itself) and compatible joins, assembled from
   * their analyses and the owner's labels. The pool is only ever
   * this queue, so the owner's own selection is respected by
   * construction; the current track and anything already played are
   * untouched. This is a user-invoked, one-off preparation of the
   * tail — the decision loop never does this. Refused while a join
   * is decided or sounding, because reordering under a live join is
   * how joins break. Returns whether the reorder happened.
   */
  async curateRemaining(): Promise<boolean> {
    if (!this.current || this.joinLocked) return false;
    const tail = this.queue.slice(this.index + 1);
    if (tail.length < 2) return false;

    const prepared: PreparedTrack[] = [];
    for (const track of tail) {
      const ready = await this.prepareWithDeadline(track);
      if (ready && ready.mixable !== false) {
        this.failures.delete(track.id);
        prepared.push(ready);
      } else if (!ready) {
        this.markFailure(track.id);
      }
      // A shell (ready, not mixable) cannot be curated — it has no
      // analysis to assemble a set from — but it is not a failure:
      // it keeps its place in the tail below, unmarked (Note 20).
    }
    // The session may have moved on while tracks were loading.
    if (!this.current || this.joinLocked) return false;
    if (prepared.length < 2) return false;

    const candidates = prepared.map((item) =>
      candidateFromAnalysis(
        item.track.id,
        item.analysis,
        labelsForTrack(item.track.id),
      ),
    );
    // The night's arc shape is chosen from tonight's pool — unless
    // the standing temperament leans a shape, in which case the
    // lean is the night's shape — and the night so far (joins
    // already played) turns the near-equal band. With no stored
    // temperament the curation bends are not passed at all, so
    // assembleSet spends its shipped constants exactly as before R4.
    const shape =
      this.decisionSettingsValue?.arcShapeLean ?? chooseArcShape(candidates);
    this.brain.setArcShape(shape);
    const byId = new Map(prepared.map((item) => [item.track.id, item]));
    const settings = this.decisionSettingsValue;
    const order = settings
      ? assembleSet(candidates, undefined, {
          shape,
          rotationSeed: this.brain.historySnapshot().length,
          nearEqualEpsilon: settings.curation.nearEqualEpsilon,
          sharedLabelCredit: settings.curation.sharedLabelCredit,
          incumbencyPenalty: settings.curation.incumbencyPenalty,
        })
      : assembleSet(candidates, undefined, {
          shape,
          rotationSeed: this.brain.historySnapshot().length,
        });
    const newTail = order
      .map((id) => byId.get(id)?.track)
      .filter((track) => track !== undefined);
    const failedTail = tail.filter((track) => !byId.has(track.id));
    this.queue = [
      ...this.queue.slice(0, this.index + 1),
      ...newTail,
      ...failedTail,
    ];
    this.queueGeneration += 1;
    // Curation IS this landing's track-ordering act: the per-join
    // chooser does not re-roll what curation just decided.
    this.choiceSpentKey = `${this.queueGeneration}:${this.index}`;
    usePlayerStore.getState().setQueue(this.queue);
    this.next = null;
    this.nextIndex = -1;
    this.afterNext = null;
    this.afterNextIndex = -1;
    void this.prepareNext();
    return true;
  }

  /** Sets the host's liveRave do-not-play list for this session. */
  setLiveRaveDoNotPlay(values: readonly string[]): void {
    this.liveRaveDoNotPlay = [...values];
  }

  /** The liveRave requests still open in this session. */
  get liveRaveOpenRequests(): RaveRequest[] {
    return this.liveRaveQueue.openRequests;
  }

  /**
   * Accepts a guest's request into liveRave's open pool. The track
   * is prepared first (deadline-bound), so an unplayable request is
   * refused immediately (null) instead of being promised to the
   * guest and failing later. Duplicate requests for the same track
   * become votes on the open request rather than separate entries.
   */
  async submitLiveRaveRequest(
    input: LiveRaveRequestInput,
  ): Promise<RaveRequest | null> {
    const prepared = await this.prepareWithDeadline(input.track);
    if (!prepared) {
      this.markFailure(input.track.id);
      return null;
    }
    // A playable shell can be played from the queue, but a guest
    // request is SCHEDULED by musical fit — a track with no
    // analysis cannot be weighed, so the request is refused as
    // unplayable, exactly as before the split. It is not a
    // preparation failure, so no failure mark is laid (Note 20).
    if (prepared.mixable === false) {
      return null;
    }
    this.failures.delete(input.track.id);
    return this.liveRaveQueue.submit({
      id: input.id,
      guestId: input.guestId,
      requestedAtSec: input.requestedAtSec,
      entry: raveQueueEntry(prepared),
    });
  }

  /**
   * Lets liveRave act on the session: the open requests are weighed
   * against tonight's queue as the cache knows it, and the approved
   * ones are inserted at the scheduler's chosen slots. The current
   * track is never touched. Tonight's facts come from the analysis
   * CACHE — the tail is never prepared wholesale here (v1 did, on
   * every poll); instead the horizon creeps: each evaluation also
   * sets one more tail track preparing, so the weighed prefix grows
   * between polls. Tail tracks not yet weighed keep their places at
   * the back of the queue, unmoved. While a join is decided or
   * sounding, the queue is held exactly as it is and every open
   * request is told to wait — a locked join is never rearranged, at
   * any signal pressure.
   */
  async evaluateLiveRaveQueue(
    nowSec: number,
    phaseEnergy?: number,
  ): Promise<RaveDecision[]> {
    if (!this.current || this.liveRaveQueue.openRequests.length === 0) {
      return [];
    }
    const context = {
      nowSec,
      phaseEnergy:
        phaseEnergy ??
        this.brain.arcTargetAt(
          (this.index + 1) / Math.max(1, this.queue.length),
        ),
      doNotPlay: [...this.liveRaveDoNotPlay],
      playedTrackIds: [...this.liveRavePlayedTrackIds],
    };
    if (this.joinLocked) {
      return this.liveRaveQueue.evaluate(
        [],
        context,
        "Waiting — the next blend is already locked",
      ).decisions;
    }

    const tail = this.queue.slice(this.index + 1);
    const entries: RaveQueueEntry<Track>[] = [];
    const unweighed: Track[] = [];
    const blocked = new Set(this.liveRaveDoNotPlay);
    for (const track of tail) {
      // A do-not-play track is withheld from the weighed entries:
      // the queue layer would otherwise read a requested track that
      // happens to be lined up as "already scheduled" without ever
      // consulting the host's list — and the may-not rule (a refusal
      // that holds at any pressure) is the scheduler's to give. The
      // track itself keeps its place in tonight's queue below.
      if (blocked.has(track.id) || blocked.has(track.artists)) {
        unweighed.push(track);
        continue;
      }
      const cached = preparedTrack(track.id);
      // Only a mixable entry can be weighed: a shell in the cache
      // has no musical facts to schedule by (Note 20).
      if (cached && cached.mixable !== false) {
        entries.push(raveQueueEntry(cached));
      } else {
        unweighed.push(track);
      }
    }
    // The horizon creeps by one: the first unweighed tail track
    // starts preparing now, so the next evaluation weighs more of
    // tonight. Fire-and-forget — its result lands in the cache.
    const creep = unweighed.find((track) => !this.failureBlocked(track.id));
    if (creep) {
      void this.prepareWithDeadline(creep).then((ready) => {
        if (ready && ready.mixable !== false) {
          this.failures.delete(creep.id);
        } else if (!ready) {
          this.markFailure(creep.id);
        }
        // A shell is neither a weighed success nor a failure.
      });
    }

    const result = this.liveRaveQueue.evaluate(entries, context);
    if (result.changed) {
      this.queue = [
        ...this.queue.slice(0, this.index + 1),
        ...result.upcoming.map((entry) => entry.track),
        ...unweighed,
      ];
      this.queueGeneration += 1;
      // The request scheduler's order is this landing's choice:
      // the per-join chooser does not re-roll it.
      this.choiceSpentKey = `${this.queueGeneration}:${this.index}`;
      usePlayerStore.getState().setQueue(this.queue);
      this.next = null;
      this.nextIndex = -1;
      this.afterNext = null;
      this.afterNextIndex = -1;
      void this.prepareNext();
    }
    return result.decisions;
  }

  /** Cuts straight to the next track, abandoning any planned blend. */
  skipNext(): void {
    if (!this.mixer || !this.current) return;
    this.inspectionNeeded = true;
    // A decided-but-uncommitted join is simply dropped. A SOUNDING
    // join is finalised as interrupted by beginTrack below (the
    // room heard part of it; history and signals are told).
    this.decision = null;
    this.decisionInputs = null;
    // The horizon's second slot is a prepared next in waiting: a
    // skip lands it rather than walking for what is already here.
    if (!this.next && this.afterNext) {
      this.next = this.afterNext;
      this.nextIndex = this.afterNextIndex;
      this.afterNext = null;
      this.afterNextIndex = -1;
    }
    if (this.next) {
      const next = this.next;
      const nextIdx = this.nextIndex;
      this.clearTimers();
      this.mixer.stopAll();
      this.beginTrack(next, nextIdx);
      return;
    }
    // Nothing prepared yet: walk forward to the first track that can
    // be prepared at all, stepping over unpreparable ones, instead of
    // betting the skip on the single next track.
    const anchorIndex = this.index;
    void this.findNextPlayable(anchorIndex + 1).then((found) => {
      if (!found || !this.mixer || !this.current) return;
      if (this.index !== anchorIndex) return;
      this.clearTimers();
      this.mixer.stopAll();
      this.beginTrack(found.prepared, found.index);
    });
  }

  /**
   * Back to the previous track — or, as players conventionally do,
   * back to the start of the current one when it has barely begun or
   * there is no previous track. Going back to hear a track again is
   * a repeat: the brain is told.
   */
  skipPrevious(): void {
    if (!this.mixer || !this.current) return;
    this.inspectionNeeded = true;
    if (this.index <= 0 || this.positionNow() > 3) {
      this.restartCurrent();
      return;
    }
    const previousTrack = this.queue[this.index - 1];
    void this.prepareWithDeadline(previousTrack).then((prepared) => {
      if (!prepared) {
        this.markFailure(previousTrack.id);
        return;
      }
      this.failures.delete(previousTrack.id);
      if (!this.mixer) return;
      this.clearTimers();
      this.mixer.stopAll();
      this.beginTrack(prepared, this.index - 1, 0, { viaRepeat: true });
    });
  }

  /** Restarts the current track from the beginning. */
  restartCurrent(): void {
    if (!this.mixer || !this.current) return;
    this.inspectionNeeded = true;
    // A restart after really hearing the track is a replay; a
    // restart two seconds in is a correction, and is not read as one.
    const viaRepeat = this.positionNow() >= 30;
    this.clearTimers();
    this.mixer.stopAll();
    this.beginTrack(this.current, this.index, 0, { viaRepeat });
  }

  /**
   * Jumps to a position inside the current track. Any decided or
   * in-progress blend is abandoned (a sounding one is finalised as
   * interrupted); planning resumes from the new position on the
   * next tick.
   */
  seekTo(positionMs: number): void {
    if (!this.mixer || !this.context || !this.current) return;
    this.inspectionNeeded = true;
    this.disarmBuyTimeLoop();
    // A seek moves the playhead out from under any manual loop
    // or roll the host had standing on this track: both end.
    this.disarmManualLoop();
    this.releaseManualRoll();
    const duration = this.current.buffer.duration;
    const target = Math.min(Math.max(0, positionMs / 1000), duration - 0.1);
    const positionBefore = this.positionNow();
    this.finaliseInterruptedJoin();
    this.decision = null;
    this.decisionInputs = null;
    this.clearTimers();
    this.mixer.stopAll();
    const startAt = this.mixer.playNow(
      this.current.buffer,
      target,
      levelGainFor(this.current.analysis.loudness),
    );
    this.segments = [
      { fromCtxTime: startAt, trackTimeAtStart: target, rate: 1 },
    ];
    usePlayerStore.getState().setPosition(Math.round(target * 1000));
    // A seek back is recorded context (the listener marked the
    // section); per the signal model it moves no decision.
    if (target < positionBefore) {
      this.brain.signals.record({ kind: "seek-back" });
    }
  }

  stop(reason: DjSessionEndReason = "user-stop"): void {
    const wasLive = this.mixer !== null || this.current !== null;
    if (this.current) this.noteOutgoingLeft(false, false);
    this.finaliseInterruptedJoin();
    this.clearTimers();
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (this.mixer) {
      // The assisted level's holds end with the session (their
      // values stay in the nodes, which are about to be torn
      // down with the mixer anyway).
      this.clearHolds();
      this.mixer.stopAll();
      this.mixer = null;
    }
    if (this.context) {
      void this.context.close();
      this.context = null;
    }
    this.unsubscribePartyReactions();
    this.queue = [];
    this.queueGeneration += 1;
    this.index = -1;
    this.current = null;
    this.next = null;
    this.nextIndex = -1;
    this.afterNext = null;
    this.afterNextIndex = -1;
    this.endAdvanceInFlight = false;
    this.floorRetryAfterDiscard = false;
    this.watchdogRescuedIndex = -1;
    this.segments = [];
    this.decision = null;
    this.decisionInputs = null;
    this.renditionRequest = null;
    this.intelCache = null;
    this.choiceSpentKey = null;
    this.lastTrackChoiceValue = null;
    this.inspectionNeeded = false;
    this.buyTime = null;
    // The manual loop and roll end with the session; the control
    // level and the tempo biases deliberately stand (see their
    // field notes — the host's standing choices, not set state).
    this.manualLoop = null;
    this.manualRoll = null;
    this.buyTimeExhaustedIndex = -1;
    this.failures.clear();
    this.deliveredBy.clear();
    this.plainCutFallbacks = 0;
    this.degradationAnnounced = false;
    this.liveRaveQueue.clear();
    this.liveRavePlayedTrackIds.clear();
    if (wasLive) this.endReasonValue = reason;
    this.onBlendChange?.(false);
    this.onRunningChange?.(false);
  }

  // -------------------------------------------------------------------
  // Listening reports and signals
  // -------------------------------------------------------------------

  /**
   * The outgoing track leaves: the taste profile is fed the fraction
   * actually heard, and — for track-to-track switches — the signal
   * bank is told how it left (completion / early skip / late skip,
   * per the taste doctrine's own boundaries). A stopped session
   * reports the listen but lays no signal: ending the night is not
   * a judgement on the song.
   */
  private noteOutgoingLeft(completed: boolean, withSignal = true): void {
    const outgoing = this.current;
    if (!outgoing) return;
    const duration = outgoing.buffer.duration;
    if (duration <= 0) return;
    const heard = completed
      ? duration
      : Math.min(Math.max(this.positionNow(), 0), duration);
    recordListen({
      track: outgoing.track,
      playedRatio: heard / duration,
      completed,
    });
    if (!withSignal) return;
    if (completed) {
      this.brain.signals.record({ kind: "completion" });
      return;
    }
    const ratio = heard / duration;
    const family = this.deliveredBy.get(outgoing.track.id);
    if (ratio < 0.25) {
      this.brain.signals.record({ kind: "skip-early", family });
    } else if (ratio >= 0.75) {
      this.brain.signals.record({ kind: "skip-late", family });
    }
  }

  private beginTrack(
    prepared: PreparedTrack,
    index: number,
    offsetSec = 0,
    options: { viaRepeat?: boolean } = {},
  ): void {
    if (!this.mixer || !this.context) return;
    // A sounding join interrupted by this switch is finalised first:
    // the room heard part of it, and it is recorded as such.
    this.finaliseInterruptedJoin();
    // A landing ends any buy-time loop: the loop belonged to the
    // track that was ending, and its bound resets with the landing.
    this.disarmBuyTimeLoop();
    // A track change likewise ends the host's manual loop and
    // roll: both belonged to the track that was playing.
    this.disarmManualLoop();
    this.releaseManualRoll();
    this.buyTimeExhaustedIndex = -1;
    if (this.current && this.current.track.id !== prepared.track.id) {
      this.noteOutgoingLeft(false);
    }
    if (options.viaRepeat) {
      this.brain.signals.record({
        kind: "repeat",
        family: this.deliveredBy.get(prepared.track.id),
      });
    }
    this.current = prepared;
    this.liveRavePlayedTrackIds.add(prepared.track.id);
    if (!this.deliveredBy.has(prepared.track.id)) {
      this.deliveredBy.set(prepared.track.id, "plain-cut");
    }
    this.index = index;
    this.adoptHorizonAfterLanding(index);
    this.watchdogRescuedIndex = -1;
    this.decision = null;
    this.decisionInputs = null;
    this.renditionRequest = null;
    this.onBlendChange?.(false);

    const startAt = this.mixer.playNow(
      prepared.buffer,
      offsetSec,
      levelGainFor(prepared.analysis.loudness),
    );
    this.segments = [
      { fromCtxTime: startAt, trackTimeAtStart: offsetSec, rate: 1 },
    ];

    const store = usePlayerStore.getState();
    store.setCurrentTrack(prepared.track, index);
    store.setDuration(
      prepared.track.durationMs ?? Math.round(prepared.buffer.duration * 1000),
    );
    store.setPosition(Math.round(offsetSec * 1000));
    store.setStatus("playing");

    void this.prepareNext();
  }

  // -------------------------------------------------------------------
  // Preparation: deadline-bound, walk-past, retryable (guarantees 1, 2, 5)
  // -------------------------------------------------------------------

  /**
   * Guarantee 2: every preparation the session awaits settles within
   * the deadline. The underlying load may linger in the source's
   * in-flight map (bounded, one entry per track); what the SESSION
   * holds is a result — the prepared track, or null for failure.
   */
  private async prepareWithDeadline(
    track: Track,
  ): Promise<PreparedTrack | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        loadTrackForMixing(track),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PREPARATION_DEADLINE_MS);
        }),
      ]);
    } catch {
      // This seam NEVER rejects (Note 21): a load that throws or
      // rejects is a failed preparation, exactly like one that
      // answers null — the walk marks it and moves on. The field
      // wedge this guards against was an exception escaping a
      // preparation and latching the end-of-track floor forever:
      // every caller of the walk may now rely on a result, never
      // on an exception.
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Whether a track's failure mark currently blocks an attempt. */
  private failureBlocked(trackId: string): boolean {
    const mark = this.failures.get(trackId);
    if (!mark) return false;
    const backoffMs = Math.min(
      FAILURE_MARK_TTL_MS * mark.attempts,
      FAILURE_BACKOFF_CAP_MS,
    );
    return Date.now() - mark.lastFailedAtMs < backoffMs;
  }

  private markFailure(trackId: string): void {
    const mark = this.failures.get(trackId);
    this.failures.set(trackId, {
      attempts: (mark?.attempts ?? 0) + 1,
      lastFailedAtMs: Date.now(),
    });
  }

  /**
   * Walks forward from `fromIndex` to the first track that can be
   * prepared, stepping over unpreparable ones — each failure is
   * marked (with its age), so a dead track is not paid for on every
   * walk, yet may be retried once its backoff expires. Indices the
   * preparation horizon already holds are skipped: the horizon's
   * knowledge is never re-walked from scratch (Note 20). Returns
   * null when nothing ahead can be prepared right now, or when the
   * session moved on while a track was downloading (a fresher walk
   * owns the answer then). Session start walks through here too:
   * its anchor is the not-yet-playing index (−1), so the walk begins
   * exactly at the requested start position.
   */
  private async findNextPlayable(
    fromIndex: number,
    claimed?: ReadonlySet<number>,
  ): Promise<{ prepared: PreparedTrack; index: number } | null> {
    const anchorIndex = this.index;
    const generation = this.queueGeneration;
    const held = claimed ?? this.horizonIndices();
    // The walk iterates a SNAPSHOT of the queue (Note 21): the
    // live queue can be replaced under an in-flight walk —
    // liveRave curation rebuilds it, requests rewrite it — and
    // indexing a shorter replacement would dereference a missing
    // track. That exception escaping this walk is what latched
    // the end-of-track floor in the field: the promise rejected,
    // the latch's only reset lived in its fulfilment handler, and
    // the set wedged in silence with the clock running past the
    // end of a finished song. The generation guard below already
    // discards a result the moment the queue moves on, so the
    // snapshot costs nothing.
    const queue = this.queue;
    try {
      for (
        let candidate = Math.max(fromIndex, anchorIndex + 1);
        candidate < queue.length;
        candidate += 1
      ) {
        if (held.has(candidate)) continue;
        const track = queue[candidate];
        if (!track) continue;
        if (this.failureBlocked(track.id)) continue;
        const prepared = await this.prepareWithDeadline(track);
        // The session may have moved on while this was downloading.
        if (this.index !== anchorIndex || this.queueGeneration !== generation) {
          return null;
        }
        if (!prepared) {
          this.markFailure(track.id);
          continue;
        }
        this.failures.delete(track.id);
        return { prepared, index: candidate };
      }
    } catch {
      // The walk NEVER rejects (Note 21): an unexpected throw
      // inside it reads as "nothing playable right now", an answer
      // every caller already handles honestly — a refused start
      // with its toast, an ended set with its reason, a horizon
      // pass that simply retries at the next landing.
      return null;
    }
    return null;
  }

  /** The queue indices the preparation horizon currently holds. */
  private horizonIndices(): Set<number> {
    const held = new Set<number>();
    if (this.nextIndex >= 0) held.add(this.nextIndex);
    if (this.afterNextIndex >= 0) held.add(this.afterNextIndex);
    return held;
  }

  /**
   * Adopts a landed candidate into the horizon: the slots always
   * end up holding the two smallest distinct indices beyond the
   * current track, in order — whichever walk landed first. A
   * duplicate of a held index is dropped (the source dedupes the
   * download itself; this is the slot-level belt and braces).
   */
  private adoptIntoHorizon(found: {
    prepared: PreparedTrack;
    index: number;
  }): void {
    if (found.index <= this.index) return;
    const held: { prepared: PreparedTrack; index: number }[] = [];
    if (this.next) held.push({ prepared: this.next, index: this.nextIndex });
    if (this.afterNext) {
      held.push({ prepared: this.afterNext, index: this.afterNextIndex });
    }
    if (held.some((slot) => slot.index === found.index)) return;
    held.push(found);
    held.sort((a, b) => a.index - b.index);
    this.next = held[0]?.prepared ?? null;
    this.nextIndex = held[0]?.index ?? -1;
    this.afterNext = held[1]?.prepared ?? null;
    this.afterNextIndex = held[1]?.index ?? -1;
  }

  // -------------------------------------------------------------------
  // R6: playlist intelligence, track choice, double validation,
  // resume-inspection, and the buy-time loop
  // -------------------------------------------------------------------

  /**
   * The playlist-intelligence picture over the active queue,
   * rebuilt whenever the queue's generation or the cache's known
   * count moves — the picture deepens as preparation lands, and
   * a rebuild is the only cost (cheap, synchronous, cache reads).
   */
  private currentIntel(): PlaylistIntel {
    let known = 0;
    const entries = this.queue.map((track) => {
      const prepared = preparedTrack(track.id);
      const ready = prepared && prepared.mixable !== false ? prepared : null;
      if (ready) known += 1;
      return {
        trackId: track.id,
        prepared: ready,
        labels: labelsForTrack(track.id),
      };
    });
    const key = `${this.queueGeneration}:${this.queue.length}:${known}`;
    if (this.intelCache?.key === key) return this.intelCache.intel;
    const intel = buildPlaylistIntel(entries);
    this.intelCache = { key, intel };
    return intel;
  }

  /**
   * The known prefix of the queue from `fromIndex`: entries in
   * standing order whose facts the intelligence layer holds and
   * which no failure mark currently blocks. The prefix STOPS at
   * the first unknown or blocked track — the chooser reorders
   * only territory the DJ has actually mapped, never reaching
   * past an unmapped track to grab a later one (the standing
   * order — the user's own playlist order — governs the rest).
   */
  private knownField(
    intel: PlaylistIntel,
    fromIndex: number,
  ): { trackId: string; facts: TrackFacts }[] {
    const field: { trackId: string; facts: TrackFacts }[] = [];
    for (let i = fromIndex; i < this.queue.length; i += 1) {
      const track = this.queue[i];
      if (this.failureBlocked(track.id)) break;
      const facts = intel.factsById.get(track.id);
      if (!facts) break;
      field.push({ trackId: track.id, facts });
    }
    return field;
  }

  /**
   * The set's opener, chosen (Addendum A) when the cache already
   * knows the playlist's head: the user's pressed track holds
   * the incumbency head start, and a band rival may still open
   * instead. With an empty field (a first play) nothing moves —
   * the walk opens with the pressed track, as before R6.
   */
  private applyOpeningChoice(startIndex: number): void {
    // The manual control level: the opener is the host's pressed
    // track — the chooser does not spend in manual.
    if (this.controlLevelValue === "manual") return;
    if (this.queue.length - startIndex < 2) return;
    const intel = this.currentIntel();
    const field = this.knownField(intel, startIndex);
    if (field.length < 2) return;
    const choice = this.brain.chooseNextTrack({
      current: null,
      field,
      arcPosition: 0,
      curation: this.decisionSettingsValue?.curation,
    });
    if (!choice) return;
    this.lastTrackChoiceValue = choice;
    if (choice.trackId === field[0].trackId) return;
    const from = this.queue.findIndex(
      (track, i) => i > startIndex && track.id === choice.trackId,
    );
    if (from < 0) return;
    const reordered = [...this.queue];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(startIndex, 0, moved);
    this.queue = reordered;
  }

  /**
   * The per-join track choice, spent at most once per landing
   * and only while the horizon's first slot is open: the brain
   * weighs the known prefix of the remaining tail (playlist
   * intelligence + the arc's target at the winner's slot + §15
   * shaping) and its pick moves to the front of the tail, where
   * the standing horizon machinery prepares and performs it. A
   * pick that equals the standing next changes nothing. The
   * hybrid view (Note 19, ruling 3) in one method: set-level
   * arc steering here, pair-level joins underneath, untouched.
   */
  private spendTrackChoiceIfNeeded(): void {
    // The manual control level: the standing order is the host's
    // — the chooser does not spend in manual.
    if (this.controlLevelValue === "manual") return;
    if (!this.current || !this.mixer) return;
    if (this.next) return;
    if (this.joinLocked) return;
    if (this.endAdvanceInFlight) return;
    const key = `${this.queueGeneration}:${this.index}`;
    if (this.choiceSpentKey === key) return;
    this.choiceSpentKey = key;
    const intel = this.currentIntel();
    const field = this.knownField(intel, this.index + 1);
    if (field.length < 2) return;
    const currentFacts = intel.factsById.get(this.current.track.id) ?? null;
    const choice = this.brain.chooseNextTrack({
      current: currentFacts,
      field,
      arcPosition: (this.index + 1) / Math.max(1, this.queue.length - 1),
      curation: this.decisionSettingsValue?.curation,
    });
    if (!choice) return;
    this.lastTrackChoiceValue = choice;
    if (choice.trackId === field[0].trackId) return;
    const from = this.queue.findIndex(
      (track, i) => i > this.index && track.id === choice.trackId,
    );
    if (from < 0) return;
    const reordered = [...this.queue];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(this.index + 1, 0, moved);
    this.queue = reordered;
    this.queueGeneration += 1;
    this.choiceSpentKey = `${this.queueGeneration}:${this.index}`;
    usePlayerStore.getState().setQueue(this.queue);
  }

  /**
   * §3's second validation, run immediately before the decks are
   * told to load a track: the track must still stand at its slot
   * in the ACTIVE playlist (not removed, not replaced), must not
   * have failed preparation since it was chosen, and — for a
   * blend — must still be mixable. The first validation is the
   * chooser's field construction (known, unblocked, in-queue);
   * this is the re-check at the deck door.
   */
  private validateBeforeDeckLoad(
    prepared: PreparedTrack,
    index: number,
    options: { requireMixable: boolean },
  ): boolean {
    if (this.queue[index]?.id !== prepared.track.id) return false;
    if (this.failureBlocked(prepared.track.id)) return false;
    if (options.requireMixable && prepared.mixable === false) return false;
    return true;
  }

  /** Drops the horizon's first slot, promoting the second into it. */
  private evictNextSlot(): void {
    if (this.afterNext && this.afterNextIndex > this.index) {
      this.next = this.afterNext;
      this.nextIndex = this.afterNextIndex;
    } else {
      this.next = null;
      this.nextIndex = -1;
    }
    this.afterNext = null;
    this.afterNextIndex = -1;
  }

  /**
   * §34's resume-inspection: after any manual intervention the
   * session does not plan from what it ASSUMES the decks hold —
   * it reads the state it can actually verify (the live queue's
   * contents at the horizon's slots, the standing decision's
   * pair identity against the held tracks) and repairs what no
   * longer matches: stale slots are dropped for re-preparation,
   * and a decision whose pair is no longer the pair on the decks
   * is CANCELLED, never performed (§22's cancellation, spent
   * here). Runs at the head of the tick whenever the flag is
   * set, before any planning or committing.
   */
  private inspectStateBeforePlanning(): void {
    this.inspectionNeeded = false;
    if (!this.mixer || !this.current) return;
    let repaired = false;
    const slotStale = (prepared: PreparedTrack, index: number): boolean =>
      index <= this.index || this.queue[index]?.id !== prepared.track.id;
    if (this.next && slotStale(this.next, this.nextIndex)) {
      this.next = null;
      this.nextIndex = -1;
      repaired = true;
    }
    if (this.afterNext && slotStale(this.afterNext, this.afterNextIndex)) {
      this.afterNext = null;
      this.afterNextIndex = -1;
      repaired = true;
    }
    if (this.next && this.afterNext && this.nextIndex === this.afterNextIndex) {
      this.afterNext = null;
      this.afterNextIndex = -1;
      repaired = true;
    }
    if (this.decision) {
      const incomingHash = this.next?.analysis.audioHash ?? null;
      if (
        !this.next ||
        this.decision.recipe.fingerprints.bAudioHash !== incomingHash
      ) {
        this.decision = null;
        this.decisionInputs = null;
        repaired = true;
      }
    }
    if (repaired) void this.prepareNext();
  }

  /** The rate segment the playhead is currently inside. */
  private activeSegment(): RateSegment | null {
    if (!this.context || this.segments.length === 0) return null;
    const now = this.context.currentTime;
    let segment = this.segments[0];
    for (const candidate of this.segments) {
      if (candidate.fromCtxTime <= now) segment = candidate;
    }
    return segment;
  }

  /** The playback rate of the segment the playhead is inside. */
  private activeRate(): number {
    return this.activeSegment()?.rate ?? 1;
  }

  /**
   * Whether the buy-time loop may turn for the current track:
   * the track is mixable (a shell's cut needs no bought time),
   * its timeline runs at rate 1 (a rendition's buffer time is a
   * different timeline than the analysis's span arithmetic), its
   * landing's bound is unspent, a tail worth waiting for exists,
   * and the analysis names a grid-true loop span. A tail counts
   * as worth waiting for when ANY track remains beyond the
   * current one: a failure mark is a delay, not a verdict (Note
   * 24) — the first backoff step is 30 s, inside the loop's own
   * bought-time bound, so a momentarily blocked track is a
   * reason to loop and retry, not a reason to stop the set.
   */
  private buyTimeEligible(): boolean {
    if (!this.current || !this.mixer) return false;
    if (this.buyTime) return true;
    // The host's manual loop owns the deck's one loop region
    // while it turns (Addendum A: the hand stands) — the
    // buy-time loop never arms over it.
    if (this.manualLoop) return false;
    if (this.current.mixable === false) return false;
    if (this.index === this.buyTimeExhaustedIndex) return false;
    if (this.activeRate() !== 1) return false;
    if (this.index + 1 >= this.queue.length) return false;
    return buyTimeLoopSpan(this.current.analysis) !== null;
  }

  /** Arms the buy-time loop on the current deck; false when it cannot. */
  private armBuyTimeLoop(): boolean {
    if (!this.current || !this.mixer) return false;
    if (this.buyTime) {
      // Already turning: make sure its wrap bookkeeping is alive.
      if (!this.buyTime.scheduled) this.scheduleBuyTimeWrap(this.buyTime);
      return true;
    }
    const span = buyTimeLoopSpan(this.current.analysis);
    if (!span) return false;
    this.mixer.loopCurrentDeck(span.startSec, span.endSec);
    const state = {
      startSec: span.startSec,
      wraps: 0,
      boughtSec: 0,
      scheduled: false,
    };
    this.buyTime = state;
    this.scheduleBuyTimeWrap(state);
    return true;
  }

  /** Disarms the buy-time loop (the deck plays on linearly). */
  private disarmBuyTimeLoop(): void {
    if (!this.buyTime) return;
    this.buyTime = null;
    this.mixer?.clearCurrentDeckLoop();
  }

  /**
   * Schedules the bookkeeping for the loop's next wrap: when the
   * playhead reaches the track's end it wraps to the span start,
   * and the session's position segments must say so or every
   * position read afterwards is a lie. The check re-derives the
   * wrap moment from the audio clock, so a pause (which freezes
   * the clock, not the timer) simply reschedules the wrap.
   */
  private scheduleBuyTimeWrap(state: {
    startSec: number;
    wraps: number;
    boughtSec: number;
    scheduled: boolean;
  }): void {
    if (!this.context || !this.current) return;
    state.scheduled = true;
    const duration = this.current.buffer.duration;
    // The wrap moment, derived from the segment the playhead is
    // inside — exact, however late the timer itself is noticed.
    const segment = this.activeSegment();
    const wrapCtxTime = segment
      ? segment.fromCtxTime +
        (duration - segment.trackTimeAtStart) / segment.rate
      : this.context.currentTime;
    const delaySec = Math.max(0, wrapCtxTime - this.context.currentTime);
    this.after(delaySec * 1000, () => {
      state.scheduled = false;
      if (this.buyTime !== state || !this.context || !this.current) return;
      if (this.context.currentTime < wrapCtxTime - 0.05) {
        // The clock was frozen (a pause) while the timer ran:
        // the wrap has not happened yet — wait for it properly.
        this.scheduleBuyTimeWrap(state);
        return;
      }
      // The wrap: position integration restarts at the span start
      // from the wrap moment, so the playhead's track time stays
      // true while the deck repeats the tail.
      this.segments = [
        {
          fromCtxTime: wrapCtxTime,
          trackTimeAtStart: state.startSec,
          rate: 1,
        },
      ];
      state.wraps += 1;
      this.buyTimeWrapsTotal += 1;
      state.boughtSec += duration - state.startSec;
      if (
        state.wraps >= MAX_BUY_TIME_LOOPS ||
        state.boughtSec >= MAX_BUY_TIME_SEC
      ) {
        // The bound: the loop lets go NOW, at the wrap, so the
        // span plays out once linearly and the standing floor
        // meets the track's real end exactly as it always has.
        this.buyTimeExhaustedIndex = this.index;
        this.disarmBuyTimeLoop();
        return;
      }
      // Each wrap re-kicks the horizon: a preparation that was
      // still in flight — or a failure mark that has since
      // expired — gets its chance to land the next track and end
      // the wait early (Note 24).
      void this.prepareNext();
      this.scheduleBuyTimeWrap(state);
    });
  }

  /**
   * Refills the two-track horizon: the walks for both open slots
   * run CONCURRENTLY — each is deadline-bound per candidate (the
   * horizon's second walk starts after the first slot's known
   * index, or two past the current track when neither is known).
   * Landing order does not matter; adoptIntoHorizon sorts it out.
   * A pass that lands nothing new ends the refill (bounded), and a
   * settle-time promotion is just the sort doing its work: if only
   * the farther candidate landed, it sits in the first slot.
   */
  private async prepareNext(): Promise<void> {
    // R6: at a fresh landing with the first slot open, the brain
    // may choose which known tail track the horizon prepares
    // first; the choice reorders the tail (bumping the
    // generation), so it is spent BEFORE this pass captures its
    // anchors.
    this.spendTrackChoiceIfNeeded();
    const anchorIndex = this.index;
    const generation = this.queueGeneration;
    for (let pass = 0; pass < 3; pass += 1) {
      if (this.index !== anchorIndex || this.queueGeneration !== generation) {
        return;
      }
      const claimed = this.horizonIndices();
      const walks: Promise<{
        prepared: PreparedTrack;
        index: number;
      } | null>[] = [];
      if (!this.next) {
        walks.push(this.findNextPlayable(anchorIndex + 1, claimed));
      }
      if (!this.afterNext) {
        const secondFrom =
          (this.nextIndex >= 0 ? this.nextIndex : anchorIndex + 1) + 1;
        walks.push(this.findNextPlayable(secondFrom, claimed));
      }
      if (walks.length === 0) return;
      // Each walk adopts its landing THE MOMENT it lands — the
      // first slot must never wait on the second slot's slowest
      // candidate (a hanging second candidate would otherwise
      // hold the imminent join hostage until its deadline).
      const tracked = walks.map((walk) =>
        walk.then((found) => {
          if (!found) return false;
          if (
            this.index !== anchorIndex ||
            this.queueGeneration !== generation
          ) {
            return false;
          }
          const before = `${this.nextIndex}:${this.afterNextIndex}`;
          this.adoptIntoHorizon(found);
          return `${this.nextIndex}:${this.afterNextIndex}` !== before;
        }),
      );
      const adopted = (await Promise.all(tracked)).some(Boolean);
      if (this.index !== anchorIndex || this.queueGeneration !== generation) {
        return;
      }
      if (!adopted) return;
    }
  }

  /**
   * Horizon adoption at a landing: the second slot, when it holds
   * a track beyond the one just landed, becomes the next track —
   * no re-preparation — and the horizon refills behind it. A stale
   * second slot (at or before the landed index) is dropped.
   */
  private adoptHorizonAfterLanding(landedIndex: number): void {
    if (this.afterNext && this.afterNextIndex > landedIndex) {
      this.next = this.afterNext;
      this.nextIndex = this.afterNextIndex;
    } else {
      this.next = null;
      this.nextIndex = -1;
    }
    this.afterNext = null;
    this.afterNextIndex = -1;
  }

  /**
   * The current track has ended and nothing mix-ready is waiting:
   * the fallback floor. Walk forward to the next track that can be
   * prepared at all and cut straight to it — a plain cut, no blend —
   * rather than letting one dead or slow track end the whole
   * session. The cut is counted as the fallback it is. Only a queue
   * with nothing playable left in it ends the session here, and
   * that end is announced with its reason (guarantees 3 and 7).
   */
  private advancePastTrackEnd(): void {
    if (this.endAdvanceInFlight) return;
    const anchorIndex = this.index;
    // The horizon first: if its second slot already holds a
    // prepared track, that track is the floor's answer — promote
    // and cut to it (counted) instead of walking in silence for
    // what the horizon already knows (Note 20).
    if (
      this.mixer &&
      this.current &&
      !this.next &&
      this.afterNext &&
      this.afterNextIndex > anchorIndex
    ) {
      const beyond = this.afterNext;
      const beyondIndex = this.afterNextIndex;
      // §3 at the floor's door too: a promoted track that no
      // longer stands in the playlist (or has since failed) is
      // dropped, and the walk below finds the floor's own answer.
      if (
        !this.validateBeforeDeckLoad(beyond, beyondIndex, {
          requireMixable: false,
        })
      ) {
        this.afterNext = null;
        this.afterNextIndex = -1;
      } else {
        try {
          this.notePlainCutFallback();
          this.clearTimers();
          this.mixer.stopAll();
          this.beginTrack(beyond, beyondIndex);
          return;
        } catch {
          // A promotion that throws part-way must not die inside
          // the floor (Note 21): fall through to the walk, which
          // finds its own answer or ends the set honestly.
        }
      }
    }
    this.endAdvanceInFlight = true;
    const walkGeneration = this.queueGeneration;
    void this.findNextPlayable(anchorIndex + 1)
      .then((found) => {
        if (!this.mixer || !this.current || this.index !== anchorIndex) return;
        if (!found) {
          // Note 24: the walk DISCARDS itself (returns null)
          // when the queue generation moved under it — a rebuild
          // by curation, requests, or the track choice is not
          // exhaustion. Reading that discard as "nothing left"
          // stopped sets with playable tracks still listed, so a
          // discarded walk re-runs the floor once the latch
          // releases instead of ending the set.
          if (this.queueGeneration !== walkGeneration) {
            this.floorRetryAfterDiscard = true;
            return;
          }
          usePlayerStore.getState().setStatus("idle");
          showToast(
            "The set ended — nothing playable was left in the queue.",
            "error",
          );
          this.stop("queue-exhausted");
          return;
        }
        this.notePlainCutFallback();
        this.clearTimers();
        this.mixer.stopAll();
        this.beginTrack(found.prepared, found.index);
      })
      .catch(() => {
        // Belt and braces (Note 21): the walk is built never to
        // reject, but if one ever did, the failure is counted
        // through the degradation honesty — never swallowed — and
        // the finally below still releases the latch, so the next
        // tick's floor (or the watchdog) retries instead of the
        // set wedging in silence.
        this.notePlainCutFallback();
      })
      .finally(() => {
        // The latch releases on EVERY settle — fulfilment,
        // rejection, anything. Its reset used to live only in the
        // fulfilment handler; that single missing path is the
        // prime suspect for the field wedge this note answers.
        this.endAdvanceInFlight = false;
        // A walk discarded by a mid-walk queue rebuild re-runs
        // the floor against the rebuilt queue (Note 24) — but
        // only while this landing still owns the floor.
        if (
          this.floorRetryAfterDiscard &&
          this.mixer &&
          this.current &&
          this.index === anchorIndex
        ) {
          this.floorRetryAfterDiscard = false;
          this.advancePastTrackEnd();
        }
      });
  }

  /** Counts a fallback plain cut; crossing the threshold announces it. */
  private notePlainCutFallback(): void {
    this.plainCutFallbacks += 1;
    if (
      this.plainCutFallbacks >= PLAIN_CUT_ANNOUNCE_THRESHOLD &&
      !this.degradationAnnounced
    ) {
      this.degradationAnnounced = true;
      showToast(
        "Mixing is degraded tonight — some joins are plain cuts because tracks could not be prepared in time.",
        "error",
      );
    }
  }

  // -------------------------------------------------------------------
  // The brain loop: consider, revise, commit, complete
  // -------------------------------------------------------------------

  private positionNow(): number {
    if (!this.context || this.segments.length === 0) return 0;
    const now = this.context.currentTime;
    let segment = this.segments[0];
    for (const candidate of this.segments) {
      if (candidate.fromCtxTime <= now) segment = candidate;
    }
    return (
      segment.trackTimeAtStart + (now - segment.fromCtxTime) * segment.rate
    );
  }

  /**
   * (Re)considers the join for the playing pair. The decision is
   * revised whenever its inputs change — either analysis replaced
   * (the outgoing's outro arrived, deepened: Req 1's latch) or the
   * room spoke (signals changed the weights) — and only then: an
   * unchanged pair under unchanged readings keeps its decision.
   * One exception: once a decision's anchor is imminent, the join
   * is effectively in the DJ's hands and is NOT re-planned — a
   * fresh authoring that close to the anchor could only push it
   * away (the author's minimum lead), stranding a good plan.
   */
  private considerJoin(position: number): void {
    // The manual control level: the brain does not author. The
    // host's hands rule the decks; only the floor beneath this
    // method (the tick's end branch) still stands.
    if (this.controlLevelValue === "manual") return;
    if (!this.current || !this.next) return;
    // A playable shell (decoded, not analysed) can be played
    // plainly but never blended: no join is considered into or out
    // of one — the pair falls to the counted plain-cut floor at
    // the track end instead (Note 20).
    if (this.current.mixable === false || this.next.mixable === false) return;
    // The minimum-play floor (Note 19, ruling 1) is NOT gated
    // here: it is an anchor veto inside the brain's consider()
    // (no candidate whose overlap starts before the outgoing's
    // first big section has played is eligible). Planning opens
    // on the standing window and decisions are authored and
    // revised freely — the floor binds the moment the DJ moves
    // on, which is the anchor, not the planning.
    if (this.decision) {
      const anchorMs = this.decision.recipe.overlap.startAMs;
      if (
        anchorMs !== null &&
        anchorMs / 1000 - position <= COMMIT_HORIZON_SEC + 0.35
      ) {
        return; // imminent: the standing decision owns this join
      }
    }
    const inputs = {
      outgoingAnalysis: this.current.analysis as unknown,
      incomingAnalysis: this.next.analysis as unknown,
      signalEvents: this.brain.signals.journal().length,
    };
    const previous = this.decisionInputs;
    if (
      this.decision &&
      previous &&
      previous.outgoingAnalysis === inputs.outgoingAnalysis &&
      previous.incomingAnalysis === inputs.incomingAnalysis &&
      previous.signalEvents === inputs.signalEvents
    ) {
      return;
    }
    this.decisionInputs = inputs;
    // A join sits between its two tracks: its arc position is the
    // midpoint of the outgoing's and the incoming's slots in the
    // set (the first join of a long set is an opening join; the
    // only join of a two-track set is a mid-set join).
    const arcPosition =
      (this.index + this.nextIndex) / (2 * Math.max(1, this.queue.length - 1));
    // The planner reads the pair through the standing tempo
    // biases (the engine seams): at neutral bias these are the
    // prepared tracks themselves, untouched.
    const pair = this.biasedPair();
    if (!pair) return;
    this.decision = this.brain.consider(
      {
        outgoing: pair.outgoing,
        outgoingPositionSec: position,
        incoming: pair.incoming,
      },
      arcPosition,
    );
    this.noteStretchNeed();
    if (this.decision) this.maybeCommit(position);
  }

  /**
   * Declares the standing decision's stretch need to preparation:
   * a recipe carrying stretchB gets its rendition of the incoming
   * track rendering NOW, in the background — the session never
   * awaits it (the commit reads readiness, and the fallback floor
   * covers a rendition that is not ready in time). A decision that
   * needs no rendition, or none at all, clears the request; a
   * re-decision for the same track at the same factor keeps the
   * render already in flight.
   */
  private noteStretchNeed(): void {
    const stretchB = this.decision?.recipe.overlap.stretchB ?? null;
    if (stretchB === null || !this.next) {
      this.renditionRequest = null;
      return;
    }
    const incoming = this.next;
    const existing = this.renditionRequest;
    if (
      existing &&
      existing.trackId === incoming.track.id &&
      existing.factor === stretchB
    ) {
      return;
    }
    const cached = stretchRendition(incoming.track.id, stretchB);
    const request = {
      trackId: incoming.track.id,
      factor: stretchB,
      buffer: cached ?? null,
    };
    this.renditionRequest = request;
    if (cached) return;
    void loadStretchRendition(incoming, stretchB).then((buffer) => {
      // A superseded request's render still lands in the rendition
      // cache (bounded, and the next pair may want it) — it just no
      // longer speaks for this session's standing decision.
      if (this.renditionRequest !== request) return;
      request.buffer = buffer;
    });
  }

  /** Commits the current decision when its anchor is upon us. */
  private maybeCommit(position: number): void {
    const decision = this.decision;
    if (!decision) return;
    const startAMs = decision.recipe.overlap.startAMs;
    if (startAMs === null) return; // authored recipes always anchor; defensive
    if (startAMs / 1000 - position <= COMMIT_HORIZON_SEC) {
      this.commitDecision();
    }
  }

  /**
   * Performs the decision through the executor. leadInSec — the one
   * field of a recipe that describes the CALL, not the music — is
   * re-stamped to the true gap between now and the overlap anchor,
   * so the executor starts the overlap on its anchor, not on the
   * (earlier) authoring moment. After this call the join is locked:
   * no signal, request or re-plan may alter it (may-not rule).
   */
  private commitDecision(): void {
    const decision = this.decision;
    if (!decision || !this.mixer || !this.context) return;
    if (!this.current || !this.next) return;
    const incoming = this.next;
    const landedIndex = this.nextIndex;
    const startAMs = decision.recipe.overlap.startAMs;
    const position = this.positionNow();
    const leadInSec =
      startAMs !== null
        ? Math.max(0, startAMs / 1000 - position)
        : decision.recipe.leadInSec;
    const recipe: TransitionRecipe =
      leadInSec === decision.recipe.leadInSec
        ? decision.recipe
        : { ...decision.recipe, leadInSec };
    // No minimum-play re-gate here (Note 19, ruling 1): the
    // brain's anchor veto already guarantees the recipe's
    // overlap starts at or after the floor, and a commit fires
    // up to the horizon BEFORE its anchor precisely so the
    // audible overlap begins AT the anchor — re-gating the call
    // would break ripe commits without protecting anything.
    // A stretch recipe performs against the RENDITION, never the
    // original buffer — the two are different timelines, and a
    // mismatch would start B at the wrong musical point at the
    // wrong tempo. If the rendition is not ready, the commit does
    // not happen: the decision stands and the tick retries it
    // until its anchor passes, where the end branch drops it and
    // the fallback floor fires (a counted plain cut) — never a
    // forced blend, the floor's standing rule.
    let performBuffer = incoming.buffer;
    const stretchB = recipe.overlap.stretchB;
    if (stretchB !== null) {
      const request = this.renditionRequest;
      const ready =
        request &&
        request.trackId === incoming.track.id &&
        request.factor === stretchB
          ? request.buffer
          : (stretchRendition(incoming.track.id, stretchB) ?? null);
      if (!ready) return;
      performBuffer = ready;
    }
    // §3's second validation, at the deck door: the incoming
    // must still stand in the active playlist at its slot, still
    // be unblocked by any failure since, still be mixable. A
    // track that stopped qualifying after the decision was made
    // kills the decision — the slot is evicted and a fresh
    // choice and preparation run; the decks are never told to
    // load a track the playlist no longer offers.
    if (
      !this.validateBeforeDeckLoad(incoming, landedIndex, {
        requireMixable: true,
      })
    ) {
      this.decision = null;
      this.decisionInputs = null;
      this.evictNextSlot();
      void this.prepareNext();
      return;
    }
    // Performing ends any buy-time loop: the outgoing must play
    // linearly into the blend the recipe describes.
    this.disarmBuyTimeLoop();
    // Performing also ends the host's manual loop and roll: from
    // the blend's start the executor owns the decks, and a
    // standing roll send or loop region would fight the recipe's
    // own choreography (the engine seams).
    this.disarmManualLoop();
    this.releaseManualRoll();
    this.decision = null;
    this.decisionInputs = null;
    const commitCtxTime = this.context.currentTime;
    const times = this.mixer.performRecipe(performBuffer, recipe, {
      levelGain: levelGainFor(incoming.analysis.loudness),
      outgoing: this.current.analysis,
      incoming: incoming.analysis,
    });
    this.beginBlendLanding(
      incoming,
      landedIndex,
      times,
      this.segmentsForRecipe(recipe, times),
      decision,
      position + Math.max(0, times.blendStartCtxTime - commitCtxTime),
    );
  }

  /**
   * Executes a legacy TransitionPlan through the mixer's preserved
   * plan seam (the executor adapts it to a recipe at the decks, so
   * one code path still touches the audio). Session v2's own commits
   * flow through commitDecision; this path remains for the plan
   * artefact's other callers and is pinned by the Step 2 regression
   * suite's blend-landing contract.
   */
  private executeTransition(plan: TransitionPlan): void {
    if (!this.mixer || !this.next || !this.context || !this.current) return;
    // A performance ends the host's manual loop and roll, as in
    // commitDecision: the executor owns the decks from here.
    this.disarmManualLoop();
    this.releaseManualRoll();
    const incoming = this.next;
    const landedIndex = this.nextIndex;
    const recipe = recipeFromPlan(plan, {
      beatsPerBarA: this.current.analysis.beatMap.beatsPerBar,
    });
    const commitCtxTime = this.context.currentTime;
    const times = this.mixer.transitionTo(
      incoming.buffer,
      plan,
      levelGainFor(incoming.analysis.loudness),
    );
    this.beginBlendLanding(
      incoming,
      landedIndex,
      times,
      this.segmentsForRecipe(recipe, times),
      null,
      this.positionNow() + Math.max(0, times.blendStartCtxTime - commitCtxTime),
    );
  }

  /**
   * Arms the one owner of a sounding join's completion (guarantee
   * 6): the callback fires only if its token is still the active
   * join's, so a superseded or interrupted join can never land
   * twice, land late, or land on the wrong track.
   */
  private beginBlendLanding(
    incoming: PreparedTrack,
    landedIndex: number,
    times: { blendStartCtxTime: number; blendEndCtxTime: number },
    pendingSegments: RateSegment[],
    decision: BrainDecision | null,
    heardLengthSec: number,
  ): void {
    if (!this.context) return;
    const token = ++this.joinTokenCounter;
    this.activeJoin = {
      token,
      decision,
      incoming,
      landedIndex,
      pendingSegments,
      heardLengthSec,
    };
    this.onBlendChange?.(true);
    const delayMs = Math.max(
      0,
      (times.blendEndCtxTime - this.context.currentTime) * 1000,
    );
    this.after(delayMs, () => {
      if (this.activeJoin?.token !== token) return;
      this.completeJoin();
    });
  }

  /** The completion: lands exactly once, on the incoming, at its index. */
  private completeJoin(): void {
    const join = this.activeJoin;
    if (!join) return;
    this.activeJoin = null;
    this.onBlendChange?.(false);
    // The outgoing leaves as a completion (taste + signal), read
    // against its own segments before they are swapped out.
    this.noteOutgoingLeft(true);
    if (join.decision) {
      this.brain.recordPerformed(join.decision, {
        heardLengthSec: join.heardLengthSec,
        // §28: the join completed as authored; its evaluation is
        // written into history here, loudness read from the pair
        // the decks actually met.
        outcome: {
          interrupted: false,
          loudnessContinuity: this.current
            ? loudnessContinuityBetween(this.current, join.incoming)
            : undefined,
        },
      });
      this.brain.signals.record({
        kind: "blend-completed",
        family: join.decision.candidate.family,
      });
      this.deliveredBy.set(
        join.incoming.track.id,
        join.decision.candidate.family,
      );
    }
    this.segments = join.pendingSegments;
    this.current = join.incoming;
    this.liveRavePlayedTrackIds.add(join.incoming.track.id);
    this.index = join.landedIndex;
    this.adoptHorizonAfterLanding(join.landedIndex);
    const store = usePlayerStore.getState();
    store.setCurrentTrack(join.incoming.track, this.index);
    store.setDuration(
      join.incoming.track.durationMs ??
        Math.round(join.incoming.buffer.duration * 1000),
    );
    void this.prepareNext();
  }

  /**
   * A sounding join cut short — by a skip, a seek, a stop. The join
   * still happened as far as the room is concerned: it is recorded
   * with the heard length it actually got, and the interruption is
   * laid against its family as a signal. Exactly-once holds here
   * too: the completion callback's token no longer matches.
   */
  private finaliseInterruptedJoin(): void {
    const join = this.activeJoin;
    if (!join) return;
    this.activeJoin = null;
    this.onBlendChange?.(false);
    if (join.decision) {
      this.brain.recordPerformed(join.decision, {
        heardLengthSec: Math.max(0, this.positionNow()),
        // §28: an interrupted join is still evaluated — its
        // execution grade says it was cut short, and that grade
        // is what later selections are shaped by.
        outcome: {
          interrupted: true,
          loudnessContinuity: this.current
            ? loudnessContinuityBetween(this.current, join.incoming)
            : undefined,
        },
      });
      this.brain.signals.record({
        kind: "blend-interrupted",
        family: join.decision.candidate.family,
      });
    }
  }

  /**
   * Position segments for the incoming after a performed recipe:
   * the rateB curve integrated piecewise (trapezoid means), so the
   * session's position tracking follows the same curve the decks
   * are automating, landing at rate 1 when the curve settles.
   */
  private segmentsForRecipe(
    recipe: TransitionRecipe,
    times: { blendStartCtxTime: number; blendEndCtxTime: number },
  ): RateSegment[] {
    const startBSec = recipe.overlap.startBMs / 1000;
    // Stretch mode: the deck plays the rendition at rate 1, so in
    // the track's own (original) time — the timeline every position
    // in this session is read in — the playhead advances at the
    // stretch factor, for the whole track. There is no settling
    // segment after the blend: the rendition IS at tempo, and no
    // rate return exists to model.
    const stretchB = recipe.overlap.stretchB;
    if (stretchB !== null && stretchB > 0) {
      return [
        {
          fromCtxTime: times.blendStartCtxTime,
          trackTimeAtStart: startBSec,
          rate: stretchB,
        },
      ];
    }
    const curve = recipe.automation.rateB;
    if (!curve || curve.points.length === 0) {
      return [
        {
          fromCtxTime: times.blendStartCtxTime,
          trackTimeAtStart: startBSec,
          rate: 1,
        },
      ];
    }
    const spanMs = Math.max(
      recipe.overlap.durationMs,
      curve.points[curve.points.length - 1].atMs,
    );
    const sampleSet = new Set<number>([0, spanMs]);
    for (const point of curve.points) {
      if (point.atMs > 0 && point.atMs < spanMs) sampleSet.add(point.atMs);
    }
    const samples = [...sampleSet].sort((a, b) => a - b);
    const segments: RateSegment[] = [];
    let integralSec = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const t0 = samples[i];
      const t1 = samples[i + 1];
      let rate: number;
      if (t1 !== undefined) {
        const mean =
          (automationValueAt(curve, t0) + automationValueAt(curve, t1)) / 2;
        rate = mean;
        segments.push({
          fromCtxTime: times.blendStartCtxTime + t0 / 1000,
          trackTimeAtStart: startBSec + integralSec,
          rate,
        });
        integralSec += (mean * (t1 - t0)) / 1000;
      } else {
        rate = automationValueAt(curve, t0);
        segments.push({
          fromCtxTime: times.blendStartCtxTime + t0 / 1000,
          trackTimeAtStart: startBSec + integralSec,
          rate,
        });
      }
    }
    const last = segments[segments.length - 1];
    if (last && last.rate !== 1) {
      segments.push({
        fromCtxTime: times.blendStartCtxTime + spanMs / 1000,
        trackTimeAtStart: startBSec + integralSec,
        rate: 1,
      });
    }
    return segments;
  }

  // -------------------------------------------------------------------
  // Party reactions: the party ear reaches the brain through the
  // party store (the channel partyHost already publishes to).
  // -------------------------------------------------------------------

  private subscribePartyReactions(): void {
    this.unsubscribePartyReactions();
    const total = (reactions: { fire: number; heart: number; clap: number }) =>
      reactions.fire + reactions.heart + reactions.clap;
    let lastTotal = total(usePartyStore.getState().reactions);
    this.partyUnsubscribe = usePartyStore.subscribe((state) => {
      const nextTotal = total(state.reactions);
      const delta = nextTotal - lastTotal;
      lastTotal = nextTotal;
      if (!state.open || delta <= 0) return;
      // A burst is one moment of excitement, not fifty opinions:
      // the bank's rate windows read the count, capped per snapshot.
      const events = Math.min(delta, 50);
      for (let i = 0; i < events; i += 1) {
        this.brain.signals.record({ kind: "party-reaction" });
      }
    });
  }

  private unsubscribePartyReactions(): void {
    this.partyUnsubscribe?.();
    this.partyUnsubscribe = null;
  }

  // -------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------

  private tick(): void {
    if (!this.current || !this.context) return;
    const store = usePlayerStore.getState();

    if (store.volume !== this.lastVolume && this.mixer) {
      const previousVolume = this.lastVolume;
      this.lastVolume = store.volume;
      this.mixer.master.gain.value = store.volume;
      // Volume moves are signals (weak ones): up is engagement,
      // down is drift. The first reading after start is not a move.
      if (previousVolume >= 0) {
        this.brain.signals.record({
          kind: store.volume > previousVolume ? "volume-up" : "volume-down",
        });
      }
    }

    const position = this.positionNow();
    const duration = this.current.buffer.duration;
    // The store never shows a position past the current track's
    // own length (Note 21): positionNow is a clock integration and
    // keeps counting while the floor recovers an overrun, but the
    // display sits AT the end of the finished song, not beyond it.
    store.setPosition(
      Math.min(
        Math.max(0, Math.round(position * 1000)),
        Math.max(0, Math.round(duration * 1000)),
      ),
    );
    const remaining = duration - position;

    // §34: a flagged intervention is inspected before anything
    // else this tick does — planning, committing and the floor
    // all read the inspected state, never the stale assumption.
    if (this.inspectionNeeded) this.inspectStateBeforePlanning();

    if (remaining <= 0.05) {
      // Guarantee 6: while a blend is sounding, its completion owns
      // the landing — the end branch must not fire underneath it.
      if (this.activeJoin) return;
      if (this.decision) {
        const startAMs = this.decision.recipe.overlap.startAMs;
        if (startAMs !== null && position <= startAMs / 1000 + 1) {
          // The decision's moment is here: perform it rather than
          // cutting past it.
          this.commitDecision();
          if (!this.decision) return;
          // The decision stands but could not be performed — its
          // pitch-preserved rendition is still rendering. Buy it
          // time with the loop (Note 19, ruling 2): the playhead
          // wraps, the same decision window comes round again,
          // and the commit is retried as the anchor nears. If the
          // loop cannot turn, the standing retry cadence applies.
          if (this.buyTimeEligible()) this.armBuyTimeLoop();
          return;
        }
        // Its moment has passed unperformed; do not perform a ghost.
        this.decision = null;
        this.decisionInputs = null;
      }
      // Note 21 watchdog: the position has run well past the end
      // and the floor below is supposedly already recovering it —
      // the end-advance latch is still held. A settled walk
      // releases that latch in its finally, so a latch held past
      // this margin belongs to a walk that will never settle:
      // presume it dead, clear the latch, count the rescue through
      // the degradation honesty, and let the floor run again. At
      // most once per track (a rescued floor that wedges again on
      // the same track is a deeper fault than this watchdog claims
      // to fix). The extra walk this can rarely start alongside a
      // slow-but-live one is safe: the stale walk discards itself
      // on the anchor and generation guards, and the track source
      // dedupes loads the two walks share.
      if (
        position - duration > WATCHDOG_OVERRUN_SEC &&
        this.endAdvanceInFlight &&
        this.index !== this.watchdogRescuedIndex
      ) {
        this.watchdogRescuedIndex = this.index;
        this.endAdvanceInFlight = false;
        this.notePlainCutFallback();
      }
      if (this.next) {
        // §3 at the cut's door: a waiting next that no longer
        // stands in the playlist (or has since failed) is
        // evicted and re-prepared, never cut to.
        if (
          !this.validateBeforeDeckLoad(this.next, this.nextIndex, {
            requireMixable: false,
          })
        ) {
          this.evictNextSlot();
          void this.prepareNext();
          return;
        }
        // A pair the brain could not join: the floor, announced.
        this.notePlainCutFallback();
        this.skipNext();
      } else if (this.buyTimeEligible()) {
        // Nothing mix-ready is waiting, but a tail worth waiting
        // for is still preparing: loop the current song's tail on
        // its beat grid to buy that preparation its time (Note
        // 19, ruling 2) instead of cutting at the end. The
        // horizon keeps filling while the loop turns; when the
        // bound is spent, the loop lets go and this branch falls
        // to the floor below at the real end, exactly as before.
        this.armBuyTimeLoop();
        void this.prepareNext();
      } else {
        // No mix-ready track is waiting — but that is a reason to
        // cut plainly to the next playable track, not to end the
        // session. One dead or merely slow track must never kill
        // the night; only an exhausted queue does.
        this.advancePastTrackEnd();
      }
      return;
    }

    // A sounding blend is locked: no re-planning underneath it.
    if (this.activeJoin) return;
    if (!this.next) {
      this.decision = null;
      this.decisionInputs = null;
      return;
    }
    if (remaining > PLAN_WHEN_REMAINING_SEC) return;
    this.considerJoin(position);
    // The decision may have ripened between consider and now.
    if (this.decision) this.maybeCommit(position);
  }

  private after(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

/** The shared session used by the app. */
export const djSession = new DjSession();

// The DJ-master tap registration for the greeting visualizer.
// This registration is why djSession imports the greeting lib —
// an allowed crossing; no greeting file is edited by this slice.
// Deliberate adaptation from the tap-prep report's line: that
// line calls djSession.isRunning() as a function, but the
// session's standing public API is the isRunning GETTER (pinned
// by DjStageView and the session suites, which must pass
// unmodified), so the truth function reads the getter instead.
// The registration's shape, id and priority are exactly as
// contracted in the tap-prep report.
registerVisualizerTap(
  createAnalyserTap(
    VISUALIZER_TAP_ID.DJ_MASTER,
    () => djSession.masterAnalyser(),
    () => djSession.isRunning,
  ),
  VISUALIZER_TAP_PRIORITY.DJ_MASTER,
);
