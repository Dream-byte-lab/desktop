// session.ts — the liveRave session: the integrating state machine
// (design §3.8). A new engine, designed from the contract and the
// music; it imports NOTHING from src/features/mixer/engine/ or the
// old store/ or ui/.
//
// The session owns one night: a queue, a current track sounding on
// deck A of the performer, a background preparation pipeline
// (source → supply → facts, buffers decoded ahead), a 250 ms
// decision loop that asks the brain for the next join once the
// playing track enters its planning horizon, and the honesty
// machinery around every way a join can fail — buy-time on an
// unprepared draw, plain cuts ONLY as recorded terminal fallbacks,
// degradations named in the behaviour record and the activity
// feed, never silent.
//
// Contract points the rest of the app leans on:
// - The DjTransport surface (transport.ts) is implemented exactly:
//   isRunning / isPaused / pause / resume / skipNext / skipPrevious
//   / seekTo / stop. The plain player's router offers commands here
//   first while a session runs.
// - Note 32 identity validation: a session NEVER opens on a
//   foreign track. Start realigns to the player store's actual
//   current track when the passed queue/index disagrees, and says
//   so in the feed; resume re-validates the same way and ends
//   "replaced" rather than resuming over someone else's pick.
// - Note 33 minimum-play floor: AUTONOMOUS decisions wait until
//   the playing track has sounded past facts.minimumPlayMs. User
//   acts (skipNext / skipPrevious / triggerDeckMove) are exempt —
//   the floor binds the DJ, never the user.
// - End reasons are exactly "user-stop" | "queue-exhausted" |
//   "start-no-playable" | "replaced" (the intent wiring's
//   vocabulary, deletion map §3.3).
// - Exhaustion follows the player's repeat setting (Addendum B):
//   repeat-all cycles the queue with the arc intact; repeat-off
//   ends "queue-exhausted"; repeat-one declines to start at all —
//   the plain player owns that loop.
// - The master tap: on start, the performer's master analyser is
//   registered with the greeting visualizer's source registry
//   (deletion map §2.7 — a named requirement, not a side effect).
// - Start is a preparing phase, not a gate (fix-0119): start
//   goes live immediately on the player's current track, the
//   plain player keeps it audible while preparation runs, and
//   the decks take over at the first track whose preparation
//   lands with facts + a decoded buffer (mid-track at the
//   audible position, or at the boundary the plain player
//   reaches first). A start only fails — visibly, with the first
//   recorded failure reason on the startState/startFailure seam
//   — when every queued track's preparation has failed.
// - Volume: the session follows the player store's volume through
//   performer.setMasterGain (the router's fall-through design
//   assumes the session does this itself).
// - Playback-state publishing: while a set plays, the plain
//   player's element sits paused and nothing else writes the
//   store's timeline — so the session publishes it. On its own
//   250 ms tick it writes the sounding deck's position and the
//   current track's duration; on start / resume / pause / stop
//   and at every track change it writes the status too. The deck
//   whose position is published is always the deck carrying the
//   store's current track: the outgoing deck until a join's swap,
//   the incoming deck after it (swapRoles makes the incoming deck
//   side A, and setCurrentTrack moves to its track in the same
//   step), so during an overlap the published position is the
//   outgoing track's — the store's current track — honestly
//   progressing, and after the swap it is the incoming track's
//   position, already into the track by the overlap. Every
//   consumer that reads the store (MiniPlayer, FocusMode, the
//   pop-out overlay, KawarpWrapper, mediaClock's lyrics clock)
//   therefore reads live state for the whole set. Publishing is
//   best-effort: a store write that throws never breaks the set.
//
// DOCUMENTED SIMPLIFICATIONS (named, per the wave brief):
// - Seek during a sounding join: the incoming deck is cancelled
//   back to single-deck playback. A join's automation is scheduled
//   against the outgoing's position; after a seek it no longer
//   describes reality, so the join is abandoned honestly (feed +
//   preview cleared) rather than performed fictitiously.
// - Party scope: guest requests are data weighed by the brain's
//   track fit (party.ts), exposed in the engine's own terms —
//   submitGuestRequest / evaluateRequests / guestStatus /
//   setDoNotPlay / liveRaveOpenRequests. There is deliberately NO
//   compatibility shim for the old party host's member names; the
//   fresh party surface is written against this seam.
// - Position during a join is the performer's NOMINAL position
//   (loop/scratch blocks are not sample-accurate there), so join
//   completion is judged against the recipe's exit anchor plus the
//   overlap span on the outgoing's grid — the same nominal clock
//   the performer plans against.

import type { Track } from "@/shared/types";
import {
  createAnalyserTap,
  registerVisualizerTap,
  VISUALIZER_TAP_ID,
  VISUALIZER_TAP_PRIORITY,
} from "@/features/greeting/lib/visualizerSource";
import {
  usePlayerStore,
  type PlayerCommand,
  type PlayerStatus,
} from "@/features/player/store/playerStore";
import { authorCandidates, fxKindsOfRecipe } from "./authors";
import {
  createBrain,
  trackFitFor,
  type Brain,
  type ConsiderResult,
} from "./brain";
import { buildTrackFacts, type TrackFacts, type TrackRead } from "./facts";
import { trackEnergyLevel } from "./kernel";
import {
  createBehaviourLog,
  createPerformanceMemory,
  type BehaviourLog,
  type BehaviourRecord,
  type BehaviourReason,
  type PerformanceMemory,
} from "./memory";
import { LiveRavePerformer, type DeckSnapshot } from "./performer";
import {
  createPartyScheduler,
  type GuestRequest,
  type GuestRequestStatus,
  type PartyScheduler,
} from "./party";
import { validateRecipe, type JoinRecipe } from "./recipe";
import { NEUTRAL_SHAPING, type Shaping } from "./shaping";
import {
  createTrackSource,
  type DecodeContext,
  type TrackSource,
  type TrackSourceDeps,
} from "./source";
import { appendBehaviour, listBehaviour } from "./storage";
import { useDjSettings } from "./settings";
import {
  createServerClient,
  createSupply,
  type ContributionOutcome,
  type ContributionStatus,
  type PairDocument,
  type ServerClient,
  type Supply,
} from "./supply";
import type { DjTransport } from "./transport";

// ---------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------

export type SessionEndReason =
  "user-stop" | "queue-exhausted" | "start-no-playable" | "replaced";

/**
 * The start attempt's visible state (fix-0119): a start is no
 * longer a silent gate. "starting" covers the preparing phase —
 * the session is live, the plain player keeps the current track
 * audible, and the decks take over at the first ready track.
 * "failed" carries startFailure: the first preparation failure
 * the attempt recorded, verbatim from the failed entry.
 */
export type SessionStartState = "idle" | "starting" | "ready" | "failed";

export type ControlLevel = "autonomous" | "assisted" | "manual";

export type ActivityKind =
  | "started"
  | "corrected"
  | "preparing"
  | "prepared"
  | "authoring"
  | "drawn"
  | "performing"
  | "buy-time"
  | "degraded"
  | "fallback"
  | "user-act"
  | "curated"
  | "party"
  | "ended";

export interface ActivityEvent {
  at: number;
  kind: ActivityKind;
  text: string;
  reason?: string;
}

export interface ActivityFeed {
  subscribe(listener: (event: ActivityEvent) => void): () => void;
  events(): ActivityEvent[];
  latest(): ActivityEvent | null;
}

export interface NextJoinPreview {
  trackId: string;
  trackTitle: string;
  family: JoinRecipe["family"];
  technique?: JoinRecipe["technique"];
  suitability: number;
  poolSize: number;
  pool: ConsiderResult["pool"];
  recipe: JoinRecipe;
}

export interface StageCurrentMove {
  label: string;
  family: string | null;
  technique: string | null;
}

/**
 * Per-deck facts summary for the stage surface: what the engine
 * measured about the loaded track. Present only when the session
 * holds prepared facts for the deck's track — the summary is null
 * rather than guessed.
 */
export interface StageDeckFactsSummary {
  /** Measured tempo; null when no read measured one. */
  bpm: number | null;
  /** Camelot key ("8B"); null when no key was measured. */
  keyCamelot: string | null;
  /** Whether tempo + grid evidence clears the trust thresholds. */
  beatmatchTrusted: boolean;
  /** Energy (absolute RMS) at the deck's current position. */
  energyNow: number;
  /** The track's energy contour bins — a reference for rendering. */
  energyContour: { atMs: number; rms: number }[];
}

export interface StageDeckSnapshot {
  trackId: string | null;
  positionMs: number;
  positionSec: number | null;
  playing: boolean;
  rate: number;
  facts: StageDeckFactsSummary | null;
}

export interface SessionStageSnapshot {
  decks: [StageDeckSnapshot, StageDeckSnapshot];
  currentMove: StageCurrentMove | null;
  controlLevel: ControlLevel;
}

export interface DeckMoveRequest {
  kind: "stop-exit" | "scratch-in" | "scratch-out";
  technique?: JoinRecipe["technique"];
  jogKind?: string;
}

export type CurateResult = { ok: true } | { ok: false; reason: string };

export type DeckMoveResult =
  { ok: true; recipe: JoinRecipe } | { ok: false; reason: string };

// ---------------------------------------------------------------------
// Injectable seams (the factory exists for tests)
// ---------------------------------------------------------------------

/** The slice of LiveRavePerformer the session drives. */
export interface PerformerLike {
  onDeckEnded?: ((side: "A" | "B") => void) | undefined;
  loadDeck(
    side: "A" | "B",
    load: { trackId: string; buffer: AudioBuffer; facts: TrackFacts },
  ): void;
  unloadDeck(side: "A" | "B"): void;
  playDeck(side: "A" | "B", atMs?: number): void;
  pauseDeck(side: "A" | "B"): void;
  seekTo(side: "A" | "B", ms: number): void;
  positionMs(side: "A" | "B"): number;
  isPlaying(side: "A" | "B"): boolean;
  snapshot(side: "A" | "B"): DeckSnapshot;
  masterAnalyser(): AnalyserNode;
  /**
   * Asks the performer's own AudioContext to run when it is
   * suspended (fix2-0119). Optional: performers without a
   * suspendable context (test fakes) omit it.
   */
  ensureContextRunning?: () => void;
  /** The performer's context state, when it can report one. */
  contextState?: () => string;
  swapRoles(): void;
  performRecipe(recipe: JoinRecipe): Promise<void>;
  stopAll(): void;
  setMasterGain(value: number): void;
  setManualLoop(
    side: "A" | "B",
    span: { startMs: number; endMs: number } | null,
  ): void;
}

/** The slice of the player store the session reads and mirrors. */
export interface PlayerAccess {
  getState(): {
    queue: Track[];
    currentIndex: number;
    currentTrack: Track | null;
    status: string;
    repeat: "off" | "all" | "one";
    volume: number;
    /** The store's published position (the plain player's while preparing). */
    positionMs?: number;
  };
  setQueue(queue: Track[]): void;
  setCurrentTrack(track: Track | null, index: number): void;
  /** Playback-state publishing (see the header contract). */
  setPosition(positionMs: number): void;
  setDuration(durationMs: number): void;
  setStatus(status: PlayerStatus): void;
  subscribe(listener: () => void): () => void;
  /**
   * Silences the plain player's elements (fix-0119): the header
   * contract — while a set plays, the plain element sits paused —
   * is the session's to honour at takeover and at a preparing-
   * phase stop. Optional: test fakes omit it (nothing to silence).
   */
  pausePlainPlayback?: () => void;
  /**
   * Restarts the plain player's sounding element(s) after a
   * preparing-phase pause — whichever element currently carries
   * the song, not a fixed id (fix2-0119; see createPlayerAccess).
   */
  resumePlainPlayback?: () => void;
  /**
   * Authority probes (fix2-0119): whether any plain element is
   * sounding right now, and the sounding element's live position
   * — the takeover adoption source and the live authority
   * watch's evidence. Optional: test fakes omit them (there are
   * no elements to probe, and the watch stands down).
   */
  plainSounding?: () => boolean;
  plainPositionMs?: () => number | null;
  /**
   * Hands a command back to the player store's channel. Only
   * safe to call while the session is NOT running (a running
   * session is the channel's first claimant and would loop);
   * the preparing-phase skip acts stop first, then dispatch.
   */
  dispatchCommand?: (command: PlayerCommand) => void;
}

/** The injected clock: wall time for records, interval for the tick. */
export interface SessionClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realClock: SessionClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface SessionDeps {
  createPerformer: () => PerformerLike;
  supply: Supply;
  source: TrackSource;
  brain: Brain;
  memory: PerformanceMemory;
  behaviourLog: BehaviourLog;
  player: PlayerAccess;
  clock?: SessionClock;
  rng?: () => number;
  party?: PartyScheduler;
  /** Master-tap registration; default registers with the greeting registry. */
  registerMasterTap?: (
    performer: PerformerLike,
    session: LiveRaveSession,
  ) => void;
}

/** The player store's real access shape (also used by wiring.ts). */
export function createPlayerAccess(): PlayerAccess {
  return {
    getState() {
      const state = usePlayerStore.getState();
      return {
        queue: state.queue,
        currentIndex: state.currentIndex,
        currentTrack: state.currentTrack,
        status: state.status,
        repeat: state.repeat,
        volume: state.volume,
        positionMs: state.positionMs,
      };
    },
    setQueue(queue: Track[]) {
      usePlayerStore.getState().setQueue(queue);
    },
    setCurrentTrack(track: Track | null, index: number) {
      usePlayerStore.getState().setCurrentTrack(track, index);
    },
    setPosition(positionMs: number) {
      usePlayerStore.getState().setPosition(positionMs);
    },
    setDuration(durationMs: number) {
      usePlayerStore.getState().setDuration(durationMs);
    },
    setStatus(status: PlayerStatus) {
      usePlayerStore.getState().setStatus(status);
    },
    subscribe(listener: () => void) {
      return usePlayerStore.subscribe(() => listener());
    },
    pausePlainPlayback() {
      try {
        if (typeof document === "undefined") return;
        for (const id of ["liner-audio", "liner-audio-b"]) {
          const el = document.getElementById(id) as HTMLAudioElement | null;
          el?.pause();
        }
      } catch {
        // No element (tests, web without playback): nothing to silence.
      }
    },
    resumePlainPlayback() {
      try {
        if (typeof document === "undefined") return;
        // The mirror of the pause above — and the pause covers
        // BOTH elements, so the resume must too (fix2-0119).
        // The plain engine swaps the element ids at a crossfade
        // hand-off: mid-overlap, the CURRENT song is sounding
        // from the element still carrying "liner-audio-b" while
        // "liner-audio" holds the outgoing leg. Resuming only
        // "liner-audio" restarted the wrong leg (or, once the
        // outgoing element's source was cleared, nothing at
        // all) and the current song sat loaded and silent until
        // a manual pause/play cycle. Resume therefore restarts
        // every element that carries a source — exactly the
        // elements that could have been sounding when the pause
        // landed. A source-less element is skipped: there is
        // nothing on it to restart.
        for (const id of ["liner-audio", "liner-audio-b"]) {
          const el = document.getElementById(id) as HTMLAudioElement | null;
          if (!el) continue;
          if (!el.src && !el.currentSrc) continue;
          void el.play().catch(() => {});
        }
      } catch {
        // Same discipline as the pause.
      }
    },
    plainSounding() {
      try {
        if (typeof document === "undefined") return false;
        for (const id of ["liner-audio", "liner-audio-b"]) {
          const el = document.getElementById(id) as HTMLAudioElement | null;
          if (!el) continue;
          if (!el.src && !el.currentSrc) continue;
          if (!el.paused && !el.ended) return true;
        }
      } catch {
        // No readable elements: nothing can be sounding.
      }
      return false;
    },
    plainPositionMs() {
      try {
        if (typeof document === "undefined") return null;
        for (const id of ["liner-audio", "liner-audio-b"]) {
          const el = document.getElementById(id) as HTMLAudioElement | null;
          if (!el) continue;
          if (!el.src && !el.currentSrc) continue;
          if (el.paused || el.ended) continue;
          const ms = Math.round((el.currentTime || 0) * 1000);
          return Number.isFinite(ms) && ms >= 0 ? ms : null;
        }
      } catch {
        // Fall through to the store's published position.
      }
      return null;
    },
    dispatchCommand(command: PlayerCommand) {
      try {
        usePlayerStore.getState().dispatch(command);
      } catch {
        // A rejected command must not break the session's own stop.
      }
    },
  };
}

// ---------------------------------------------------------------------
// The session interface
// ---------------------------------------------------------------------

export interface LiveRaveSession extends DjTransport {
  readonly endReason: SessionEndReason | null;
  /** The start attempt's visible state (fix-0119; see the type). */
  readonly startState: SessionStartState;
  /** The first preparation failure of the last failed start, verbatim. */
  readonly startFailure: string | null;
  /**
   * True while a started session is in its preparing phase: live
   * (ON AIR, surfaces up) but the decks have not taken over yet —
   * the plain player is still sounding the current track while
   * preparation runs.
   */
  readonly preparing: boolean;
  /** True once anything this session degraded (fallback or untrusted join). */
  readonly degraded: boolean;
  /** How many fallback records this session has landed. */
  readonly fallbackCount: number;
  /** A join is sounding right now. */
  readonly blending: boolean;
  readonly controlLevel: ControlLevel;
  /** Guest requests still in play (scheduled or waiting). */
  readonly liveRaveOpenRequests: GuestRequest[];
  readonly nextJoinPreview: NextJoinPreview | null;
  readonly activityFeed: ActivityFeed;
  onRunningChange: ((running: boolean) => void) | null;
  onBlendingChange: ((blending: boolean) => void) | null;
  start(
    queue: Track[],
    startIndex?: number,
    options?: { autoResume?: boolean },
  ): Promise<void>;
  stop(reason?: SessionEndReason): void;
  setShaping(shaping: Shaping): void;
  setControlLevel(level: ControlLevel): void;
  stageSnapshot(): SessionStageSnapshot | null;
  masterAnalyser(): AnalyserNode | null;
  curateRemaining(): Promise<CurateResult>;
  triggerDeckMove(request: DeckMoveRequest): Promise<DeckMoveResult>;
  /** Played energies + upcoming prepared energies (the §10 skyline). */
  setArc(): { played: number[]; upcoming: number[] };
  getBehaviourLog(): BehaviourRecord[];
  // Party seam (see party.ts).
  submitGuestRequest(track: Track, guestId?: string): GuestRequest;
  evaluateRequests(): GuestRequest[];
  guestStatus(trackId: string): GuestRequestStatus | null;
  setDoNotPlay(trackIds: Iterable<string>): void;
}

// ---------------------------------------------------------------------
// Tuning constants (stated, with reasons)
// ---------------------------------------------------------------------

/** The decision loop's tick, per the wave brief. */
export const SESSION_TICK_MS = 250;
/** Background preparation concurrency, per the wave brief. */
export const PREP_CONCURRENCY = 2;
/** Planning horizon caps: never plan more than 45 s out… */
export const PLANNING_HORIZON_MAX_MS = 45_000;
/** …and never earlier than the last quarter of the track. */
export const PLANNING_HORIZON_FRACTION = 0.25;
/** Buy-time limits (design §3.8): at most 3 wraps, at most 30 s. */
export const BUY_TIME_MAX_WRAPS = 3;
export const BUY_TIME_MAX_MS = 30_000;
/** The activity feed keeps the night's most recent events. */
export const ACTIVITY_FEED_CAP = 200;
/**
 * Preparing-phase decision bound (fix2-0119): how long a start
 * may sit in "preparing" with NO takeover prospect — no queued
 * track prepared with its buffer — before the phase ends in the
 * visible failure state. Preparation is bounded below this at
 * the analysis layer (the runner's watchdog), but the session
 * owns the outer bound: whatever hangs underneath it (a wedged
 * supply, a source that never answers), the phase must reach a
 * decision. Thirty seconds is far beyond any healthy cold
 * preparation of a queue's first tracks.
 */
export const PREPARING_DECISION_MS = 30_000;
/**
 * Preparing-phase hard cap (fix2-0119): even WITH a takeover
 * prospect (a later track prepared, awaiting boundary adoption),
 * the phase may not outlive this. Five minutes exceeds the
 * remainder of nearly any track, so a real boundary always beats
 * the cap; the cap exists for the frozen night — the plain
 * player paused forever, a wedged store — where the boundary
 * would otherwise never arrive at all.
 */
export const PREPARING_HARD_CAP_MS = 300_000;
/**
 * Authority watch (fix2-0119): how many times the plain engine
 * may be caught sounding under a live set — each catch is
 * re-silenced — before the session concedes it cannot hold the
 * decks and ends visibly. Three strikes is generous: with the
 * runtime subordinated, a single catch should never happen.
 */
export const AUTHORITY_MAX_STRIKES = 3;
/**
 * Authority watch: a sounding deck's position that has not
 * moved for this long earns a warning narration and a context
 * resume attempt; at AUTHORITY_DECK_FAIL_MS the set ends
 * visibly rather than displaying ON AIR over a dead deck.
 */
export const AUTHORITY_DECK_WARN_MS = 2_000;
export const AUTHORITY_DECK_FAIL_MS = 8_000;

// ---------------------------------------------------------------------
// Internal preparation record
// ---------------------------------------------------------------------

interface PreparedEntry {
  track: Track;
  facts: TrackFacts | null;
  buffer: AudioBuffer | null;
  status: "preparing" | "ready" | "failed";
  /** The failure's reason, for honest narration on retry/exhaustion. */
  failure: string | null;
}

interface ActiveJoin {
  recipe: JoinRecipe;
  trackB: Track;
  factsB: TrackFacts;
  suitability: number;
  poolSize: number;
  /** "user-act" when a person (not the draw) chose this join. */
  recordMode: "auto" | "user-act";
  untrusted: boolean;
  /** A-position (nominal) at which the overlap has fully played. */
  overlapEndPosMs: number;
}

interface BuyTimeState {
  result: ConsiderResult;
  startedAt: number;
  span: { startMs: number; endMs: number };
  wraps: number;
  /** Clock time of the last forced re-preparation of the target. */
  lastPrepRetryAt: number;
}

/** How often buy-time may force another preparation attempt. */
export const BUY_TIME_PREP_RETRY_MS = 2_000;

// ---------------------------------------------------------------------
// The session implementation
// ---------------------------------------------------------------------

class LiveRaveSessionImpl implements LiveRaveSession {
  onRunningChange: ((running: boolean) => void) | null = null;
  onBlendingChange: ((blending: boolean) => void) | null = null;

  private readonly deps: SessionDeps;
  private readonly clock: SessionClock;
  private readonly party: PartyScheduler;

  private performer: PerformerLike | null = null;
  private masterTapRegistered = false;
  private shaping: Shaping = NEUTRAL_SHAPING;

  private running = false;
  private pausedFlag = false;
  private endReasonValue: SessionEndReason | null = null;
  private controlLevelValue: ControlLevel = "autonomous";

  // The preparing phase (fix-0119): a start goes live immediately
  // in "preparing" — running, surfaces up, the plain player still
  // sounding the current track — and flips to "live" at takeover,
  // when the pending track's preparation lands with a buffer.
  private phase: "idle" | "preparing" | "live" = "idle";
  private pendingCurrent: { track: Track; index: number } | null = null;
  private pendingAutoResume = false;
  private lastPendingPrepRetryAt = 0;
  /** When the current preparing phase began (fix2-0119 bounds). */
  private preparingStartedAt = 0;
  private startStateValue: SessionStartState = "idle";
  private startFailureValue: string | null = null;

  private queue: Track[] = [];
  private upcoming: Track[] = [];
  private history: Track[] = [];
  private readonly played = new Set<string>();
  private current: { track: Track; facts: TrackFacts } | null = null;

  private readonly prepared = new Map<string, PreparedEntry>();
  private readonly prepInFlight = new Map<string, Promise<void>>();
  private preview: NextJoinPreview | null = null;
  private activeJoin: ActiveJoin | null = null;
  private buyTime: BuyTimeState | null = null;
  private deciding = false;
  private deckEndedPending = false;
  /**
   * A deck end that arrived while a decision was in flight
   * (fix2-0119): the decision's finally runs it, if the track it
   * belonged to is still current and nothing superseded it.
   */
  private deferredDeckEnd: { trackId: string } | null = null;
  /** Authority watch state (fix2-0119): foreign-source strikes… */
  private authorityStrikes = 0;
  /** …and the deck-advance sampler (null = no sample yet). */
  private deckWatch: {
    trackId: string;
    positionMs: number;
    sinceMs: number;
    warned: boolean;
  } | null = null;
  /** Tracks whose bufferless exclusion is already narrated (fix2-0119). */
  private bufferlessExcluded = new Set<string>();
  /** Current-track id whose no-candidate window was already narrated. */
  private noCandidateNarratedFor: string | null = null;
  private blendingFlag = false;
  private degradedFlag = false;
  private fallbackCountValue = 0;
  private doNotPlay = new Set<string>();
  private tickHandle: unknown = null;
  /** Bumped on every start/stop so stale async work can stand down. */
  private generation = 0;

  private readonly activityEvents: ActivityEvent[] = [];
  private readonly activityListeners = new Set<
    (event: ActivityEvent) => void
  >();
  readonly activityFeed: ActivityFeed = {
    subscribe: (listener) => {
      this.activityListeners.add(listener);
      return () => {
        this.activityListeners.delete(listener);
      };
    },
    events: () => [...this.activityEvents],
    latest: () =>
      this.activityEvents.length > 0
        ? this.activityEvents[this.activityEvents.length - 1]
        : null,
  };

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? realClock;
    this.party =
      deps.party ?? createPartyScheduler({ now: () => this.clock.now() });
    // Volume follows the player store for the session's whole life;
    // the performer applies it whenever one exists.
    this.deps.player.subscribe(() => {
      if (this.performer) {
        try {
          this.performer.setMasterGain(this.deps.player.getState().volume);
        } catch {
          // A performer that rejects a gain must not break the store.
        }
      }
    });
  }

  // -- transport surface ------------------------------------------------

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.running && this.pausedFlag;
  }

  get endReason(): SessionEndReason | null {
    return this.endReasonValue;
  }

  get startState(): SessionStartState {
    return this.startStateValue;
  }

  get startFailure(): string | null {
    return this.startFailureValue;
  }

  get preparing(): boolean {
    return this.phase === "preparing";
  }

  get degraded(): boolean {
    return this.degradedFlag;
  }

  get fallbackCount(): number {
    return this.fallbackCountValue;
  }

  get blending(): boolean {
    return this.blendingFlag;
  }

  get controlLevel(): ControlLevel {
    return this.controlLevelValue;
  }

  get liveRaveOpenRequests(): GuestRequest[] {
    return this.party.openRequests();
  }

  get nextJoinPreview(): NextJoinPreview | null {
    return this.preview;
  }

  // -- narration / records ------------------------------------------------

  private narrate(kind: ActivityKind, text: string, reason?: string): void {
    const event: ActivityEvent = { at: this.clock.now(), kind, text, reason };
    this.activityEvents.push(event);
    while (this.activityEvents.length > ACTIVITY_FEED_CAP) {
      this.activityEvents.shift();
    }
    for (const listener of Array.from(this.activityListeners)) {
      try {
        listener(event);
      } catch {
        // A broken listener must not break the night.
      }
    }
  }

  /**
   * Lands one behaviour record with the design's reason precedence:
   * fallback-* beats degraded-untrusted beats performed; a user-act
   * outranks degradation but never a fallback.
   */
  private recordJoin(input: {
    family: JoinRecipe["family"] | null;
    technique?: JoinRecipe["technique"];
    fxKinds?: ReturnType<typeof fxKindsOfRecipe>;
    pairTrackIds: [string, string];
    suitability: number | null;
    poolSize: number;
    fallback?: Exclude<
      BehaviourReason,
      "performed" | "degraded-untrusted" | "user-act"
    >;
    userAct?: boolean;
    untrusted?: boolean;
  }): BehaviourReason {
    let reason: BehaviourReason = "performed";
    if (input.fallback) reason = input.fallback;
    else if (input.userAct) reason = "user-act";
    else if (input.untrusted) reason = "degraded-untrusted";
    this.deps.behaviourLog.record({
      at: this.clock.now(),
      family: input.family,
      technique: input.technique,
      fxKinds: input.fxKinds ?? [],
      pairTrackIds: input.pairTrackIds,
      suitability: input.suitability,
      poolSize: input.poolSize,
      reason,
    });
    if (reason === "fallback-unprepared" || reason === "fallback-invalid") {
      this.fallbackCountValue += 1;
      this.degradedFlag = true;
    }
    if (reason === "degraded-untrusted") this.degradedFlag = true;
    if (
      input.family !== null &&
      reason !== "fallback-unprepared" &&
      reason !== "fallback-invalid"
    ) {
      this.deps.memory.record({
        family: input.family,
        technique: input.technique,
        fxKinds: input.fxKinds ?? [],
      });
    }
    return reason;
  }

  private setBlending(value: boolean): void {
    if (this.blendingFlag === value) return;
    this.blendingFlag = value;
    try {
      this.onBlendingChange?.(value);
    } catch {
      // Notice handlers are the caller's code; never let them break the set.
    }
  }

  private fireRunningChange(): void {
    try {
      this.onRunningChange?.(this.running);
    } catch {
      // Same discipline as setBlending.
    }
  }

  // -- playback-state publishing -------------------------------------------
  //
  // The deck carrying the store's current track is always side A
  // in the session's logical view: a join loads the incoming track
  // on B, and the swap that makes it current (swapRoles in
  // completeJoin / plainStart) re-labels its deck A in the same
  // step setCurrentTrack moves to it. So positionMs("A") is the
  // honest position of the store's current track at every moment —
  // the outgoing track's position while an overlap sounds, the
  // incoming track's (already into the track by the overlap) after
  // the swap.

  /**
   * Publishes the sounding deck's position and the current track's
   * duration into the player store. Called on the session's own
   * 250 ms tick and at every moment the position jumps (start,
   * track change, seek, pause, stop). Best-effort and cheap: two
   * store writes, each guarded — a store that rejects a write must
   * not break the set, and no extra timer is ever created.
   */
  private publishPositionDuration(): void {
    if (!this.current || !this.performer) return;
    try {
      const positionMs = this.performer.positionMs("A");
      if (Number.isFinite(positionMs) && positionMs >= 0) {
        this.deps.player.setPosition(Math.round(positionMs));
      }
    } catch {
      // A failed position write loses one tick's freshness only.
    }
    try {
      const durationMs =
        this.current.facts.durationMs ?? this.current.track.durationMs;
      if (
        typeof durationMs === "number" &&
        Number.isFinite(durationMs) &&
        durationMs > 0
      ) {
        this.deps.player.setDuration(durationMs);
      }
    } catch {
      // Same discipline as the position write above.
    }
  }

  /**
   * The authority watch (fix2-0119). Two invariants, checked
   * every live tick:
   *
   * 1. NO FOREIGN SOUND. If a plain element is sounding while
   *    the session lives — a crossfade that outlived the
   *    takeover, an engine path that restarted one — it is
   *    re-silenced immediately. Under an unpaused session each
   *    recurrence is a strike: the subordinated engine is
   *    fighting the session, and at AUTHORITY_MAX_STRIKES the
   *    session ends visibly rather than shadow-running against
   *    a second transport (the photographed 0:25-vs-2:03 state:
   *    one track, two positions, the element audible). While
   *    the session is paused the re-silence is silent
   *    housekeeping — the user may be auditioning the plain
   *    player deliberately... no: a live session owns the
   *    elements even paused; the pause control is the deck's.
   *    Strikes are simply not counted while paused, because a
   *    paused deck cannot prove the element wrong by sounding.
   *
   * 2. NO SILENT MOTION. The deck must actually be rendering:
   *    its position, sampled from its own clock, must advance.
   *    A frozen position while unpaused (the performer's
   *    context suspended/interrupted — currentTime stops, so
   *    the position stops) first earns a context-resume attempt
   *    and a narration; if it stays frozen to the fail bound,
   *    the session hands the sound back / ends visibly (see
   *    loseAuthority). Displays moving over total silence is a
   *    forbidden state.
   *
   * Both checks are probe-based: a PlayerAccess without the
   * probes (older fakes) simply skips check 1, and check 2 uses
   * the performer every session already has.
   */
  private authorityTick(): void {
    if (this.phase !== "live" || !this.current) return;
    const current = this.current;
    const player = this.deps.player;
    // -- foreign sound ------------------------------------------------
    let sounding = false;
    try {
      sounding = player.plainSounding?.() ?? false;
    } catch {
      sounding = false;
    }
    if (sounding) {
      try {
        player.pausePlainPlayback?.();
      } catch {
        // Re-silencing is best-effort per tick; it retries.
      }
      if (!this.pausedFlag) {
        this.authorityStrikes += 1;
        this.narrate(
          "degraded",
          "The plain player started sounding under the live set — silenced (the decks are the only sound while DJ is on)",
        );
        if (this.authorityStrikes >= AUTHORITY_MAX_STRIKES) {
          this.loseAuthority(
            "the plain player kept sounding under the live set",
            false,
          );
          return;
        }
      }
    }
    // -- silent motion --------------------------------------------------
    if (this.pausedFlag || this.buyTime || !this.performer) {
      this.deckWatch = null;
      return;
    }
    let position = Number.NaN;
    try {
      position = this.performer.positionMs("A");
    } catch {
      position = Number.NaN;
    }
    if (!Number.isFinite(position)) {
      this.deckWatch = null;
      return;
    }
    const now = this.clock.now();
    const watch = this.deckWatch;
    if (!watch || watch.trackId !== current.track.id) {
      this.deckWatch = {
        trackId: current.track.id,
        positionMs: position,
        sinceMs: now,
        warned: false,
      };
      return;
    }
    if (position !== watch.positionMs) {
      // Movement (a loop wrap moves too; a seek moves): healthy.
      watch.positionMs = position;
      watch.sinceMs = now;
      watch.warned = false;
      return;
    }
    const frozenFor = now - watch.sinceMs;
    if (frozenFor >= AUTHORITY_DECK_WARN_MS && !watch.warned) {
      watch.warned = true;
      this.ensurePerformerContext();
      this.narrate(
        "degraded",
        "The deck stopped advancing — asked its audio context to resume",
      );
    }
    if (frozenFor >= AUTHORITY_DECK_FAIL_MS) {
      this.loseAuthority(
        "the decks stopped rendering (their audio context would not run)",
        true,
      );
    }
  }

  /**
   * Loses authority, honestly (fix2-0119). The end is VISIBLE:
   * the stop reason the wiring treats as deliberate ("replaced")
   * carries the session down, and the failure line is then set
   * for the bar/DjModeButton to show — the same surface a failed
   * START uses. When the failure is the deck's own silence, the
   * sound is handed back first-class: after the stop, a normal
   * PLAY_REQUESTED for the current track goes through the
   * engine's own dispatch (the session is no longer running, so
   * the command falls through untouched) and the plain player
   * audibly takes the song over. Silence-with-motion never
   * persists past the fail bound.
   */
  private loseAuthority(detail: string, handBackSound: boolean): void {
    const lastTrack = this.current?.track ?? null;
    const lastQueue = [...this.queue];
    this.narrate(
      "ended",
      `DJ stopped — it could not hold the sound alone: ${detail}`,
    );
    this.stopInternal("replaced");
    // stopInternal resets the start state to idle; the visible
    // failure is assigned after it, deliberately.
    this.startStateValue = "failed";
    this.startFailureValue = `DJ stopped: ${detail} — the plain player has the sound`;
    if (handBackSound && lastTrack) {
      try {
        this.deps.player.dispatchCommand?.({
          type: "PLAY_REQUESTED",
          track: lastTrack,
          queue: lastQueue.length > 0 ? lastQueue : [lastTrack],
        });
      } catch {
        // The bar still shows the failure; the user's own play
        // press is the fallback, as the failure line says.
      }
    }
  }

  /** Publishes the transport status alone. Best-effort, as above. */
  private publishStatus(status: PlayerStatus): void {
    try {
      this.deps.player.setStatus(status);
    } catch {
      // A failed status write must not break the set.
    }
  }

  /**
   * Position, duration and status together, for the moments the
   * store's current track or transport state changes under the
   * session: start, resume, pause, and every track change. The
   * status follows the session's own pause flag, so a track change
   * performed while paused still publishes "paused".
   */
  private publishPlaybackState(): void {
    this.publishPositionDuration();
    this.publishStatus(this.pausedFlag ? "paused" : "playing");
  }

  // -- performer lifecycle --------------------------------------------------

  private getPerformer(): PerformerLike {
    if (this.performer) return this.performer;
    const performer = this.deps.createPerformer();
    performer.onDeckEnded = (side) => {
      if (side === "A" && this.running && !this.activeJoin) {
        this.deckEndedPending = true;
      }
    };
    this.performer = performer;
    try {
      performer.setMasterGain(this.deps.player.getState().volume);
    } catch {
      // Volume applies again at start; a failure here is not fatal.
    }
    return performer;
  }

  /**
   * The performer-context recovery (fix2-0119): the performer's
   * AudioContext can come up suspended when a start had no user
   * gesture behind it (the wiring's auto-resume), and a suspended
   * context freezes the deck clock — positions never advance, no
   * window is ever reached, nothing errors. Checked at start, at
   * takeover and on resume; each check asks a suspended context
   * to run. A refusal is survivable (the decks stay silent until
   * the browser allows the context) and the next check retries.
   */
  private ensurePerformerContext(): void {
    if (!this.performer) return;
    try {
      this.performer.ensureContextRunning?.();
    } catch {
      // A performer that throws here must not break the session.
    }
  }

  private registerMasterTap(): void {
    if (this.masterTapRegistered || !this.performer) return;
    this.masterTapRegistered = true;
    const register =
      this.deps.registerMasterTap ??
      ((performer: PerformerLike, session: LiveRaveSession) => {
        registerVisualizerTap(
          createAnalyserTap(
            VISUALIZER_TAP_ID.DJ_MASTER,
            () => {
              try {
                return performer.masterAnalyser();
              } catch {
                return null;
              }
            },
            () => session.isRunning,
          ),
          VISUALIZER_TAP_PRIORITY.DJ_MASTER,
        );
      });
    try {
      register(this.performer, this);
    } catch {
      // The visualizer is a consumer, not a dependency of the set.
    }
  }

  masterAnalyser(): AnalyserNode | null {
    if (!this.performer) return null;
    try {
      return this.performer.masterAnalyser();
    } catch {
      return null;
    }
  }

  setShaping(shaping: Shaping): void {
    this.shaping = shaping;
  }

  setControlLevel(level: ControlLevel): void {
    if (level === "autonomous" || level === "assisted" || level === "manual") {
      this.controlLevelValue = level;
    }
  }

  // -- preparation ------------------------------------------------------------

  private entryFor(track: Track): PreparedEntry {
    let entry = this.prepared.get(track.id);
    if (!entry) {
      entry = {
        track,
        facts: null,
        buffer: null,
        status: "failed",
        failure: "not prepared yet",
      };
      this.prepared.set(track.id, entry);
    }
    return entry;
  }

  /**
   * One preparation pass for a track: source → supply → facts.
   * Failures land on the entry (status "failed" + the reason) and
   * in the feed — preparation degrades honestly, never silently.
   */
  private prepTrack(
    track: Track,
    depth: "fast" | "deep",
    force = false,
  ): Promise<void> {
    const existing = this.prepInFlight.get(track.id);
    if (existing) return existing;
    const entry = this.entryFor(track);
    // A ready entry WITH its buffer is done. A ready entry whose
    // buffer never landed may be re-prepared when forced (the
    // buy-time path) — without force it is left alone so the
    // background pump never spins on an undecodable track.
    if (entry.status === "ready" && (entry.buffer || !force)) {
      return Promise.resolve();
    }
    entry.status = "preparing";
    entry.failure = null;
    this.narrate("preparing", `Preparing "${track.title}" (${depth} read)`);
    const generation = this.generation;
    const run = (async () => {
      try {
        const audio = await this.deps.source.resolveTrackAudio(track);
        if (!audio) {
          entry.status = "failed";
          entry.failure = "audio could not be resolved or decoded";
          this.narrate(
            "degraded",
            `Preparation failed for "${track.title}": ${entry.failure}`,
            entry.failure,
          );
          return;
        }
        // The buffer lands BEFORE the facts complete: an entry can
        // be facts-ready with its decode still missing only when a
        // source hands back samples without a buffer — the session
        // treats that as the buy-time case, exactly as designed.
        entry.buffer = audio.buffer ?? null;
        const supplied = await this.deps.supply.supplyRead({
          samples: audio.samples,
          sampleRate: audio.sampleRate,
          depth,
        });
        if (!supplied) {
          entry.status = "failed";
          entry.failure = "analysis supply returned no read";
          this.narrate(
            "degraded",
            `Preparation failed for "${track.title}": ${entry.failure}`,
            entry.failure,
          );
          return;
        }
        entry.facts = buildTrackFacts(
          track.id,
          supplied.read,
          track.durationMs > 0
            ? track.durationMs
            : Math.round(supplied.read.durationSec * 1000),
        );
        entry.status = "ready";
        this.narrate(
          "prepared",
          `Prepared "${track.title}" (${supplied.source} read)`,
        );
      } catch (error) {
        entry.status = "failed";
        entry.failure =
          error instanceof Error ? error.message : "preparation threw";
        this.narrate(
          "degraded",
          `Preparation failed for "${track.title}": ${entry.failure}`,
          entry.failure,
        );
      } finally {
        this.prepInFlight.delete(track.id);
        if (generation === this.generation && this.running) {
          if (this.phase === "preparing") {
            // A landed preparation is the takeover signal: check
            // before the pump so the decks take over on the same
            // beat the current track becomes playable.
            this.tryTakeover();
            this.maybeEndPreparingFailed();
          }
          this.pumpPrep();
        }
      }
    })();
    this.prepInFlight.set(track.id, run);
    return run;
  }

  /** Depth for an upcoming position: fast for the next 2, deep after. */
  private depthForUpcoming(track: Track): "fast" | "deep" {
    const unplayed = this.upcoming.filter((t) => !this.played.has(t.id));
    const index = unplayed.findIndex((t) => t.id === track.id);
    return index >= 0 && index < 2 ? "fast" : "deep";
  }

  /** Keeps up to PREP_CONCURRENCY preparations in flight, in order. */
  private pumpPrep(): void {
    if (!this.running) return;
    let inFlight = this.prepInFlight.size;
    for (const track of this.upcoming) {
      if (inFlight >= PREP_CONCURRENCY) break;
      if (this.played.has(track.id)) continue;
      const entry = this.prepared.get(track.id);
      if (entry && (entry.status === "ready" || entry.status === "preparing")) {
        continue;
      }
      if (this.prepInFlight.has(track.id)) continue;
      void this.prepTrack(track, this.depthForUpcoming(track));
      inFlight += 1;
    }
  }

  /** Awaits one track's preparation (used for the opener). */
  private async prepOne(
    track: Track,
    depth: "fast" | "deep",
  ): Promise<PreparedEntry> {
    const entry = this.entryFor(track);
    if (entry.status === "ready") return entry;
    await this.prepTrack(track, depth);
    return entry;
  }

  private readyEntries(): PreparedEntry[] {
    const out: PreparedEntry[] = [];
    for (const track of this.upcoming) {
      if (this.played.has(track.id)) continue;
      const entry = this.prepared.get(track.id);
      if (entry && entry.status === "ready" && entry.facts) out.push(entry);
    }
    return out;
  }

  private firstReadyWithBuffer(excludeId?: string): PreparedEntry | null {
    for (const entry of this.readyEntries()) {
      if (excludeId !== undefined && entry.track.id === excludeId) continue;
      if (entry.buffer) return entry;
    }
    return null;
  }

  private arcPosition(): number {
    const total = Math.max(1, this.queue.length);
    return Math.min(1, Math.max(0, this.history.length / total));
  }

  private titleOf(trackId: string): string {
    const track =
      this.queue.find((t) => t.id === trackId) ??
      this.upcoming.find((t) => t.id === trackId);
    return track?.title ?? trackId;
  }

  // -- start / stop -----------------------------------------------------------

  async start(
    queue: Track[],
    startIndex = 0,
    options?: { autoResume?: boolean },
  ): Promise<void> {
    if (this.running) {
      this.stopInternal("replaced");
    }
    this.generation += 1;
    this.endReasonValue = null;
    this.startStateValue = "starting";
    this.startFailureValue = null;
    this.degradedFlag = false;
    this.fallbackCountValue = 0;
    this.played.clear();
    this.history = [];
    this.preview = null;
    this.activeJoin = null;
    this.buyTime = null;
    this.deckEndedPending = false;
    this.deferredDeckEnd = null;
    this.authorityStrikes = 0;
    this.deckWatch = null;
    this.bufferlessExcluded.clear();
    this.noCandidateNarratedFor = null;

    // Note 32 identity validation: the opener is the player
    // store's ACTUAL current track. When the passed queue/index
    // disagrees, realign to the store and narrate the correction —
    // a foreign track never opens the set.
    const storeState = this.deps.player.getState();
    let sessionQueue = [...queue];
    let index = Math.min(
      Math.max(0, Math.floor(startIndex) || 0),
      Math.max(0, sessionQueue.length - 1),
    );
    const storeTrack = storeState.currentTrack;
    if (storeTrack && sessionQueue[index]?.id !== storeTrack.id) {
      let realigned = false;
      const storeQueue = storeState.queue;
      if (storeQueue && storeQueue.length > 0) {
        const storeIndex = storeQueue.findIndex((t) => t.id === storeTrack.id);
        if (storeIndex >= 0) {
          sessionQueue = [...storeQueue];
          index = storeIndex;
          realigned = true;
        }
      }
      if (!realigned) {
        const queueIndex = sessionQueue.findIndex(
          (t) => t.id === storeTrack.id,
        );
        if (queueIndex >= 0) {
          index = queueIndex;
        } else {
          sessionQueue = [
            storeTrack,
            ...sessionQueue.filter((t) => t.id !== storeTrack.id),
          ];
          index = 0;
        }
        realigned = true;
      }
      if (realigned) {
        this.narrate(
          "corrected",
          `Start realigned to the player's current track "${storeTrack.title}" — the passed queue/index disagreed with the store (Note 32)`,
        );
      }
    }

    if (sessionQueue.length === 0) {
      this.endReasonValue = "start-no-playable";
      this.startStateValue = "failed";
      this.startFailureValue = "the queue is empty";
      this.narrate(
        "ended",
        "Session could not start: the queue is empty",
        "start-no-playable",
      );
      this.fireRunningChange();
      return;
    }

    // Addendum B / repeat-one: the session declines to start; the
    // plain player owns that loop.
    if (storeState.repeat === "one") {
      this.startStateValue = "failed";
      this.startFailureValue = "repeat-one is on — the player owns that loop";
      this.narrate(
        "ended",
        "liveRave declines to start while repeat-one is on — the player owns that loop",
        "repeat-one",
      );
      return;
    }

    this.queue = sessionQueue;

    // The preparing phase (fix-0119): the session goes live NOW,
    // on the player's actual current track, without waiting for
    // any preparation to land. The old shape gated the whole
    // start on an opener prepared WITH a decoded buffer — and in
    // the shipped wiring preparation could never land at all on
    // a cold start (see buildDefaultSession), so the DJ died
    // silently at this gate every time. Now: the session is
    // running from this beat (ON AIR, surfaces up), the plain
    // player keeps the current track audible, preparation of the
    // current and upcoming tracks proceeds in the background,
    // and tryTakeover moves the set onto the decks the moment
    // the pending track is ready with facts + buffer — mid-track
    // at the audible position, or at the boundary when the plain
    // player reaches a track that is ready first.
    const openerTrack = sessionQueue[index];
    this.pendingCurrent = { track: openerTrack, index };
    this.pendingAutoResume = options?.autoResume === true;
    this.upcoming = sessionQueue.slice(index + 1);
    this.current = null;
    this.played.add(openerTrack.id);
    this.history = [openerTrack];
    this.phase = "preparing";
    this.running = true;
    this.pausedFlag = false;
    this.lastPendingPrepRetryAt = this.clock.now();
    this.preparingStartedAt = this.clock.now();
    this.narrate(
      "preparing",
      `Set starting on "${openerTrack.title}" — the decks take over when its preparation lands; the plain player keeps it audible until then`,
    );
    this.fireRunningChange();
    this.tickHandle = this.clock.setInterval(
      () => this.tick(),
      SESSION_TICK_MS,
    );
    // The performer exists from the preparing beat (no decks
    // loaded yet): the store-volume subscription in the
    // constructor applies gains to it for the session's whole
    // life, preparing phase included.
    this.getPerformer();
    // A gesture-less start (auto-resume) may have created the
    // performer's context suspended; ask it to run now, while
    // the plain player still covers the sound (fix2-0119).
    this.ensurePerformerContext();
    void this.prepTrack(openerTrack, "fast");
    this.pumpPrep();
    // Already-prepared tracks (a warm store) take over in this
    // same beat, exactly as the gated start used to.
    this.tryTakeover();
  }

  /**
   * The preparing phase's heartbeat (the tick routes here while
   * phase is "preparing"): adopt the track the plain player has
   * reached, retry the pending track's preparation on a cadence,
   * and take over or give up as preparations settle.
   */
  private preparingTick(): void {
    const pending = this.pendingCurrent;
    if (!pending) return;
    const store = this.deps.player.getState();
    const storeTrack = store.currentTrack;
    if (!storeTrack) {
      // The plain player stopped with nothing loaded: the night
      // the set was preparing for is over before it began.
      if (store.status !== "playing") {
        this.narrate("ended", "Set ended (queue-exhausted)", "queue-exhausted");
        this.endPreparing({
          endReason: "queue-exhausted",
          failed: false,
          failure: null,
        });
      }
      return;
    }
    if (storeTrack.id !== pending.track.id) {
      const nextIndex = this.queue.findIndex((t) => t.id === storeTrack.id);
      if (nextIndex < 0) {
        // The queue was replaced under the preparing set.
        this.narrate(
          "ended",
          "Set ended (replaced) — the player's queue moved on while the set was preparing",
          "replaced",
        );
        this.endPreparing({
          endReason: "replaced",
          failed: false,
          failure: null,
        });
        return;
      }
      // Boundary adoption: the plain player reached the next
      // track first — that track becomes the pending one, and if
      // it is already prepared the takeover below is the first
      // join's downbeat.
      this.pendingCurrent = { track: storeTrack, index: nextIndex };
      this.upcoming = this.queue.slice(nextIndex + 1);
      if (!this.played.has(storeTrack.id)) {
        this.played.add(storeTrack.id);
        this.history.push(storeTrack);
      }
      void this.prepTrack(storeTrack, "fast");
    }
    this.tryTakeover();
    if (this.phase !== "preparing") return;
    const pendingNow = this.pendingCurrent;
    if (!pendingNow) return;
    // A failed pending track gets its preparation retried on a
    // cadence — sources recover, caches land — while the plain
    // player keeps the night audible.
    const entry = this.prepared.get(pendingNow.track.id);
    if (
      entry &&
      entry.status === "failed" &&
      !this.prepInFlight.has(entry.track.id)
    ) {
      const now = this.clock.now();
      if (now - this.lastPendingPrepRetryAt >= 2_000) {
        this.lastPendingPrepRetryAt = now;
        void this.prepTrack(entry.track, "fast");
      }
    }
    this.pumpPrep();
    this.maybeEndPreparingFailed();
    this.maybeEndPreparingTimedOut();
  }

  /**
   * Moves the set from the preparing phase onto the decks, when
   * the pending track's preparation has landed with facts and a
   * decoded buffer. Mid-track takeovers keep the audible
   * position: the deck seeks to the store's published position
   * for this same track before it plays, and the plain element
   * is silenced in the same step (the header contract).
   */
  private tryTakeover(): void {
    if (this.phase !== "preparing" || !this.pendingCurrent) return;
    const { track, index } = this.pendingCurrent;
    const entry = this.prepared.get(track.id);
    if (!entry || entry.status !== "ready" || !entry.facts || !entry.buffer) {
      return;
    }
    const performer = this.getPerformer();
    // The decks are about to sound: the context must be running
    // before anything is scheduled on its clock (fix2-0119).
    this.ensurePerformerContext();
    performer.stopAll();
    this.registerMasterTap();
    try {
      performer.setMasterGain(this.deps.player.getState().volume);
    } catch {
      // Non-fatal; the store subscription keeps volume following.
    }
    performer.loadDeck("A", {
      trackId: track.id,
      buffer: entry.buffer,
      facts: entry.facts,
    });
    const store = this.deps.player.getState();
    // The deck adopts the plain player's LIVE position — never a
    // restart near zero while the song audibly sits elsewhere
    // (fix2-0119). The sounding element's own clock is the truth:
    // the store's published position is a 250 ms-cadence copy of
    // it, and a store track change resets it to zero while the
    // element is already into the new track. The element read is
    // preferred under the same identity guards as ever (the
    // store is playing THIS track); the store's value remains
    // the fallback when no element can be read.
    let elementMs: number | null = null;
    try {
      elementMs = this.deps.player.plainPositionMs?.() ?? null;
    } catch {
      elementMs = null;
    }
    const storeMs =
      typeof store.positionMs === "number" && store.positionMs > 0
        ? Math.round(store.positionMs)
        : null;
    const atMs =
      store.status === "playing" && store.currentTrack?.id === track.id
        ? (elementMs ?? storeMs ?? 0)
        : 0;
    if (atMs > 0) {
      try {
        performer.seekTo("A", atMs);
      } catch {
        // A failed seek leaves the deck at its head; the set
        // still starts.
      }
    }
    if (!this.pausedFlag) performer.playDeck("A");
    // VERIFY BEFORE SILENCE (fix2-0119, authority): the plain
    // elements are silenced only once the deck is verifiably
    // able to render. When the performer exposes its context
    // state and that state is not "running" even after the
    // resume attempt above (one re-check — a resume landing
    // inside a user gesture flips synchronously on some
    // browsers), the takeover ABORTS: the elements were never
    // silenced, the plain player keeps the song, and the start
    // fails VISIBLY with the reason. Moving progress over total
    // silence — displays advancing, nothing audible — must be
    // impossible by construction. A performer that exposes no
    // state cannot be verified either way and proceeds as
    // before (the mid-session authority watch still guards it).
    const contextState = performer.contextState?.();
    if (contextState !== undefined && contextState !== "running") {
      this.ensurePerformerContext();
      const rechecked = performer.contextState?.();
      if (rechecked !== undefined && rechecked !== "running") {
        try {
          performer.stopAll();
        } catch {
          // Nothing was silenced; the deck simply never starts.
        }
        this.endPreparing({
          endReason: "start-no-playable",
          failed: true,
          failure:
            `the decks' audio could not start (context ${rechecked}) — ` +
            "the plain player keeps the sound; tap DJ again to retry",
        });
        return;
      }
    }
    // Verified (or unverifiable-by-design): commit the takeover.
    // Only NOW do the session's fields flip and the elements
    // fall silent — the deck is the sounding source from here.
    this.current = { track, facts: entry.facts };
    this.pendingCurrent = null;
    this.phase = "live";
    this.startStateValue = "ready";
    this.startFailureValue = null;
    this.deckWatch = null;
    this.deps.player.pausePlainPlayback?.();
    this.deps.player.setCurrentTrack(track, index);
    // The store's timeline is the session's to publish from the
    // first deck beat: position (the deck's), duration, status.
    this.publishPlaybackState();
    this.narrate(
      "started",
      this.pendingAutoResume
        ? `Set resumed with "${track.title}"`
        : `Set started with "${track.title}"`,
    );
    this.pumpPrep();
  }

  /**
   * Ends the preparing phase without a takeover: the settled
   * failure (or the night's own end) is published through the
   * same running-change notice the gated start used, so the
   * intent wiring arms its retry exactly as before.
   */
  private endPreparing(outcome: {
    endReason: SessionEndReason;
    failed: boolean;
    failure: string | null;
  }): void {
    if (this.tickHandle !== null) {
      this.clock.clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.running = false;
    this.phase = "idle";
    this.pendingCurrent = null;
    this.current = null;
    this.upcoming = [];
    this.endReasonValue = outcome.endReason;
    if (outcome.failed) {
      this.startStateValue = "failed";
      this.startFailureValue = outcome.failure;
    } else {
      this.startStateValue = "idle";
      this.startFailureValue = null;
    }
    this.fireRunningChange();
  }

  /**
   * The preparing phase gives up only when every queued track's
   * preparation has settled as a failure and nothing is still in
   * flight — one unresolvable track never kills the set while
   * others are still landing (their boundary takeover is the
   * first join). The recorded failure is the first failed
   * entry's own reason, in queue order.
   */
  private maybeEndPreparingFailed(): void {
    if (this.phase !== "preparing" || this.queue.length === 0) return;
    if (this.prepInFlight.size > 0) return;
    let firstFailure: string | null = null;
    for (const track of this.queue) {
      const entry = this.prepared.get(track.id);
      if (!entry || entry.status !== "failed") return;
      if (firstFailure === null) {
        firstFailure = entry.failure ?? "unprepared";
      }
    }
    this.narrate(
      "ended",
      "Session could not start: no playable track in the queue",
      "start-no-playable",
    );
    this.endPreparing({
      endReason: "start-no-playable",
      failed: true,
      failure: firstFailure,
    });
  }

  /**
   * The preparing phase's time bound (fix2-0119).
   * maybeEndPreparingFailed only fires once every preparation
   * has SETTLED as a failure — a preparation that never settles
   * (its analysis hung below the session, its source never
   * answered) blocks that give-up forever, and the phase sat
   * open indefinitely: "preparing" on the surface, nothing
   * underneath, the plain player carrying the night alone.
   * This bound cannot be blocked by in-flight work:
   *
   * - Past PREPARING_DECISION_MS with no takeover prospect (no
   *   queued track prepared WITH its buffer — the only thing
   *   boundary adoption or a takeover could ever land on), the
   *   phase ends in the visible failure state.
   * - With a prospect, the phase continues toward the boundary —
   *   that wait is the design (one unpreparable track never
   *   kills a set whose later tracks are ready) — but never past
   *   PREPARING_HARD_CAP_MS, so a boundary that never arrives
   *   cannot hold the phase open either.
   *
   * The recorded failure is honest about which: the first real
   * preparation failure in queue order when one exists, else
   * the timeout itself, named plainly.
   */
  private maybeEndPreparingTimedOut(): void {
    if (this.phase !== "preparing" || !this.pendingCurrent) return;
    const elapsed = this.clock.now() - this.preparingStartedAt;
    if (elapsed < PREPARING_DECISION_MS) return;
    const hasProspect = this.queue.some((track) => {
      const entry = this.prepared.get(track.id);
      return entry?.status === "ready" && entry.buffer !== null;
    });
    if (hasProspect && elapsed < PREPARING_HARD_CAP_MS) return;
    let firstFailure: string | null = null;
    for (const track of this.queue) {
      const entry = this.prepared.get(track.id);
      if (
        entry &&
        entry.status === "failed" &&
        entry.failure &&
        entry.failure !== "not prepared yet"
      ) {
        firstFailure = entry.failure;
        break;
      }
    }
    const failure =
      firstFailure ??
      (hasProspect
        ? "no prepared track was reached in time"
        : `preparation of "${this.pendingCurrent.track.title}" did not finish in time`);
    this.narrate(
      "ended",
      `Session could not start: ${failure}`,
      "start-no-playable",
    );
    this.endPreparing({
      endReason: "start-no-playable",
      failed: true,
      failure,
    });
  }

  stop(reason: SessionEndReason = "user-stop"): void {
    this.stopInternal(reason);
  }

  private stopInternal(reason: SessionEndReason): void {
    const wasRunning = this.running;
    const wasPreparing = this.phase === "preparing";
    // Publish the settled position/duration before the decks stop
    // and `current` clears; the settled status ("paused" — the
    // player is left paused on the current track) lands below,
    // once the teardown has run. A session that never ran
    // publishes nothing: a declined start (repeat-one, no
    // playable track) must not clobber the plain player's state.
    if (wasRunning) this.publishPositionDuration();
    if (wasPreparing) {
      // The plain element is the sounding one in this phase; a
      // deliberate stop leaves the player paused on the track,
      // exactly as a live stop does.
      this.deps.player.pausePlainPlayback?.();
    }
    this.phase = "idle";
    this.pendingCurrent = null;
    this.startStateValue = "idle";
    this.startFailureValue = null;
    this.generation += 1;
    if (this.tickHandle !== null) {
      this.clock.clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.buyTime) {
      try {
        this.performer?.setManualLoop("A", null);
      } catch {
        // stopAll below supersedes any loop state anyway.
      }
      this.buyTime = null;
    }
    this.activeJoin = null;
    this.preview = null;
    this.deferredDeckEnd = null;
    this.deckWatch = null;
    this.setBlending(false);
    try {
      this.performer?.stopAll();
    } catch {
      // A performer failure at stop must not trap the session open.
    }
    this.running = false;
    this.pausedFlag = false;
    this.endReasonValue = reason;
    this.current = null;
    this.upcoming = [];
    if (wasRunning) {
      this.publishStatus("paused");
      this.narrate("ended", `Set ended (${reason})`, reason);
      this.fireRunningChange();
    }
  }

  // -- the decision loop --------------------------------------------------------

  private tick(): void {
    if (!this.running) return;
    if (this.phase === "preparing") {
      // The preparing phase has its own heartbeat: it watches
      // the plain player's track, retries preparation, and takes
      // over — it never publishes (the plain player owns the
      // store's timeline until the decks do).
      this.preparingTick();
      return;
    }
    // AUTHORITY WATCH (fix2-0119): while the session is live the
    // deck is the ONLY sounding source and the ONLY position.
    // Runs even while paused (a foreign element sounding under a
    // paused session is still re-silenced); a loss stops the
    // session, so re-check before continuing.
    this.authorityTick();
    if (!this.running) return;
    if (this.pausedFlag || !this.current || !this.performer) {
      return;
    }
    // The publishing rhythm mediaClock's contract names: every
    // tick, the sounding deck's position + the current track's
    // duration land in the player store. First, so even a tick
    // that completes a join or ends the deck has already told the
    // store where the outgoing track had reached (the completion
    // paths then publish the incoming track's state themselves).
    this.publishPositionDuration();
    const performer = this.performer;

    // A sounding join completes when the nominal position passes
    // the overlap's end on the outgoing's grid.
    if (this.activeJoin) {
      let position = 0;
      try {
        position = performer.positionMs("A");
      } catch {
        return;
      }
      if (position >= this.activeJoin.overlapEndPosMs) {
        this.completeJoin();
      }
      return;
    }

    if (this.buyTime) {
      this.updateBuyTime();
      return;
    }

    const facts = this.current.facts;
    const duration = facts.durationMs;
    let position = 0;
    try {
      position = performer.positionMs("A");
    } catch {
      return;
    }

    // Deck-end with nothing committed: the terminal path.
    if (
      this.deckEndedPending ||
      (duration !== null && duration > 0 && position >= duration - 30)
    ) {
      this.deckEndedPending = false;
      void this.handleDeckEnd();
      return;
    }

    if (this.deciding || duration === null || duration <= 0) return;
    const remaining = duration - position;
    const horizon = Math.min(
      PLANNING_HORIZON_MAX_MS,
      duration * PLANNING_HORIZON_FRACTION,
    );
    if (remaining > horizon) return;

    // The minimum-play floor binds AUTONOMOUS decisions only.
    if (facts.minimumPlayMs !== null && position < facts.minimumPlayMs) {
      return;
    }
    void this.runDecision();
  }

  private setPreview(result: ConsiderResult): void {
    this.preview = {
      trackId: result.trackB.trackId,
      trackTitle: this.titleOf(result.trackB.trackId),
      family: result.recipe.family,
      technique: result.recipe.technique,
      suitability: result.suitability,
      poolSize: result.poolSize,
      pool: result.pool,
      recipe: result.recipe,
    };
  }

  private async runDecision(): Promise<void> {
    if (this.deciding || !this.current) return;
    this.deciding = true;
    const generation = this.generation;
    try {
      // JOINABLE MEANS BUFFER IN HAND (fix2-0119): the draw runs
      // over entries that can actually sound — facts AND the
      // decoded buffer. A facts-ready entry whose buffer never
      // landed is excluded here, its exclusion narrated once and
      // a repair re-preparation kicked, instead of being drawn
      // and degrading at commit time. (In the shipped source the
      // buffer lands with the resolve, before facts — so this is
      // a belt over the seam: candidacy can no longer outrun the
      // audio by construction.)
      const ready = this.readyEntries();
      const joinable: PreparedEntry[] = [];
      for (const entry of ready) {
        if (entry.buffer) {
          this.bufferlessExcluded.delete(entry.track.id);
          joinable.push(entry);
        } else {
          this.excludeBufferless(entry);
        }
      }
      if (joinable.length === 0) return; // still preparing, or nothing joinable left
      const factsA = this.current.facts;
      this.narrate(
        "authoring",
        `Authoring the next join from "${this.current.track.title}" — ${joinable.length} prepared option${joinable.length === 1 ? "" : "s"}`,
      );
      let result = this.deps.brain.consider({
        factsA,
        optionsB: joinable.map((entry) => entry.facts as TrackFacts),
        arcPosition: this.arcPosition(),
        shaping: this.shaping,
        memory: this.deps.memory,
      });
      if (!result) {
        // The brain found no candidate above its suitability
        // floor in a NON-EMPTY joinable pool. That outcome used
        // to be silent — the window just passed. Narrate it
        // (once per current track) so a quiet window is a
        // explained window (fix2-0119).
        if (this.noCandidateNarratedFor !== this.current.track.id) {
          this.noCandidateNarratedFor = this.current.track.id;
          this.narrate(
            "authoring",
            `No join drawn into the next track — ${joinable.length} prepared option${joinable.length === 1 ? "" : "s"} scored below the brain's suitability floor this window`,
          );
        }
        return;
      }
      if (generation !== this.generation || !this.running) return;
      this.setPreview(result);
      this.narrate(
        "drawn",
        `Drew ${result.recipe.family}${result.recipe.technique ? ` (${result.recipe.technique})` : ""} into "${this.titleOf(result.trackB.trackId)}" — suitability ${result.suitability.toFixed(2)}, pool of ${result.poolSize}`,
      );

      // Structural validation: a drawn recipe that fails is
      // discarded and re-drawn ONCE from the remaining pool; a
      // second failure is a plain cut, recorded fallback-invalid.
      const errors = validateRecipe(result.recipe, factsA, result.trackB);
      if (errors.length > 0) {
        const invalid = result;
        this.narrate(
          "degraded",
          `Drawn ${invalid.recipe.family} recipe failed structural validation (${errors.join("; ")}) — re-drawing once`,
          "fallback-invalid",
        );
        const rest = joinable.filter(
          (entry) => entry.track.id !== invalid.trackB.trackId,
        );
        let second: ConsiderResult | null = null;
        if (rest.length > 0) {
          second = this.deps.brain.consider({
            factsA,
            optionsB: rest.map((entry) => entry.facts as TrackFacts),
            arcPosition: this.arcPosition(),
            shaping: this.shaping,
            memory: this.deps.memory,
          });
        }
        if (
          second &&
          validateRecipe(second.recipe, factsA, second.trackB).length === 0
        ) {
          result = second;
          this.setPreview(result);
          this.narrate(
            "drawn",
            `Re-drew ${result.recipe.family} into "${this.titleOf(result.trackB.trackId)}"`,
          );
        } else {
          const target = this.firstReadyWithBuffer();
          this.preview = null;
          if (target) {
            this.plainStart(target, {
              fallback: "fallback-invalid",
              recipe: invalid.recipe,
              suitability: invalid.suitability,
              poolSize: invalid.poolSize,
            });
          } else {
            this.recordJoin({
              family: invalid.recipe.family,
              technique: invalid.recipe.technique,
              fxKinds: fxKindsOfRecipe(invalid.recipe),
              pairTrackIds: [this.current.track.id, invalid.trackB.trackId],
              suitability: invalid.suitability,
              poolSize: invalid.poolSize,
              fallback: "fallback-invalid",
            });
            void this.handleExhaustion();
          }
          return;
        }
      }

      // Buy-time: the drawn track has facts but no decoded buffer.
      // Unreachable from the autonomous draw since fix2-0119 (the
      // draw only runs over joinable entries, and nothing clears
      // a buffer once landed) — kept as the commit-time safety
      // net the seam always had.
      const entryB = this.prepared.get(result.trackB.trackId);
      if (!entryB || !entryB.buffer) {
        this.startBuyTime(result);
        return;
      }
      await this.commitJoin(result, "auto");
    } finally {
      this.deciding = false;
      // A deck end deferred while this decision committed (see
      // handleDeckEnd): run it now if the commit did not land a
      // join and the same track is still current.
      const deferred = this.deferredDeckEnd;
      this.deferredDeckEnd = null;
      if (
        deferred &&
        this.running &&
        this.phase === "live" &&
        !this.activeJoin &&
        !this.buyTime &&
        this.current?.track.id === deferred.trackId
      ) {
        void this.handleDeckEnd();
      }
    }
  }

  /**
   * Excludes a facts-ready but bufferless entry from the draw
   * (fix2-0119): narrated ONCE per exclusion episode, and a
   * repair re-preparation is kicked — prep re-resolves the
   * track, and the resolve is what lands the buffer. The entry
   * rejoins candidacy the moment its buffer lands (runDecision
   * prunes the episode marker when it sees the buffer).
   */
  private excludeBufferless(entry: PreparedEntry): void {
    if (this.bufferlessExcluded.has(entry.track.id)) return;
    this.bufferlessExcluded.add(entry.track.id);
    this.narrate(
      "degraded",
      `"${entry.track.title}" is analysed but its audio is not decoded yet — left out of this draw while it re-prepares`,
    );
    void this.prepTrack(entry.track, "fast", true);
  }

  // -- performing joins -----------------------------------------------------------

  private async commitJoin(
    result: ConsiderResult,
    recordMode: "auto" | "user-act",
  ): Promise<void> {
    if (!this.current || !this.performer) return;
    const entryB = this.prepared.get(result.trackB.trackId);
    if (!entryB || !entryB.buffer || !entryB.facts) return;
    const performer = this.performer;
    const factsA = this.current.facts;
    const recipe = result.recipe;
    performer.loadDeck("B", {
      trackId: entryB.track.id,
      buffer: entryB.buffer,
      facts: entryB.facts,
    });
    const untrusted = !(
      factsA.beatmatchTrusted && result.trackB.beatmatchTrusted
    );
    if (untrusted) {
      this.narrate(
        "degraded",
        `Join into "${entryB.track.title}" is degraded-untrusted — the pair's tempo/grid evidence is below the trust lines, so the join performs at rate 1`,
        "degraded-untrusted",
      );
    }
    await performer.performRecipe(recipe);
    if (!this.running) return; // stopped while the rendition rendered
    // Overlap end on the outgoing's nominal clock: the exit anchor
    // plus overlapBeats on A's grid (falling back to tempo math).
    const exitBeat = recipe.outgoing.exitBeat;
    const endByGrid = factsA.timeAtBeatMs(exitBeat + recipe.overlapBeats);
    const msPerBeat =
      factsA.tempo.bpm && factsA.tempo.bpm > 0
        ? 60_000 / factsA.tempo.bpm
        : 500;
    const overlapEndPosMs =
      endByGrid ??
      recipe.outgoing.exitAnchorMs + recipe.overlapBeats * msPerBeat;
    this.activeJoin = {
      recipe,
      trackB: entryB.track,
      factsB: result.trackB,
      suitability: result.suitability,
      poolSize: result.poolSize,
      recordMode,
      untrusted,
      overlapEndPosMs,
    };
    this.setBlending(true);
    this.narrate(
      "performing",
      `Performing ${recipe.family}${recipe.technique ? ` (${recipe.technique})` : ""} into "${entryB.track.title}"`,
    );
  }

  private completeJoin(): void {
    const join = this.activeJoin;
    if (!join || !this.current || !this.performer) return;
    this.activeJoin = null;
    this.setBlending(false);
    const performer = this.performer;
    const outgoing = this.current;
    try {
      performer.swapRoles();
      performer.pauseDeck("B");
      performer.unloadDeck("B");
    } catch {
      // The record below still lands; the night continues on state.
    }
    this.current = { track: join.trackB, facts: join.factsB };
    this.played.add(join.trackB.id);
    this.history.push(join.trackB);
    const queueIndex = this.queue.findIndex((t) => t.id === join.trackB.id);
    this.deps.player.setCurrentTrack(
      join.trackB,
      queueIndex >= 0 ? queueIndex : this.deps.player.getState().currentIndex,
    );
    // Track change: setCurrentTrack reset the store position to
    // 0; publish the incoming deck's real position (after the
    // swap it is side A, already into the track by the overlap),
    // its duration, and the status in the same step.
    this.publishPlaybackState();
    this.recordJoin({
      family: join.recipe.family,
      technique: join.recipe.technique,
      fxKinds: fxKindsOfRecipe(join.recipe),
      pairTrackIds: [outgoing.track.id, join.trackB.id],
      suitability: join.suitability,
      poolSize: join.poolSize,
      userAct: join.recordMode === "user-act",
      untrusted: join.untrusted,
    });
    this.preview = null;
    this.narrate(
      "performing",
      `Now playing "${join.trackB.title}" — ${join.recipe.family} join complete`,
    );
    this.pumpPrep();
  }

  /**
   * A plain cut: the next ready track starts plainly on the free
   * deck, no recipe. ONLY ever a recorded terminal fallback or a
   * user act — never a silent degradation.
   */
  private plainStart(
    entry: PreparedEntry,
    opts: {
      fallback?: "fallback-unprepared" | "fallback-invalid";
      userAct?: boolean;
      recipe?: JoinRecipe | null;
      suitability?: number | null;
      poolSize?: number;
    } = {},
  ): void {
    if (!this.current || !this.performer || !entry.buffer || !entry.facts) {
      return;
    }
    const performer = this.performer;
    const outgoing = this.current;
    try {
      performer.loadDeck("B", {
        trackId: entry.track.id,
        buffer: entry.buffer,
        facts: entry.facts,
      });
      performer.playDeck("B");
      performer.pauseDeck("A");
      performer.swapRoles();
      performer.unloadDeck("B");
    } catch {
      // State below still advances: the record must not be lost.
    }
    this.current = { track: entry.track, facts: entry.facts };
    this.played.add(entry.track.id);
    this.history.push(entry.track);
    const queueIndex = this.queue.findIndex((t) => t.id === entry.track.id);
    this.deps.player.setCurrentTrack(
      entry.track,
      queueIndex >= 0 ? queueIndex : this.deps.player.getState().currentIndex,
    );
    // Track change, as in completeJoin: publish the new current
    // deck's position, duration and status with the swap.
    this.publishPlaybackState();
    this.recordJoin({
      family: opts.recipe?.family ?? null,
      technique: opts.recipe?.technique,
      fxKinds: opts.recipe ? fxKindsOfRecipe(opts.recipe) : [],
      pairTrackIds: [outgoing.track.id, entry.track.id],
      suitability: opts.suitability ?? null,
      poolSize: opts.poolSize ?? 0,
      fallback: opts.fallback,
      userAct: opts.userAct,
    });
    if (opts.fallback) {
      this.narrate(
        "fallback",
        `Plain cut into "${entry.track.title}" — ${opts.fallback}`,
        opts.fallback,
      );
    }
    this.pumpPrep();
  }

  // -- buy-time ----------------------------------------------------------------

  private startBuyTime(result: ConsiderResult): void {
    if (!this.current || !this.performer) return;
    const factsA = this.current.facts;
    // Loop the playing deck over its facts' tail loop span, or the
    // last 16 beats when no span was measured.
    let span = factsA.loopSpans[factsA.loopSpans.length - 1] ?? null;
    if (!span) {
      const duration = factsA.durationMs ?? 0;
      const msPerBeat =
        factsA.tempo.bpm && factsA.tempo.bpm > 0
          ? 60_000 / factsA.tempo.bpm
          : 500;
      span = {
        startMs: Math.max(0, duration - 16 * msPerBeat),
        endMs: duration,
      };
    }
    try {
      this.performer.setManualLoop("A", span);
    } catch {
      // Buy-time without a loop is just waiting; the caps still bind.
    }
    this.buyTime = {
      result,
      startedAt: this.clock.now(),
      span,
      wraps: 0,
      lastPrepRetryAt: this.clock.now(),
    };
    this.narrate(
      "buy-time",
      `Buying time for "${this.titleOf(result.trackB.trackId)}" — looping the tail of "${this.current.track.title}" while its buffer lands (max ${BUY_TIME_MAX_WRAPS} wraps / ${BUY_TIME_MAX_MS / 1000} s)`,
    );
    // Make sure the target is actually being prepared — including
    // a forced retry when its facts are ready but the buffer is
    // the thing that never landed.
    const target = this.upcoming.find((t) => t.id === result.trackB.trackId);
    if (target) {
      const entry = this.prepared.get(target.id);
      if (!entry || entry.status === "failed" || !entry.buffer) {
        void this.prepTrack(target, "fast", true);
      }
    }
  }

  private updateBuyTime(): void {
    const buyTime = this.buyTime;
    if (!buyTime || !this.performer) return;
    const entry = this.prepared.get(buyTime.result.trackB.trackId);
    if (entry && entry.buffer && entry.facts && entry.status === "ready") {
      // The buffer landed: commit the drawn join, late but whole.
      try {
        this.performer.setManualLoop("A", null);
      } catch {
        // The recipe's own scheduling supersedes the loop.
      }
      const result = buyTime.result;
      this.buyTime = null;
      this.narrate(
        "buy-time",
        `Buffer for "${entry.track.title}" landed after ${buyTime.wraps} wrap${buyTime.wraps === 1 ? "" : "s"} — committing the drawn join late`,
      );
      void this.commitJoin(result, "auto");
      return;
    }
    // Still no buffer: keep trying, at a paced rate, until the
    // caps below call it.
    if (
      !this.prepInFlight.has(buyTime.result.trackB.trackId) &&
      this.clock.now() - buyTime.lastPrepRetryAt >= BUY_TIME_PREP_RETRY_MS
    ) {
      buyTime.lastPrepRetryAt = this.clock.now();
      const target = this.upcoming.find(
        (t) => t.id === buyTime.result.trackB.trackId,
      );
      if (target) void this.prepTrack(target, "fast", true);
    }
    const elapsed = this.clock.now() - buyTime.startedAt;
    const spanMs = Math.max(1, buyTime.span.endMs - buyTime.span.startMs);
    buyTime.wraps = Math.floor(elapsed / spanMs);
    if (buyTime.wraps > BUY_TIME_MAX_WRAPS || elapsed > BUY_TIME_MAX_MS) {
      try {
        this.performer.setManualLoop("A", null);
      } catch {
        // Nothing to release cleanly; the cut below supersedes.
      }
      const drawn = buyTime.result;
      this.buyTime = null;
      this.preview = null;
      this.narrate(
        "fallback",
        `Buy-time exhausted for "${this.titleOf(drawn.trackB.trackId)}" (${buyTime.wraps} wraps, ${Math.round(elapsed / 1000)} s) — plain cut`,
        "fallback-unprepared",
      );
      const target = this.firstReadyWithBuffer(drawn.trackB.trackId);
      if (target) {
        this.plainStart(target, {
          fallback: "fallback-unprepared",
          recipe: drawn.recipe,
          suitability: drawn.suitability,
          poolSize: drawn.poolSize,
        });
      } else {
        this.recordJoin({
          family: drawn.recipe.family,
          technique: drawn.recipe.technique,
          fxKinds: fxKindsOfRecipe(drawn.recipe),
          pairTrackIds: [this.current?.track.id ?? "", drawn.trackB.trackId],
          suitability: drawn.suitability,
          poolSize: drawn.poolSize,
          fallback: "fallback-unprepared",
        });
        void this.handleExhaustion();
      }
    }
  }

  // -- deck end / exhaustion -------------------------------------------------------

  private async handleDeckEnd(): Promise<void> {
    if (!this.running || !this.current) return;
    // A decision is mid-commit — its rendition can render for
    // seconds while deck A plays out its last stretch. The end
    // must not pre-empt the drawn join with a plain cut: defer
    // it; runDecision's finally re-runs it if the commit did
    // not land a join (fix2-0119 — the deciding race).
    if (this.deciding) {
      this.deferredDeckEnd = { trackId: this.current.track.id };
      return;
    }
    const ready = this.firstReadyWithBuffer();
    if (ready) {
      this.plainStart(ready, { fallback: "fallback-unprepared" });
      return;
    }
    // Nothing ready: give the next unplayed track one fast chance.
    const nextUnplayed = this.upcoming.find((t) => !this.played.has(t.id));
    if (nextUnplayed) {
      const entry = await this.prepOne(nextUnplayed, "fast");
      if (!this.running) return;
      if (entry.status === "ready" && entry.buffer && entry.facts) {
        this.plainStart(entry, { fallback: "fallback-unprepared" });
        return;
      }
    }
    this.handleExhaustion();
  }

  private handleExhaustion(): void {
    if (!this.running || !this.current) return;
    const repeat = this.deps.player.getState().repeat;
    if (repeat === "all" && this.queue.length > 1) {
      // Addendum B: cycle the queue; the arc keeps its shape (the
      // brain still sees tonight's position via history).
      this.played.clear();
      this.played.add(this.current.track.id);
      this.upcoming = this.queue.filter((t) => t.id !== this.current!.track.id);
      this.narrate(
        "started",
        "Queue exhausted — cycling from the top (repeat-all is on)",
      );
      this.pumpPrep();
      return;
    }
    this.deps.behaviourLog.record({
      at: this.clock.now(),
      family: null,
      fxKinds: [],
      pairTrackIds: [this.current.track.id, this.current.track.id],
      suitability: null,
      poolSize: 0,
      reason: "set-end",
    });
    this.stopInternal("queue-exhausted");
  }

  // -- user acts (floor-exempt) ------------------------------------------------------

  skipNext(): void {
    if (!this.running) return;
    if (this.phase === "preparing") {
      // No decks to skip on yet: the set stands down and the
      // plain player takes the skip itself (the stop lands first,
      // so the command channel falls through to the engine).
      this.narrate(
        "user-act",
        "Skip next while the set is preparing — the set stands down and the plain player takes the skip (user act)",
      );
      this.stopInternal("user-stop");
      this.deps.player.dispatchCommand?.({ type: "SKIP_NEXT" });
      return;
    }
    if (!this.current) return;
    this.narrate("user-act", "Skip next (user act — the floor does not bind)");
    if (this.buyTime) {
      const buyTime = this.buyTime;
      this.buyTime = null;
      try {
        this.performer?.setManualLoop("A", null);
      } catch {
        // Superseded by whatever starts next.
      }
      const entry = this.prepared.get(buyTime.result.trackB.trackId);
      if (entry && entry.buffer && entry.facts) {
        void this.commitJoin(buyTime.result, "user-act");
        return;
      }
      const target = this.firstReadyWithBuffer();
      if (target) {
        this.plainStart(target, { userAct: true });
      } else {
        void this.handleDeckEnd();
      }
      return;
    }
    if (this.activeJoin) {
      // A decision is committed: perform it immediately by
      // completing the join now.
      this.activeJoin.recordMode = "user-act";
      this.completeJoin();
      return;
    }
    const target = this.firstReadyWithBuffer();
    if (target) {
      this.plainStart(target, { userAct: true });
    } else {
      void this.handleDeckEnd();
    }
  }

  skipPrevious(): void {
    if (!this.running) return;
    if (this.phase === "preparing") {
      this.narrate(
        "user-act",
        "Skip previous while the set is preparing — the set stands down and the plain player takes the skip (user act)",
      );
      this.stopInternal("user-stop");
      this.deps.player.dispatchCommand?.({ type: "SKIP_PREVIOUS" });
      return;
    }
    if (!this.current) return;
    this.narrate(
      "user-act",
      "Skip previous (user act — the floor does not bind)",
    );
    if (this.history.length < 2) {
      this.seekTo(0);
      return;
    }
    const previous = this.history[this.history.length - 2];
    const entry = this.prepared.get(previous.id);
    if (entry && entry.buffer && entry.facts) {
      // History is a play log: going back is a new play of it.
      this.history.pop(); // drop the current play; plainStart re-appends
      this.plainStart(entry, { userAct: true });
    } else if (entry) {
      void this.prepTrack(previous, "fast").then(() => {
        const refreshed = this.prepared.get(previous.id);
        if (refreshed && refreshed.buffer && refreshed.facts && this.running) {
          this.plainStart(refreshed, { userAct: true });
        }
      });
    }
  }

  pause(): void {
    if (!this.running || this.pausedFlag) return;
    if (this.phase === "preparing") {
      // The plain element is the sounding one: pause it, and the
      // flag carries into the takeover (the deck loads paused).
      this.deps.player.pausePlainPlayback?.();
      this.pausedFlag = true;
      this.publishStatus("paused");
      return;
    }
    if (!this.performer) return;
    try {
      this.performer.pauseDeck("A");
      if (this.activeJoin) this.performer.pauseDeck("B");
    } catch {
      // State below still records the pause intent.
    }
    this.pausedFlag = true;
    // The decks have frozen: publish the frozen position and the
    // "paused" status (mediaClock's lyrics carry keys off it).
    this.publishPlaybackState();
  }

  resume(): void {
    if (!this.running || !this.pausedFlag) return;
    // A resume is a fresh chance for a suspended performer
    // context (fix2-0119) — and a resume usually rides a real
    // user gesture, the exact thing the browser was waiting for.
    this.ensurePerformerContext();
    if (this.phase === "preparing") {
      // Note 32, preparing edition: a different store track than
      // the pending one means the night was replaced while paused.
      const storeTrack = this.deps.player.getState().currentTrack;
      if (
        storeTrack &&
        this.pendingCurrent &&
        storeTrack.id !== this.pendingCurrent.track.id
      ) {
        this.narrate(
          "ended",
          `Resume refused: the player's current track is now "${storeTrack.title}" — this set was replaced while paused (Note 32)`,
          "replaced",
        );
        this.endPreparing({
          endReason: "replaced",
          failed: false,
          failure: null,
        });
        return;
      }
      this.deps.player.resumePlainPlayback?.();
      this.pausedFlag = false;
      this.publishStatus("playing");
      return;
    }
    if (!this.performer || !this.current) {
      return;
    }
    // Note 32 on resume: if the store's current track changed
    // while paused, the night was replaced — end, don't resume
    // over someone else's pick.
    const storeTrack = this.deps.player.getState().currentTrack;
    if (storeTrack && storeTrack.id !== this.current.track.id) {
      this.narrate(
        "ended",
        `Resume refused: the player's current track is now "${storeTrack.title}" — this set was replaced while paused (Note 32)`,
        "replaced",
      );
      this.stopInternal("replaced");
      return;
    }
    try {
      this.performer.playDeck("A");
      if (this.activeJoin) this.performer.playDeck("B");
    } catch {
      // State below still clears the pause.
    }
    this.pausedFlag = false;
    // Resumed: position/duration again, and status "playing".
    this.publishPlaybackState();
  }

  seekTo(positionMs: number): void {
    if (!this.running || !this.performer) return;
    if (this.activeJoin) {
      // SIMPLIFICATION (named in the header): a sounding join does
      // not survive a seek — the incoming deck is cancelled back
      // to single-deck playback and the preview is cleared.
      try {
        this.performer.pauseDeck("B");
        this.performer.unloadDeck("B");
      } catch {
        // The seek below still applies to deck A.
      }
      this.activeJoin = null;
      this.preview = null;
      this.setBlending(false);
      this.narrate(
        "user-act",
        "Seek cancelled the sounding join — back to single-deck playback (a join's automation is scheduled against the position it was authored at)",
      );
    }
    if (this.buyTime) {
      try {
        this.performer.setManualLoop("A", null);
      } catch {
        // The seek supersedes the loop.
      }
      this.buyTime = null;
      this.preview = null;
      this.narrate("user-act", "Seek cancelled buy-time");
    }
    try {
      this.performer.seekTo("A", Math.max(0, positionMs));
    } catch {
      // A failed seek leaves playback where it was.
    }
    // The position jumped: publish it now rather than leaving the
    // store at the pre-seek position until the next tick (a paused
    // session has no next tick coming).
    this.publishPositionDuration();
  }

  // -- manual moves (the ONLY manual-move path, §4 invariant 7) -----------------------

  async triggerDeckMove(request: DeckMoveRequest): Promise<DeckMoveResult> {
    if (this.phase === "preparing") {
      return {
        ok: false,
        reason:
          "the set is still preparing — the decks have not taken over yet",
      };
    }
    if (!this.running || !this.current) {
      return { ok: false, reason: "no session is running" };
    }
    if (this.activeJoin || this.buyTime) {
      return { ok: false, reason: "join-locked" };
    }
    const factsA = this.current.facts;
    const nextEntry = this.readyEntries()[0];
    if (!nextEntry || !nextEntry.facts) {
      return {
        ok: false,
        reason: "no prepared next track to move into",
      };
    }
    // The SAME authors as the autonomous path — bypassing only
    // the draw and the floor, never the authoring (§4.7).
    const { candidates, rejected } = authorCandidates(factsA, nextEntry.facts, {
      arcPosition: this.arcPosition(),
      shaping: this.shaping,
    });
    let filtered = candidates.filter((c) => c.family === request.kind);
    if (request.technique) {
      filtered = filtered.filter((c) => c.technique === request.technique);
    }
    if (request.jogKind) {
      filtered = filtered.filter((c) =>
        c.blocks.some(
          (block) => block.type === "jog" && block.kind === request.jogKind,
        ),
      );
    }
    if (filtered.length === 0) {
      const reasons = rejected
        .filter((r) => r.family === request.kind)
        .map((r) => r.reason);
      return {
        ok: false,
        reason:
          reasons.length > 0
            ? reasons.join("; ")
            : `the authors produced no ${request.kind} candidate for this pair`,
      };
    }
    let best = filtered[0];
    let bestSuitability = this.deps.brain.suitability(best);
    for (const candidate of filtered.slice(1)) {
      const value = this.deps.brain.suitability(candidate);
      if (value > bestSuitability) {
        best = candidate;
        bestSuitability = value;
      }
    }
    if (!nextEntry.buffer) {
      return {
        ok: false,
        reason:
          "the incoming track is analysed but its buffer is not decoded yet",
      };
    }
    const errors = validateRecipe(best, factsA, nextEntry.facts);
    if (errors.length > 0) {
      return {
        ok: false,
        reason: `the authored ${request.kind} failed structural validation: ${errors.join("; ")}`,
      };
    }
    const result: ConsiderResult = {
      trackB: nextEntry.facts,
      recipe: best,
      suitability: bestSuitability,
      poolSize: filtered.length,
      pool: filtered.map((recipe) => ({
        trackId: nextEntry.track.id,
        family: recipe.family,
        technique: recipe.technique,
        fxKinds: fxKindsOfRecipe(recipe),
        suitability: this.deps.brain.suitability(recipe),
        evidence: { ...recipe.authored.evidence },
      })),
    };
    this.setPreview(result);
    this.narrate(
      "user-act",
      `Manual ${request.kind}${request.technique ? ` (${request.technique})` : ""} into "${nextEntry.track.title}" — authored by the same authors as the autonomous path`,
    );
    await this.commitJoin(result, "user-act");
    return { ok: true, recipe: best };
  }

  // -- curation -----------------------------------------------------------------------

  async curateRemaining(): Promise<CurateResult> {
    if (!this.running || !this.current) {
      return { ok: false, reason: "no session is running" };
    }
    if (this.activeJoin || this.buyTime) {
      return { ok: false, reason: "join-locked" };
    }
    const readyUpcoming = this.readyEntries();
    if (readyUpcoming.length < 2) {
      return { ok: false, reason: "not-enough-ready" };
    }
    const factsList = [
      this.current.facts,
      ...readyUpcoming.map((entry) => entry.facts as TrackFacts),
    ];
    const assembled = this.deps.brain.assembleSet(factsList, this.shaping);
    // History + current stay fixed; only the upcoming order moves.
    // assembleSet chooses its own opener — the session's current
    // track is removed from its list wherever it landed and the
    // rest of its order is adopted for the ready upcoming tracks.
    const orderedReadyIds = assembled.orderedIds.filter(
      (id) => id !== this.current!.track.id,
    );
    const byId = new Map(
      readyUpcoming.map((entry) => [entry.track.id, entry.track]),
    );
    const reordered: Track[] = [];
    for (const id of orderedReadyIds) {
      const track = byId.get(id);
      if (track) reordered.push(track);
    }
    const reorderedIds = new Set(reordered.map((t) => t.id));
    const remainder = this.upcoming.filter(
      (t) => !this.played.has(t.id) && !reorderedIds.has(t.id),
    );
    this.upcoming = [...reordered, ...remainder];
    const historyPart = this.history.filter(
      (t) => t.id !== this.current!.track.id,
    );
    this.queue = [...historyPart, this.current.track, ...this.upcoming];
    this.deps.player.setQueue(this.queue);
    this.deps.player.setCurrentTrack(
      this.current.track,
      this.queue.findIndex((t) => t.id === this.current!.track.id),
    );
    this.narrate(
      "curated",
      `Reordered the rest of the set as a DJ set — ${reordered.length} prepared tracks re-sequenced by the brain's set assembly`,
    );
    return { ok: true };
  }

  // -- visibility seams -----------------------------------------------------------------

  stageSnapshot(): SessionStageSnapshot | null {
    if (!this.performer || !this.current) return null;
    const toDeck = (snapshot: DeckSnapshot): StageDeckSnapshot => {
      const facts = snapshot.trackId
        ? this.prepared.get(snapshot.trackId)?.facts
        : undefined;
      return {
        trackId: snapshot.trackId,
        positionMs: snapshot.positionMs,
        positionSec: snapshot.trackId ? snapshot.positionMs / 1000 : null,
        playing: snapshot.playing,
        rate: snapshot.rate,
        facts: facts
          ? {
              bpm: facts.tempo.bpm,
              keyCamelot: facts.key?.camelot ?? null,
              beatmatchTrusted: facts.beatmatchTrusted,
              energyNow: facts.energyContour.energyAt(snapshot.positionMs),
              energyContour: facts.energyContour.bins,
            }
          : null,
      };
    };
    let decks: [StageDeckSnapshot, StageDeckSnapshot];
    try {
      decks = [
        toDeck(this.performer.snapshot("A")),
        toDeck(this.performer.snapshot("B")),
      ];
    } catch {
      return null;
    }
    let currentMove: StageCurrentMove | null = null;
    if (this.activeJoin) {
      currentMove = {
        label: `${this.activeJoin.recipe.family} into ${this.activeJoin.trackB.title}`,
        family: this.activeJoin.recipe.family,
        technique: this.activeJoin.recipe.technique ?? null,
      };
    } else if (this.preview) {
      currentMove = {
        label: `Next: ${this.preview.family} into ${this.preview.trackTitle}`,
        family: this.preview.family,
        technique: this.preview.technique ?? null,
      };
    } else if (this.buyTime) {
      currentMove = {
        label: `Buying time for ${this.titleOf(this.buyTime.result.trackB.trackId)}`,
        family: null,
        technique: null,
      };
    }
    return { decks, currentMove, controlLevel: this.controlLevelValue };
  }

  setArc(): { played: number[]; upcoming: number[] } {
    const energyOf = (trackId: string): number | null => {
      const facts =
        this.current?.track.id === trackId
          ? this.current.facts
          : (this.prepared.get(trackId)?.facts ?? null);
      return facts ? trackEnergyLevel(facts) : null;
    };
    const played: number[] = [];
    for (const track of this.history) {
      const energy = energyOf(track.id);
      if (energy !== null) played.push(energy);
    }
    const upcoming: number[] = [];
    for (const track of this.upcoming) {
      if (this.played.has(track.id)) continue;
      const energy = energyOf(track.id);
      if (energy !== null) upcoming.push(energy);
    }
    return { played, upcoming };
  }

  getBehaviourLog(): BehaviourRecord[] {
    return this.deps.behaviourLog.getBehaviourLog();
  }

  // -- party seam -------------------------------------------------------------------------

  submitGuestRequest(track: Track, guestId = "guest"): GuestRequest {
    const request = this.party.submit(track, guestId);
    this.narrate(
      "party",
      `Guest request: "${track.title}" (${request.votes} vote${request.votes === 1 ? "" : "s"})`,
    );
    // A request for an unprepared track kicks its preparation so
    // the fit judgement has facts to judge with.
    if (this.running && !this.prepared.get(track.id)?.facts) {
      void this.prepTrack(track, "fast");
    }
    this.evaluateRequests();
    return this.party.allRequests().find((r) => r.id === request.id) ?? request;
  }

  evaluateRequests(): GuestRequest[] {
    const playedIds = new Set<string>([
      ...this.played,
      ...this.history.map((t) => t.id),
    ]);
    const results = this.party.evaluate({
      playedIds,
      doNotPlayIds: this.doNotPlay,
      fitOf: (track) => {
        if (!this.current) return null;
        const entry = this.prepared.get(track.id);
        if (!entry?.facts) return null;
        const arc = this.arcPosition();
        let fit = trackFitFor(
          this.current.facts,
          entry.facts,
          arc,
          this.shaping,
        );
        const neighbour = this.upcoming.find(
          (t) => !this.played.has(t.id) && t.id !== track.id,
        );
        const neighbourFacts = neighbour
          ? this.prepared.get(neighbour.id)?.facts
          : null;
        if (neighbourFacts) {
          fit =
            (fit +
              trackFitFor(entry.facts, neighbourFacts, arc, this.shaping)) /
            2;
        }
        return fit;
      },
    });
    if (this.running) {
      this.upcoming = this.party.insertScheduled(this.upcoming);
    }
    return results;
  }

  guestStatus(trackId: string): GuestRequestStatus | null {
    return this.party.guestStatus(trackId);
  }

  setDoNotPlay(trackIds: Iterable<string>): void {
    this.doNotPlay = new Set(trackIds);
    if (this.running) this.evaluateRequests();
  }
}

// ---------------------------------------------------------------------
// Factory + the singleton
// ---------------------------------------------------------------------

export function createSession(deps: SessionDeps): LiveRaveSession {
  return new LiveRaveSessionImpl(deps);
}

/**
 * The behaviour log over storage.ts (design §3.6: the log owns the
 * shape — memory.ts's BehaviourRecord — and storage persists it).
 * storage's appendBehaviour/listBehaviour are async module
 * functions; createBehaviourLog wants a synchronous {append, list}
 * store, so this adapter keeps the authoritative in-memory list,
 * fire-and-forgets each append through to IndexedDB, and hydrates
 * from storage on creation (best-effort: a hydration that lands
 * after new records were appended is merged by timestamp, never
 * allowed to drop tonight's records).
 */
export function createStorageBehaviourLog(): BehaviourLog {
  const records: BehaviourRecord[] = [];
  void listBehaviour()
    .then((stored) => {
      if (stored.length === 0) return;
      const merged = [...stored, ...records].sort((a, z) => a.at - z.at);
      records.length = 0;
      records.push(...merged.slice(-400));
    })
    .catch(() => {
      // Persistence is a mirror, not a dependency of the night.
    });
  return createBehaviourLog({
    append(record: BehaviourRecord): void {
      records.push(record);
      while (records.length > 400) records.shift();
      void appendBehaviour(record).catch(() => {
        // Same discipline: a failed write loses the mirror only.
      });
    },
    list(): BehaviourRecord[] {
      return [...records];
    },
  });
}

/**
 * The supply server's bearer token, when the build provides one
 * (VITE_LINERAVE_SUPPLY_TOKEN). The token is an operator secret —
 * on the server it exists only as the Worker's SUPPLY_TOKEN
 * secret; the app sends it and never persists it in settings.
 */
function supplyServerToken(): string | null {
  const value = import.meta.env.VITE_LINERAVE_SUPPLY_TOKEN as
    string | undefined;
  return typeof value === "string" && value ? value : null;
}

/**
 * A server client that reads its base URL from the settings store
 * on every call, so a URL edited in settings takes effect without
 * rebuilding the session. With no base URL configured it answers
 * every lookup with a miss and every contribution "failed".
 * createSupply consults it only while the serverMixing kill
 * switch is on (§8.3) — with the switch off this client is never
 * called at all, in either direction.
 */
function settingsServerClient(): ServerClient {
  const current = (): ServerClient | null => {
    const base = useDjSettings.getState().serverBaseUrl;
    if (!base) return null;
    const token = supplyServerToken();
    return createServerClient(base, fetch, token ? { token } : {});
  };
  return {
    async fetchTrackRead(audioHash: string) {
      const client = current();
      return client ? client.fetchTrackRead(audioHash) : null;
    },
    async fetchPairCandidates(
      aHash: string,
      bHash: string,
      arcPosition: number,
    ) {
      const client = current();
      return client
        ? client.fetchPairCandidates(aHash, bHash, arcPosition)
        : null;
    },
    async uploadTrackRead(read: TrackRead) {
      const client = current();
      return client ? client.uploadTrackRead(read) : "failed";
    },
    async uploadPairCandidates(doc: PairDocument) {
      const client = current();
      return client ? client.uploadPairCandidates(doc) : "failed";
    },
  };
}

/** Map a contribution status onto the behaviour record's reasons. */
function contributionReason(
  status: ContributionStatus,
): Extract<
  BehaviourReason,
  | "supply-contributed"
  | "supply-contribution-conflict"
  | "supply-contribution-failed"
> {
  switch (status) {
    case "stored":
    case "already-shelved":
      // Both are landings: the shelf holds this exact document.
      return "supply-contributed";
    case "conflict":
      return "supply-contribution-conflict";
    default:
      return "supply-contribution-failed";
  }
}

/**
 * The default session's supply (§8.1/§8.3): local storage, then the
 * mixing server behind the settings kill switch, then local
 * compute — and, while the switch is on, background contribution
 * of locally computed documents back to the shelf. The switch
 * defaults OFF; while it is off the server is never consulted in
 * either direction and behaviour is exactly the unwired engine's.
 *
 * Contribution outcomes are counted in the behaviour record when
 * a log is supplied (the live session passes its own): family
 * null, the document's content hashes as the pair identity, the
 * supply-* reasons from memory.ts. Silent to the listener, never
 * allowed to break the night.
 */
export function createDefaultSupply(behaviourLog?: BehaviourLog): Supply {
  return createSupply({
    server: settingsServerClient(),
    isServerEnabled: () => useDjSettings.getState().serverMixingEnabled,
    onContribution: behaviourLog
      ? (outcome: ContributionOutcome) => {
          try {
            behaviourLog.record({
              family: null,
              fxKinds: [],
              pairTrackIds:
                outcome.kind === "read"
                  ? [outcome.audioHash, outcome.audioHash]
                  : [outcome.aHash, outcome.bHash],
              suitability: null,
              poolSize: 0,
              reason: contributionReason(outcome.status),
            });
          } catch {
            // The record is a mirror, not a dependency of the night.
          }
        }
      : undefined,
  });
}

/**
 * The default session's track source (fix-0119): the decode
 * context comes from the SAME performer instance the session
 * will drive, created lazily by whichever side needs it first.
 * The pre-fix shape read a ref that only the session's
 * createPerformer call set — and the session only creates its
 * performer after a prepared opener, while preparation needs
 * the context to prepare anything at all. Every cold start
 * therefore failed preparation with "audio could not be
 * resolved or decoded" and ended start-no-playable: the DJ
 * could never start, in the real wiring, ever. Exported so the
 * cold-start order (context BEFORE any start) is test-pinned.
 */
export function createDefaultTrackSource(
  ensurePerformer: () => PerformerLike,
  overrides?: Partial<TrackSourceDeps>,
): TrackSource {
  return createTrackSource({
    ...overrides,
    // The context seam is the factory's whole point: overrides
    // may replace byte-fetching or attribution, never this.
    getContext: (): DecodeContext | null => {
      try {
        const analyser = ensurePerformer().masterAnalyser();
        return (analyser?.context as unknown as DecodeContext) ?? null;
      } catch {
        return null;
      }
    },
  });
}

function buildDefaultSession(): LiveRaveSession {
  // One performer for the whole session, created by whichever
  // need arrives first — preparation's decode context or the
  // session's takeover (see createDefaultTrackSource).
  let performerRef: PerformerLike | null = null;
  const ensurePerformer = (): PerformerLike => {
    if (!performerRef) {
      performerRef = new LiveRavePerformer(() => new AudioContext());
    }
    return performerRef;
  };
  const source = createDefaultTrackSource(ensurePerformer);
  // One behaviour log for the session AND its supply, so
  // contribution outcomes land in the same record as the joins.
  const behaviourLog = createStorageBehaviourLog();
  return createSession({
    createPerformer: ensurePerformer,
    supply: createDefaultSupply(behaviourLog),
    source,
    brain: createBrain({ rng: Math.random }),
    memory: createPerformanceMemory(),
    behaviourLog,
    player: createPlayerAccess(),
  });
}

/** The one live session the app talks to. */
export const liveRaveSession: LiveRaveSession = buildDefaultSession();
