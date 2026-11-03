import type { Track } from "@/shared/types";
import { showToast } from "@/shared/ui/Toast";
import { labelsForTrack } from "../../genres/trackGenres";
import { usePlayerStore } from "../../player/store/playerStore";
import { usePartyStore } from "../store/partyStore";
import { DjBrain, type BrainDecision } from "./brain";
import {
  assembleSet,
  candidateFromAnalysis,
  chooseArcShape,
} from "./curatedSet";
import { levelGainFor } from "./levelMatch";
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
    this.mixer?.setCrossfade(position);
  }

  setDeckTrim(index: DeckIndex, level: number): void {
    this.mixer?.setDeckTrim(index, level);
  }

  setDeckBassCut(index: DeckIndex, cut: boolean): void {
    this.mixer?.setDeckBassCut(index, cut);
  }

  setDeckEq(index: DeckIndex, band: "bass" | "mid" | "high", db: number): void {
    this.mixer?.setDeckEq(index, band, db);
  }

  setDeckFilter(index: DeckIndex, hz: number): void {
    this.mixer?.setDeckFilter(index, hz);
  }

  setCrossfaderCurve(curve: StageCrossfaderCurve): void {
    this.mixer?.setCrossfaderCurve(curve);
  }

  setFxAssign(kind: StageEffectKind, assign: StageFxAssign): void {
    this.mixer?.setManualFxAssign(kind, assign);
  }

  setFxSendLevel(kind: StageEffectKind, side: "A" | "B", level: number): void {
    this.mixer?.setManualFxSend(kind, side, level);
  }

  /** The mixer's master analyser for taps, or null when no session runs. */
  masterAnalyser(): AnalyserNode | null {
    return this.mixer?.masterAnalyser() ?? null;
  }

  /**
   * The stage snapshot (Build 2A contract): the mixer's current
   * readings assembled read-only — this never mutates session
   * state. Null when there is no mixer (no session running).
   */
  stageSnapshot(): StageSnapshot | null {
    if (!this.mixer) return null;
    const mixer = this.mixer;
    return {
      decks: [
        {
          ...mixer.stageDeckReadings(0),
          meter: mixer.deckMeterSummary(0),
        },
        {
          ...mixer.stageDeckReadings(1),
          meter: mixer.deckMeterSummary(1),
        },
      ],
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
    };
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
    this.watchdogRescuedIndex = -1;
    this.segments = [];
    this.decision = null;
    this.decisionInputs = null;
    this.renditionRequest = null;
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
    this.endAdvanceInFlight = true;
    void this.findNextPlayable(anchorIndex + 1)
      .then((found) => {
        if (!this.mixer || !this.current || this.index !== anchorIndex) return;
        if (!found) {
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
    if (!this.current || !this.next) return;
    // A playable shell (decoded, not analysed) can be played
    // plainly but never blended: no join is considered into or out
    // of one — the pair falls to the counted plain-cut floor at
    // the track end instead (Note 20).
    if (this.current.mixable === false || this.next.mixable === false) return;
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
    this.decision = this.brain.consider(
      {
        outgoing: this.current,
        outgoingPositionSec: position,
        incoming: this.next,
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
        // A pair the brain could not join: the floor, announced.
        this.notePlainCutFallback();
        this.skipNext();
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
