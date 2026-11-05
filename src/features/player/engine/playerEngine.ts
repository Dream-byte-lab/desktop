import {
  usePlayerStore,
  type PlayerCommand,
  type PlayerStatus,
  type RepeatMode,
  type PlayerState,
  type ShuffleMode,
} from "../store/playerStore";
import { routeDjCommand } from "@/features/mixer/liverave/transport";
import { liveRaveSession } from "@/features/mixer/liverave/session";
import { useDjState } from "@/features/mixer/liverave/state";
import { getTasteProfile } from "@/features/mixer/engine/tasteTracker";
import {
  maxGuestsFor,
  smartShuffleOrder,
  type SmartTrackFacts,
} from "./smartShuffle";
import {
  buildSmartGuests,
  getSmartFacts,
  getSmartRecentPlays,
  noteSmartShufflePlay,
  prefetchSmartFacts,
  smartCandidateInputFor,
} from "./smartShuffleContext";
import { recordDevicePlay } from "@/features/space";
import { playerRuntime } from "./playerRuntime";
import { clampUserVolume } from "./volume";
import { isRadioContext, shouldRefillRadio } from "./radioMode";
import { pitchShifter } from "./pitchShifter";
import { EQ_MAX_CUSTOM_PRESETS, EQ_PRESET_NAME_MAX } from "./equalizer";
import {
  api,
  type ApiRadioTrack,
  type LyricsCandidate,
  type LyricsSyncLevel,
  type PlaybackContext,
  type RecordPlaybackEventRequest,
} from "@/shared/api";
import { toClientTrack } from "@/shared/api/track";
import { log } from "@/shared/utils/logger";
import {
  parseRawLyrics,
  useLyricsStore,
  lyricsCache,
  isLyricsCandidate,
  shouldCacheLyricsCandidate,
  isProvisionalLyricsCandidate,
  compareLyricsCandidates,
  isBetterLyricsCandidate,
  fetchLrclibCandidate,
  shouldAttemptLrclibFallback,
  hasAttemptedLrclibFallback,
  markLrclibFallbackAttempted,
  isPlainOnlyLrclibFallback,
  type CachedLyricsItem,
  type LyricsProviderOption,
} from "@/features/lyrics";
import { resolveDisplayedCachedCandidate } from "@/features/lyrics/store/lyricsCache";
import { preloadCoverArt } from "@/features/covers";
import { preloadArtistAvatars } from "@/features/artist/lib/artistAvatar";
import { linerDb, type CachedLyricsRecord } from "@/shared/storage";
import { debouncedStorage } from "@/shared/utils/storage";
import { showToast } from "@/shared/ui";
import { createTranslatorSync, getStoredLocale } from "@/languages";
import type { Track } from "@/shared/types";
import { isLocalTrackId } from "@/shared/media/local";
import { readSavedLyrics } from "@/shared/media/saved";
import { loadAmbientScript } from "@/shared/media/ambient";
import { STREAMS_REFUSED_MESSAGE } from "@/shared/youtube";
import { OFFLINE_UNAVAILABLE_MESSAGE } from "@/features/connectivity/store/offlineModeStore";
import { noteYoutubeTrouble } from "@/features/connectivity/engine/offlineController";

const MAX_CONSECUTIVE_AUTO_SKIPS = 3;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export { usePlayerStore, type PlayerStatus, type RepeatMode, type PlayerState };

function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function restoreOriginalRelativeOrder<T>(
  currentUpcoming: T[],
  referenceList: T[],
): T[] {
  if (referenceList.length === 0) return currentUpcoming;
  const originalPosMap = new Map<unknown, number>();
  referenceList.forEach((item: unknown, idx) => {
    const key = (item as { id?: string })?.id ?? item;
    if (!originalPosMap.has(key)) {
      originalPosMap.set(key, idx);
    }
  });

  return [...currentUpcoming].sort((a: unknown, b: unknown) => {
    const keyA = (a as { id?: string })?.id ?? a;
    const keyB = (b as { id?: string })?.id ?? b;
    const posA = originalPosMap.has(keyA)
      ? originalPosMap.get(keyA)!
      : Number.MAX_SAFE_INTEGER;
    const posB = originalPosMap.has(keyB)
      ? originalPosMap.get(keyB)!
      : Number.MAX_SAFE_INTEGER;
    return posA - posB;
  });
}

function parsePlaybackContext(
  context: string | null,
): PlaybackContext | undefined {
  if (!context) return undefined;
  if (context.includes(":")) {
    const [type, ...rest] = context.split(":");
    return { type, id: rest.join(":") };
  }
  return { type: context };
}

// fresh station instance id so the backend can tell paginated waves apart
// even when seed + history windows coincide
function continuesWithSimilar(state: PlayerState): boolean {
  return state.autoplaySimilar && state.repeat === "off";
}

function newRadioWaveId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `wave-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

type LyricsHint = { title: string; artist: string; durationMs?: number };

function lyricsArtistName(raw: string): string {
  const cleaned = raw
    .replace(/(^|\s)[#@][^\s#@]+/g, " ")
    .replace(/\s+-\s+topic$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || raw.trim();
}

function lyricsHint(track: Track): LyricsHint {
  const artist =
    track.artistList?.[0]?.name || track.artists.split(",")[0] || "";
  return {
    title: track.title,
    artist: lyricsArtistName(artist),
    durationMs: track.durationMs,
  };
}

class PlaybackTelemetryTracker {
  private activeTrackId: string | null = null;
  private activeTrack: Track | null = null;
  private playbackSessionId: string = "";
  private listeningSessionId: string = "";
  private lastActivityTime: number = 0;
  private trackDurationMs = 0;
  private playedDurationMs = 0;
  private lastTickTime: number | null = null;
  private completed = false;
  private loopCount = 0;
  private hasSeekBackward = false;
  private context?: PlaybackContext;
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000;

  private getOrCreateListeningSession(): string {
    const now = Date.now();
    if (
      !this.listeningSessionId ||
      now - this.lastActivityTime > this.SESSION_TIMEOUT_MS
    ) {
      this.listeningSessionId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `ls_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    this.lastActivityTime = now;
    return this.listeningSessionId;
  }

  private generatePlaybackSessionId(): string {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `ps_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  public startTrack(track: Track, contextStr: string | null) {
    this.flushCurrentTrack();

    this.playbackSessionId = this.generatePlaybackSessionId();
    this.activeTrackId = track.id;
    this.activeTrack = track;
    this.trackDurationMs = track.durationMs ?? 0;
    this.playedDurationMs = 0;
    this.lastTickTime = null;
    this.completed = false;
    this.loopCount = 0;
    this.hasSeekBackward = false;
    this.context = parsePlaybackContext(contextStr);
    this.getOrCreateListeningSession();
  }

  public onPlaying() {
    const now = Date.now();
    this.lastTickTime = now;
    this.lastActivityTime = now;
  }

  public onPausedOrStopped() {
    const now = Date.now();
    this.lastActivityTime = now;
    if (this.lastTickTime !== null) {
      const delta = now - this.lastTickTime;
      if (delta > 0 && delta < 10000) {
        this.playedDurationMs += delta;
      }
      this.lastTickTime = null;
    }
  }

  public onTick(isPlaying: boolean) {
    if (!this.activeTrackId) return;

    const now = Date.now();
    this.lastActivityTime = now;

    if (isPlaying) {
      if (this.lastTickTime !== null) {
        const delta = now - this.lastTickTime;
        if (delta > 0 && delta < 5000) {
          this.playedDurationMs += delta;
        }
      }
      this.lastTickTime = now;
    } else {
      this.lastTickTime = null;
    }
  }

  public recordSeekBackward() {
    this.hasSeekBackward = true;
    this.lastActivityTime = Date.now();
  }

  public onTrackCompleted(isRepeatOne: boolean = false) {
    if (!this.activeTrackId) return;
    this.onPausedOrStopped();
    this.completed = true;
    if (isRepeatOne) {
      this.loopCount += 1;
    }
  }

  public flushCurrentTrack(): Promise<void> {
    if (!this.activeTrackId) return Promise.resolve();
    this.onPausedOrStopped();
    let reported: Promise<void> = Promise.resolve();

    const durationMs =
      this.trackDurationMs > 0 ? this.trackDurationMs : this.playedDurationMs;
    const rawRate =
      durationMs > 0
        ? this.playedDurationMs / durationMs
        : this.completed
          ? 1.0
          : 0.0;
    const completionRate = Math.min(1.0, Math.max(0.0, rawRate));
    const isSkipped = !this.completed && this.playedDurationMs < 30000;

    if (
      (this.playedDurationMs >= 3000 || this.completed) &&
      !isLocalTrackId(this.activeTrackId)
    ) {
      const snap = this.activeTrack;
      const artistsList = snap?.artistList?.length
        ? snap.artistList.map((a) => ({ id: a.id || "unknown", name: a.name }))
        : snap?.artists
          ? snap.artists.split(",").map((name) => ({
              id: snap?.artistId || "unknown",
              name: name.trim(),
            }))
          : [{ id: "unknown", name: "Unknown Artist" }];

      reported = this.sendEvent({
        playbackSessionId: this.playbackSessionId,
        listeningSessionId: this.getOrCreateListeningSession(),
        trackId: this.activeTrackId,
        trackSnapshot: snap
          ? {
              id: snap.id,
              title: snap.title || "Unknown Track",
              artists: artistsList,
              album: snap.album
                ? { id: snap.album.id || "", title: snap.album.title || "" }
                : undefined,
              cover: snap.coverUrl
                ? { url: snap.coverUrl, width: 512, height: 512 }
                : undefined,
              durationMs: snap.durationMs || this.trackDurationMs,
            }
          : undefined,
        playedDurationMs: Math.round(this.playedDurationMs),
        trackDurationMs:
          this.trackDurationMs > 0 ? this.trackDurationMs : undefined,
        completionRate: Number(completionRate.toFixed(4)),
        completed: this.completed,
        skipped: isSkipped,
        loopCount: this.loopCount,
        hasSeekBackward: this.hasSeekBackward,
        context: this.context,
      });
    }

    this.activeTrackId = null;
    this.activeTrack = null;
    this.playbackSessionId = "";
    this.lastTickTime = null;
    this.playedDurationMs = 0;
    this.completed = false;
    this.loopCount = 0;
    this.hasSeekBackward = false;
    return reported;
  }

  private sendEvent(payload: RecordPlaybackEventRequest): Promise<void> {
    // The hybrid listening record (interface slice S2): the
    // on-device play log takes the same payload at the same
    // moment — fire-and-forget by contract, it never throws.
    recordDevicePlay(payload);
    return api.recordPlaybackEvent(payload).then(
      () => undefined,
      (err) => {
        log(
          "yellow",
          "telemetry",
          `playback event report failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  }
}

class PlayerEngine {
  private sessionId = 0;
  private lyricsLoadToken = 0;
  private lyricsAbort: AbortController | null = null;
  private currentLyricsTrackId: string | null = null;
  private masterPlaylist: Track[] = [];
  private originalUpcomingQueue: Track[] = [];
  private telemetry = new PlaybackTelemetryTracker();
  private radioAppendTimeout: ReturnType<typeof setTimeout> | null = null;
  private radioWaveId: string | null = null;
  // single in-flight similar-tracks request, so a refill and an end-of-queue wait share it
  private radioFetchInFlight: Promise<void> | null = null;
  private consecutiveAutoSkips = 0;
  private consecutiveOfflineSkips = 0;
  private lastPreloadKey: string | null = null;
  // Smart Shuffle: bumped whenever the queue or mode moves on, so a
  // guest pass that lands late can tell it belongs to a dead queue.
  private smartGuestKickToken = 0;
  private smartSeedCounter = 0;
  private smartFeatureWasEnabled =
    usePlayerStore.getState().smartShuffleEnabled;
  private inFlightLyricsPrefetches = new Map<string, Promise<void>>();

  constructor() {
    usePlayerStore.setState({
      // While a DJ session runs, it gets first claim on transport
      // commands; everything else reaches this engine unchanged.
      dispatch: (command) => {
        if (!routeDjCommand(command, liveRaveSession)) {
          this.dispatch(command);
        }
      },
    });

    if (playerRuntime) {
      // DJ-session authority (fix2-0119): while the session
      // runs, the runtime is fully subordinated to it (no
      // crossfade, no element advance, no element store writes).
      playerRuntime.sessionLive = () => liveRaveSession.isRunning;
      playerRuntime.onEnded = () => {
        const isRepeatOne = usePlayerStore.getState().repeat === "one";
        this.telemetry.onTrackCompleted(isRepeatOne);
      };
      playerRuntime.onError = (info) => this.handlePlaybackError(info);
    }

    if (typeof window !== "undefined") {
      const g = window as any;
      if (g.__playerEngineUnsub) {
        g.__playerEngineUnsub();
      }

      window.addEventListener("beforeunload", () => {
        this.telemetry.flushCurrentTrack();
      });

      let prevTrackId: string | null =
        usePlayerStore.getState().currentTrack?.id || null;
      let prevStatus: string = "idle";
      let newTrack = false;
      const unsub = usePlayerStore.subscribe((state) => {
        // Smart Shuffle's feature switch (Settings → Playback):
        // disabling the feature while smart mode is selected ends
        // smart mode through the normal transition — guests are
        // removed and the queue restored, exactly as switching
        // shuffle off does (user ruling, 2026-11-05).
        if (state.smartShuffleEnabled !== this.smartFeatureWasEnabled) {
          const wasEnabled = this.smartFeatureWasEnabled;
          this.smartFeatureWasEnabled = state.smartShuffleEnabled;
          if (wasEnabled && !state.smartShuffleEnabled) {
            if (state.shuffleMode === "smart") this.setShuffleMode("off");
          }
        }
        const trackId = state.currentTrack?.id || null;
        if (trackId !== prevTrackId) {
          prevTrackId = trackId;
          newTrack = true;
          this.lastPreloadKey = null;
          if (state.currentTrack) {
            noteSmartShufflePlay(state.currentTrack.id);
            this.telemetry.startTrack(
              state.currentTrack,
              state.playbackContext,
            );
          } else {
            this.telemetry.flushCurrentTrack();
          }
          void this.fetchLyricsForTrack(state.currentTrack);
          this.preloadNextTrack(state);
        }

        if (state.status === "playing") {
          this.telemetry.onTick(true);
        } else {
          this.telemetry.onTick(false);
        }

        if (state.status !== prevStatus || newTrack) {
          if (state.status === "playing") {
            this.telemetry.onPlaying();
            this.consecutiveAutoSkips = 0;
            this.consecutiveOfflineSkips = 0;
          } else if (state.status === "paused" || state.status === "idle") {
            this.telemetry.onPausedOrStopped();
          }
          prevStatus = state.status;
          void this.syncDiscordPresence(state, newTrack);
          newTrack = false;
        }
      });

      g.__playerEngineUnsub = unsub;

      const restoreLyricsForHydratedTrack = () => {
        const state = usePlayerStore.getState();
        const restoredTrack = state.currentTrack;
        if (restoredTrack) {
          prevTrackId = restoredTrack.id;
          void this.fetchLyricsForTrack(restoredTrack);
          this.preloadNextTrack(state);
        }
      };

      if (usePlayerStore.persist.hasHydrated()) {
        restoreLyricsForHydratedTrack();
      } else {
        usePlayerStore.persist.onFinishHydration(restoreLyricsForHydratedTrack);
      }
    }
  }

  public subscribe(listener: () => void): () => void {
    return usePlayerStore.subscribe(listener);
  }

  public getSnapshot(): PlayerState {
    return usePlayerStore.getState();
  }

  public primeUserGesture(): void {
    // Intentionally a no-op placeholder for gesture priming
  }

  public dispatch(command: PlayerCommand): void {
    switch (command.type) {
      case "PLAY_REQUESTED":
        void this.playTrack(
          command.track,
          command.queue,
          command.context,
          command.contextCover,
        );
        break;
      case "PAUSE_REQUESTED":
        this.pause();
        break;
      case "RESUME_REQUESTED":
        this.resume();
        break;
      case "SEEK_COMMITTED":
        this.seek(command.positionMs);
        break;
      case "SKIP_NEXT":
        void this.skipNext(command.isAutoEnd);
        break;
      case "SKIP_PREVIOUS":
        void this.skipPrevious();
        break;
      case "SET_VOLUME":
        this.setVolume(command.volume);
        break;
      case "SET_PLAYBACK_RATE":
        this.setPlaybackRate(command.rate);
        break;
      case "SET_PITCH_SEMITONES":
        this.setPitchSemitones(command.semitones);
        break;
      case "TOGGLE_PLAY_PAUSE":
        this.togglePlayPause();
        break;
    }
  }

  /**
   * A hand-picked track ends the DJ session — picking a song by hand is
   * the user taking the decks back. Every play surface in the app calls
   * playTrack / playShuffled / startRadioStation directly and bypasses
   * the store's command channel, so the arbitration that channel was
   * designed for happens here instead, at the engine entry points all
   * of those surfaces share: offer the pick to the router, whose
   * PLAY_REQUESTED case stops a running session and lets the pick fall
   * through to this engine untouched. Without this, the session's own
   * decks keep playing underneath the picked track (Note 2).
   */
  private endSessionForPickedTrack(track: Track, queue?: Track[]): void {
    routeDjCommand({ type: "PLAY_REQUESTED", track, queue }, liveRaveSession);
  }

  public async playTrack(
    track: Track,
    queue?: Track[],
    context?: string | null,
    contextCover?: string | null,
    queueIndex?: number,
    preserveQueue?: boolean,
  ): Promise<void> {
    this.endSessionForPickedTrack(track, queue);
    const store = usePlayerStore.getState();
    const nextQueue = this.normalizeQueue(queue ?? [track], track);
    const nextIndex =
      queueIndex !== undefined
        ? queueIndex
        : Math.max(
            0,
            nextQueue.findIndex((item) => item.id === track.id),
          );

    this.sessionId += 1;
    const mySession = this.sessionId;
    this.radioWaveId = newRadioWaveId();

    if (context !== undefined) {
      store.setPlaybackContext(context);
    }
    if (contextCover !== undefined) {
      store.setPlaybackContextCover(contextCover);
    }
    let finalQueue = nextQueue;
    let finalIndex = nextIndex;

    const isSelectingFromCurrentQueue =
      preserveQueue === true ||
      (queueIndex !== undefined &&
        store.queue.length > 0 &&
        store.queue.length === nextQueue.length &&
        store.queue[queueIndex]?.id === track.id);

    if (!isSelectingFromCurrentQueue) {
      this.masterPlaylist = [...nextQueue];
      // A new queue is a new set: any guests belonged to the old
      // one, and any guest pass still in flight is stale.
      store.setSmartGuestIds([]);
      this.smartGuestKickToken += 1;
    }

    let kickSmartGuestsAfter = false;
    if (!isSelectingFromCurrentQueue && store.shuffle && nextQueue.length > 1) {
      const played = nextQueue.slice(0, nextIndex);
      const selectedTrackItem = nextQueue[nextIndex] ?? track;
      const upcoming = nextQueue.slice(nextIndex + 1);

      this.originalUpcomingQueue = [...upcoming];
      if (this.smartModeOn() && !this.djSequencingOwnsOrder()) {
        // Smart Shuffle orders the upcoming run; the picked track
        // stays pinned at its slot exactly as the dice roll kept
        // it. (With DJ intent on, the queue keeps the legacy roll:
        // the brain sequences the set itself, through the pool —
        // see setShuffleMode.)
        finalQueue = [
          ...played,
          selectedTrackItem,
          ...this.runSmartOrder(selectedTrackItem, upcoming),
        ];
        kickSmartGuestsAfter = true;
      } else {
        const shuffledUpcoming = shuffleArray(upcoming);
        finalQueue = [...played, selectedTrackItem, ...shuffledUpcoming];
      }
      finalIndex = nextIndex;
    } else if (!isSelectingFromCurrentQueue) {
      this.originalUpcomingQueue = [];
    }

    store.setQueue(finalQueue);

    const selectedTrack = finalQueue[finalIndex] ?? track;
    store.setCurrentTrack(selectedTrack, finalIndex);
    store.setPosition(0);
    store.setDuration(selectedTrack.durationMs ?? 0);
    store.setStatus("loading", null);
    if (kickSmartGuestsAfter) this.kickSmartGuests();

    if (playerRuntime) {
      void playerRuntime.loadAndPlay(selectedTrack);
    }

    this.maybeExtendQueue(
      mySession,
      selectedTrack.id,
      finalIndex,
      finalQueue.length,
    );
  }

  public async playShuffled(
    tracks: Track[],
    context?: string | null,
    contextCover?: string | null,
    startIndex?: number,
  ): Promise<void> {
    if (!tracks || tracks.length === 0) return;
    const store = usePlayerStore.getState();
    const seedIndex =
      startIndex !== undefined && startIndex >= 0 && startIndex < tracks.length
        ? startIndex
        : Math.floor(Math.random() * tracks.length);
    const seedTrack = tracks[seedIndex];
    this.endSessionForPickedTrack(seedTrack, tracks);
    const remaining = [
      ...tracks.slice(0, seedIndex),
      ...tracks.slice(seedIndex + 1),
    ];
    const useSmartOrder = this.smartModeOn() && !this.djSequencingOwnsOrder();
    const orderedRemaining = useSmartOrder
      ? this.runSmartOrder(seedTrack, remaining)
      : shuffleArray(remaining);
    const finalQueue = [seedTrack, ...orderedRemaining];

    this.masterPlaylist = [...tracks];
    this.originalUpcomingQueue = [...remaining];
    store.setSmartGuestIds([]);
    this.smartGuestKickToken += 1;

    store.setShuffle(true);
    if (context !== undefined) {
      store.setPlaybackContext(context);
    }
    if (contextCover !== undefined) {
      store.setPlaybackContextCover(contextCover);
    }

    this.sessionId += 1;
    const mySession = this.sessionId;
    this.radioWaveId = newRadioWaveId();

    store.setQueue(finalQueue);
    store.setCurrentTrack(seedTrack, 0);
    store.setPosition(0);
    store.setDuration(seedTrack.durationMs ?? 0);
    store.setStatus("loading", null);
    if (useSmartOrder) this.kickSmartGuests();

    if (playerRuntime) {
      void playerRuntime.loadAndPlay(seedTrack);
    }

    this.maybeExtendQueue(mySession, seedTrack.id, 0, finalQueue.length);
  }

  public async startRadioStation(track: Track): Promise<void> {
    if (isLocalTrackId(track.id)) return;
    this.endSessionForPickedTrack(track, [track]);
    const store = usePlayerStore.getState();
    this.sessionId += 1;
    const mySession = this.sessionId;
    // new station, new wave instance
    this.radioWaveId = newRadioWaveId();
    const waveId = this.radioWaveId;

    store.setPlaybackContext(`radio:${track.id}`);
    // a station never loops back to its first track
    if (store.repeat === "all") store.setRepeat("off");
    store.setPlaybackContextCover(track.coverUrl ?? null);
    store.setQueue([track]);
    this.originalUpcomingQueue = [];
    store.setSmartGuestIds([]);
    this.smartGuestKickToken += 1;

    store.setCurrentTrack(track, 0);
    store.setPosition(0);
    store.setDuration(track.durationMs ?? 0);
    store.setStatus("loading", null);

    if (playerRuntime) {
      void playerRuntime.loadAndPlay(track);
    }

    try {
      const response = await api.getRadio(track.id, { k: 20, wave_id: waveId });
      if (mySession !== this.sessionId) return;
      const additions = response.items
        .map(toClientTrack)
        .filter((item) => item.id !== track.id);

      if (additions.length > 0) {
        const latestStore = usePlayerStore.getState();
        const updatedQueue = [track, ...additions];
        latestStore.setQueue(updatedQueue);
        if (latestStore.shuffle) {
          const upcoming = additions;
          this.originalUpcomingQueue = [...upcoming];
          const orderedUpcoming =
            this.smartModeOn() && !this.djSequencingOwnsOrder()
              ? this.runSmartOrder(track, upcoming)
              : shuffleArray(upcoming);
          latestStore.setQueue([track, ...orderedUpcoming]);
        }
        const sample = additions
          .slice(0, 3)
          .map((t) => `"${t.title}" by ${t.artists || "Unknown"}`)
          .join(", ");
        log(
          "green",
          "radio",
          `started station for "${track.title}" with ${additions.length} tracks from Radio Wave engine: [${sample}]`,
        );
      }
    } catch (error) {
      log(
        "yellow",
        "radio",
        `radio fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public pause(): void {
    const store = usePlayerStore.getState();
    const wasLoading = store.status === "loading";
    if (wasLoading) {
      playerRuntime?.cancelPendingLoad();
    }
    const audioEl = document.getElementById(
      "liner-audio",
    ) as HTMLAudioElement | null;
    if (audioEl && !Number.isNaN(audioEl.currentTime)) {
      store.setPosition(Math.round(audioEl.currentTime * 1000));
    }
    store.setStatus("paused");
    if (playerRuntime && !wasLoading) {
      playerRuntime.pause();
    }
  }

  public resume(): void {
    const store = usePlayerStore.getState();
    // At the end of the queue the store clears the current track while
    // the runtime keeps the finished track's source loaded. Resuming
    // then would restart that source with no track on screen (and set
    // a phantom "playing" status), so with nothing current there is
    // nothing to resume: no status write, no runtime call.
    if (!store.currentTrack) return;
    if (playerRuntime) {
      if (
        store.currentTrack &&
        !playerRuntime.hasLoadedSourceFor(store.currentTrack.id)
      ) {
        void playerRuntime.loadAndPlay(store.currentTrack, store.positionMs);
      } else {
        store.setStatus("playing");
        playerRuntime.resume();
      }
    }
  }

  public togglePlayPause(): void {
    const store = usePlayerStore.getState();
    if (store.status === "playing" || store.status === "loading") {
      this.pause();
    } else {
      this.resume();
    }
  }

  public async skipNext(isAutoEnd: boolean = false): Promise<void> {
    const store = usePlayerStore.getState();
    const nextIndex = this.computeNextIndex(isAutoEnd);

    if (
      nextIndex === null &&
      isRadioContext(store.playbackContext) &&
      store.currentTrack
    ) {
      // radio ran dry (refill not back yet / failed earlier): fetch now and carry on
      const lengthBefore = store.queue.length;
      const waitSession = this.sessionId;
      store.setStatus("loading", null);
      if (this.radioAppendTimeout) {
        clearTimeout(this.radioAppendTimeout);
        this.radioAppendTimeout = null;
      }
      await this.appendSimilarTracksForSeed(waitSession, store.currentTrack.id);
      if (waitSession !== this.sessionId) return;
      if (usePlayerStore.getState().queue.length > lengthBefore) {
        await this.skipNext(isAutoEnd);
        return;
      }
    }

    if (nextIndex === null) {
      this.stopPlayback();
      store.setStatus("idle");
      store.setPosition(0);
      store.setDuration(0);
      store.setCurrentTrack(null, -1);
      store.setFullscreen(false);
      return;
    }

    this.sessionId += 1;
    const mySession = this.sessionId;
    const nextTrack = store.queue[nextIndex];
    if (nextTrack) {
      // Optimistic synchronous UI update
      store.setCurrentTrack(nextTrack, nextIndex);
      store.setPosition(0);
      store.setDuration(nextTrack.durationMs ?? 0);
      store.setStatus("loading", null);

      if (playerRuntime) {
        void playerRuntime.loadAndPlay(nextTrack);
      }
      this.maybeExtendQueue(
        mySession,
        nextTrack.id,
        nextIndex,
        store.queue.length,
      );
    }
  }

  public async skipPrevious(): Promise<void> {
    const store = usePlayerStore.getState();
    if (store.queue.length === 0) return;

    // If playback is > 3 seconds, standard player behavior restarts the track
    if (store.positionMs > 3000) {
      this.seek(0);
      return;
    }

    const prevIndex =
      store.currentIndex > 0
        ? store.currentIndex - 1
        : store.repeat === "all" && !isRadioContext(store.playbackContext)
          ? store.queue.length - 1
          : 0;

    this.sessionId += 1;
    const mySession = this.sessionId;
    const prevTrack = store.queue[prevIndex];
    if (prevTrack) {
      // Optimistic synchronous UI update
      store.setCurrentTrack(prevTrack, prevIndex);
      store.setPosition(0);
      store.setDuration(prevTrack.durationMs ?? 0);
      store.setStatus("loading", null);

      if (playerRuntime) {
        void playerRuntime.loadAndPlay(prevTrack);
      }
      this.maybeExtendQueue(
        mySession,
        prevTrack.id,
        prevIndex,
        store.queue.length,
      );
    }
  }

  public setVolume(volume: number): void {
    usePlayerStore.getState().setVolume(clampUserVolume(volume));
  }

  public setVolumeSmooth(volume: number): void {
    this.setVolume(volume);
  }

  public setPlaybackRate(rate: number): void {
    pitchShifter.resumeContext();
    const clampedRate = Math.min(2.0, Math.max(0.5, Number(rate.toFixed(2))));
    const store = usePlayerStore.getState();
    if (store.isPitchLinked) {
      const semitones = Number((12 * Math.log2(clampedRate)).toFixed(1));
      store.setPitchSemitones(semitones);
    }
    store.setPlaybackRate(clampedRate);
  }

  public setPitchSemitones(semitones: number): void {
    pitchShifter.resumeContext();
    const clampedSemitones = Math.min(
      12,
      Math.max(-12, Number(semitones.toFixed(1))),
    );
    const store = usePlayerStore.getState();
    if (store.isPitchLinked) {
      const rate = Number(Math.pow(2, clampedSemitones / 12).toFixed(2));
      const clampedRate = Math.min(2.0, Math.max(0.5, rate));
      store.setPlaybackRate(clampedRate);
    }
    store.setPitchSemitones(clampedSemitones);
  }

  public setIsPitchLinked(linked: boolean): void {
    pitchShifter.resumeContext();
    const store = usePlayerStore.getState();
    store.setIsPitchLinked(linked);
    if (linked) {
      const rate = store.playbackRate ?? 1;
      const semitones = Number((12 * Math.log2(rate)).toFixed(1));
      store.setPitchSemitones(semitones);
    }
  }

  public setKeepSpeedAcrossTracks(keep: boolean): void {
    usePlayerStore.getState().setKeepSpeedAcrossTracks(keep);
  }

  public setIsReverbEnabled(enabled: boolean): void {
    pitchShifter.resumeContext();
    usePlayerStore.getState().setIsReverbEnabled(enabled);
  }

  public setReverbLevel(level: number): void {
    pitchShifter.resumeContext();
    usePlayerStore.getState().setReverbLevel(level);
  }

  public setIsEqEnabled(enabled: boolean): void {
    pitchShifter.resumeContext();
    usePlayerStore.getState().setIsEqEnabled(enabled);
  }

  public setEqGains(gains: number[]): void {
    pitchShifter.resumeContext();
    usePlayerStore.getState().setEqGains(gains);
  }

  // saves the current curve under a name; same name overwrites, the list is capped
  public saveEqPreset(name: string): void {
    const store = usePlayerStore.getState();
    const trimmed = name.trim().slice(0, EQ_PRESET_NAME_MAX);
    if (!trimmed) return;
    const others = store.eqCustomPresets.filter(
      (preset) => preset.name.toLowerCase() !== trimmed.toLowerCase(),
    );
    if (others.length >= EQ_MAX_CUSTOM_PRESETS) return;
    store.setEqCustomPresets([
      ...others,
      { id: crypto.randomUUID(), name: trimmed, gains: [...store.eqGains] },
    ]);
  }

  public deleteEqPreset(id: string): void {
    const store = usePlayerStore.getState();
    store.setEqCustomPresets(
      store.eqCustomPresets.filter((preset) => preset.id !== id),
    );
  }

  public resetSpeedAndPitch(): void {
    usePlayerStore.getState().resetSpeedAndPitch();
  }

  public setRepeat(mode: RepeatMode): void {
    usePlayerStore.getState().setRepeat(mode);
  }

  /**
   * The legacy boolean seam, kept for every caller that only knows
   * on/off (the touch bar, older surfaces): on means the plain
   * roll when coming from off, and never downgrades a smart
   * selection already in force; off is the full off transition.
   */
  public setShuffle(enabled: boolean): void {
    const store = usePlayerStore.getState();
    if (store.shuffle === enabled) return;
    this.setShuffleMode(enabled ? "plain" : "off");
  }

  /**
   * Smart Shuffle's activation rule (user ruling, 2026-11-05):
   * the feature — its ordering AND its guests — lives only in
   * smart mode. With smart on, the DJ sequences THROUGH Smart
   * Shuffle: the session starts from this queue, so the guests
   * admitted into it are the brain's candidate pool beside the
   * playlist. With smart off (or the feature disabled in
   * Settings), the DJ is restricted to the playlist only —
   * Addendum A, restored exactly — and leaving smart mode removes
   * the guests and restores the queue as plain playback had it.
   *
   * Ordering itself is a plain-playback act: while DJ intent is
   * on, queue builds keep the legacy roll and the brain does the
   * sequencing; the smart order shapes what plain playback plays
   * and what the listener sees queued.
   */
  public setShuffleMode(mode: ShuffleMode): void {
    const store = usePlayerStore.getState();
    if (mode === "smart" && !store.smartShuffleEnabled) mode = "plain";
    if (store.shuffleMode === mode) {
      // Re-selecting smart is the re-roll: a fresh order, fresh seed.
      if (mode === "smart") this.rebuildSmartUpcoming();
      return;
    }
    store.setShuffleMode(mode);
    this.applyShuffleModeToQueue(mode);
  }

  /** The player controls' cycle: off → smart → plain → off. */
  public cycleShuffleMode(): void {
    const store = usePlayerStore.getState();
    const modes: ShuffleMode[] = store.smartShuffleEnabled
      ? ["off", "smart", "plain"]
      : ["off", "plain"];
    const index = modes.indexOf(store.shuffleMode);
    this.setShuffleMode(modes[(index + 1) % modes.length]);
  }

  private applyShuffleModeToQueue(mode: ShuffleMode): void {
    const store = usePlayerStore.getState();
    this.smartGuestKickToken += 1;
    const { queue, currentIndex } = store;
    if (queue.length === 0 || currentIndex < 0 || !queue[currentIndex]) {
      if (mode !== "smart") store.setSmartGuestIds([]);
      return;
    }
    const played = queue.slice(0, currentIndex);
    const current = queue[currentIndex];
    const guestIds = new Set(store.smartGuestIds);
    const playlistUpcoming = queue
      .slice(currentIndex + 1)
      .filter((track) => !guestIds.has(track.id));

    if (mode === "off") {
      const referenceList =
        this.masterPlaylist.length > 0
          ? this.masterPlaylist
          : this.originalUpcomingQueue;
      const unshuffledUpcoming = restoreOriginalRelativeOrder(
        playlistUpcoming,
        referenceList,
      );
      store.setQueue([...played, current, ...unshuffledUpcoming]);
      this.originalUpcomingQueue = [];
      store.setSmartGuestIds([]);
      return;
    }

    this.originalUpcomingQueue = [...playlistUpcoming];
    store.setSmartGuestIds([]);
    if (mode === "plain") {
      const shuffledUpcoming = shuffleArray(playlistUpcoming);
      store.setQueue([...played, current, ...shuffledUpcoming]);
    } else {
      // Under DJ intent (or a running session) the brain owns the
      // sequence: the queue keeps the playlist's natural order and
      // Smart Shuffle's contribution is the pool — the guests the
      // pass below admits into it.
      const orderedUpcoming = this.djSequencingOwnsOrder()
        ? restoreOriginalRelativeOrder(
            playlistUpcoming,
            this.masterPlaylist.length > 0
              ? this.masterPlaylist
              : this.originalUpcomingQueue,
          )
        : this.runSmartOrder(current, playlistUpcoming);
      store.setQueue([...played, current, ...orderedUpcoming]);
      this.kickSmartGuests();
    }
  }

  /** The re-roll: a fresh smart order (and a fresh guest pass). */
  private rebuildSmartUpcoming(): void {
    const store = usePlayerStore.getState();
    this.smartGuestKickToken += 1;
    const { queue, currentIndex } = store;
    if (queue.length === 0 || currentIndex < 0 || !queue[currentIndex]) return;
    const played = queue.slice(0, currentIndex);
    const current = queue[currentIndex];
    const guestIds = new Set(store.smartGuestIds);
    const playlistUpcoming = queue
      .slice(currentIndex + 1)
      .filter((track) => !guestIds.has(track.id));
    // The restore basis stays the playlist's natural order, never
    // the smart order itself.
    const referenceList =
      this.masterPlaylist.length > 0
        ? this.masterPlaylist
        : this.originalUpcomingQueue;
    this.originalUpcomingQueue = restoreOriginalRelativeOrder(
      playlistUpcoming,
      referenceList,
    );
    store.setSmartGuestIds([]);
    const orderedUpcoming = this.djSequencingOwnsOrder()
      ? this.originalUpcomingQueue
      : this.runSmartOrder(current, playlistUpcoming);
    store.setQueue([...played, current, ...orderedUpcoming]);
    this.kickSmartGuests();
  }

  private smartModeOn(): boolean {
    const state = usePlayerStore.getState();
    return state.shuffleMode === "smart" && state.smartShuffleEnabled;
  }

  /**
   * Whether liveRave's brain currently owns sequencing — DJ
   * intent is on, or a session is already running. While it does,
   * Smart Shuffle never re-orders the queue (that would fight the
   * brain); it only widens the pool with admitted guests.
   */
  private djSequencingOwnsOrder(): boolean {
    return useDjState.getState().intent || liveRaveSession.isRunning;
  }

  private nextSmartSeed(): number {
    this.smartSeedCounter += 1;
    return (Date.now() ^ (this.smartSeedCounter * 0x9e3779b9)) >>> 0;
  }

  /**
   * Runs the pure ordering over playlist tracks plus any admitted
   * guests, anchored at the playing track. Facts come from the
   * session cache only; a prefetch is kicked so later rolls and
   * the guest pass see more of the library's analyses.
   */
  private runSmartOrder(
    current: Track | null,
    playlistUpcoming: readonly Track[],
    guests: readonly Track[] = [],
  ): Track[] {
    const pairs = [
      ...playlistUpcoming.map((track) => ({
        track,
        input: smartCandidateInputFor(track),
      })),
      ...guests.map((track) => ({
        track,
        input: smartCandidateInputFor(track, true),
      })),
    ];
    const factsById = new Map<string, SmartTrackFacts>();
    for (const { track } of pairs) {
      const facts = getSmartFacts(track.id);
      if (facts) factsById.set(track.id, facts);
    }
    void prefetchSmartFacts(playlistUpcoming);
    const orderedInputs = smartShuffleOrder({
      current: current ? smartCandidateInputFor(current) : null,
      currentFacts: current ? getSmartFacts(current.id) : null,
      candidates: pairs.map((pair) => pair.input),
      factsById,
      profile: getTasteProfile(),
      nowMs: Date.now(),
      recentPlays: getSmartRecentPlays(),
      seed: this.nextSmartSeed(),
    });
    const trackByInput = new Map(pairs.map((pair) => [pair.input, pair.track]));
    return orderedInputs
      .map((input) => trackByInput.get(input))
      .filter((track): track is Track => track !== undefined);
  }

  /**
   * The guest pass: rails → admission → weave. Async and heavily
   * guarded — it applies only if the queue it was kicked for is
   * still the queue being played (same mode, same current track
   * and index), and it fails silently: guests are an enhancement,
   * never a dependency of playback.
   */
  private kickSmartGuests(): void {
    const store = usePlayerStore.getState();
    const currentTrack = store.currentTrack;
    const currentIndex = store.currentIndex;
    if (!this.smartModeOn() || !currentTrack || currentIndex < 0) return;
    const guestIds = new Set(store.smartGuestIds);
    const playlistUpcomingCount = store.queue
      .slice(currentIndex + 1)
      .filter((track) => !guestIds.has(track.id)).length;
    const maxGuests = maxGuestsFor(playlistUpcomingCount);
    if (maxGuests <= 0) return;
    const playlistBody =
      this.masterPlaylist.length > 0
        ? [...this.masterPlaylist]
        : [...store.queue];
    const token = ++this.smartGuestKickToken;

    void (async () => {
      try {
        const guests = await buildSmartGuests({
          currentTrack,
          playlistTracks: playlistBody,
          maxGuests,
          nowMs: Date.now(),
        });
        if (guests.length === 0) return;
        if (token !== this.smartGuestKickToken) return;
        const live = usePlayerStore.getState();
        if (!this.smartModeOn()) return;
        if (
          live.currentTrack?.id !== currentTrack.id ||
          live.currentIndex !== currentIndex
        ) {
          return;
        }
        const liveGuestIds = new Set(live.smartGuestIds);
        const liveQueueIds = new Set(live.queue.map((track) => track.id));
        const freshGuests = guests.filter(
          (track) => !liveQueueIds.has(track.id),
        );
        if (freshGuests.length === 0) return;
        const played = live.queue.slice(0, live.currentIndex + 1);
        const livePlaylistUpcoming = live.queue
          .slice(live.currentIndex + 1)
          .filter((track) => !liveGuestIds.has(track.id));
        const cappedGuests = freshGuests.slice(
          0,
          maxGuestsFor(livePlaylistUpcoming.length),
        );
        if (cappedGuests.length === 0) return;
        const woven = this.runSmartOrder(
          live.currentTrack,
          livePlaylistUpcoming,
          cappedGuests,
        );
        live.setQueue([...played, ...woven]);
        live.setSmartGuestIds(cappedGuests.map((track) => track.id));
        this.preloadNextTrack(usePlayerStore.getState());
      } catch {
        // Guests never break playback: a failed pass is no pass.
      }
    })();
  }

  public seek(positionMs: number, autoPlay: boolean = false): void {
    const store = usePlayerStore.getState();
    const currentMs = store.positionMs;
    const durationMs = store.durationMs || store.currentTrack?.durationMs || 0;
    const nextMs = Math.round(
      Math.max(0, Math.min(durationMs || positionMs, positionMs)),
    );

    if (nextMs < currentMs - 3000) {
      this.telemetry.recordSeekBackward();
    }

    store.setPosition(nextMs);
    if (playerRuntime) {
      if (
        store.currentTrack &&
        !playerRuntime.hasLoadedSourceFor(store.currentTrack.id)
      ) {
        if (
          playerRuntime.getCurrentTrackId() === store.currentTrack.id &&
          store.status === "loading"
        ) {
          playerRuntime.setPendingSeek(nextMs);
          return;
        }
        if (autoPlay || store.status === "playing") {
          void playerRuntime.loadAndPlay(store.currentTrack, nextMs);
        }
        return;
      }
      playerRuntime.seek(nextMs);
      if (autoPlay && store.status !== "playing") {
        this.resume();
      }
    }
  }

  public seekAndPlay(positionMs: number): void {
    this.seek(positionMs, true);
  }

  public addToQueue(track: Track): void {
    const store = usePlayerStore.getState();
    const newQueue = [...store.queue, track];
    store.setQueue(newQueue);
    if (this.masterPlaylist.length > 0) {
      this.masterPlaylist.push(track);
    }
    if (store.shuffle) {
      this.originalUpcomingQueue.push(track);
    }
    // fresh state: the snapshot above predates setQueue, so preloading
    // from it would aim at the pre-addition "next" (often nothing)
    this.preloadNextTrack(usePlayerStore.getState());
  }

  public playNext(track: Track): void {
    const store = usePlayerStore.getState();
    const currentQueue = store.queue;
    const currentIndex = store.currentIndex;

    if (currentQueue.length === 0) {
      void this.playTrack(track, [track]);
      return;
    }

    const nextQueue = [
      ...currentQueue.slice(0, currentIndex + 1),
      track,
      ...currentQueue.slice(currentIndex + 1),
    ];
    store.setQueue(nextQueue);
    if (this.masterPlaylist.length > 0) {
      const currentTrack = store.currentTrack;
      const masterIdx = currentTrack
        ? this.masterPlaylist.findIndex((t) => t.id === currentTrack.id)
        : -1;
      if (masterIdx >= 0) {
        this.masterPlaylist.splice(masterIdx + 1, 0, track);
      } else {
        this.masterPlaylist.push(track);
      }
    }
    if (store.shuffle) {
      this.originalUpcomingQueue.unshift(track);
    }
    // fresh state, as in addToQueue: the inserted track IS the next
    // track now, and the stale snapshot cannot see it
    this.preloadNextTrack(usePlayerStore.getState());
  }

  /**
   * True while there is listening state that an unprompted interruption
   * must not destroy: a DJ session running on its own decks, or a track
   * loaded in the plain player in a non-idle state (playing, loading,
   * or paused mid-queue). The auth store consults this before clearing
   * playback on a drop to guest, so a server-rejected refresh token can
   * no longer wipe the music mid-playlist (Note 7, candidate 1).
   * Explicit sign-out is unaffected: logout calls stopAndClear directly.
   */
  public hasActivePlayback(): boolean {
    if (liveRaveSession.isRunning) return true;
    const state = usePlayerStore.getState();
    return state.currentTrack !== null && state.status !== "idle";
  }

  public async stopAndClear(): Promise<void> {
    const reported = this.telemetry.flushCurrentTrack();
    if (this.radioAppendTimeout) {
      clearTimeout(this.radioAppendTimeout);
      this.radioAppendTimeout = null;
    }
    this.radioFetchInFlight = null;
    this.radioWaveId = null;
    this.lyricsAbort?.abort();
    this.lyricsAbort = null;
    this.lyricsLoadToken += 1;
    this.currentLyricsTrackId = null;
    this.masterPlaylist = [];
    this.originalUpcomingQueue = [];
    this.smartGuestKickToken += 1;
    this.lastPreloadKey = null;
    this.consecutiveAutoSkips = 0;
    this.consecutiveOfflineSkips = 0;
    playerRuntime?.stop();
    usePlayerStore.getState().resetPlayback();
    useLyricsStore.getState().reset();
    debouncedStorage.flush();
    await reported;
  }

  public clearQueue(): void {
    usePlayerStore.getState().clearQueue();
    usePlayerStore.getState().setSmartGuestIds([]);
    this.smartGuestKickToken += 1;
    this.masterPlaylist = [];
    this.originalUpcomingQueue = [];
  }

  public reorderQueue(fromIndex: number, toIndex: number): void {
    const store = usePlayerStore.getState();
    const queue = [...store.queue];
    if (
      fromIndex < 0 ||
      fromIndex >= queue.length ||
      toIndex < 0 ||
      toIndex >= queue.length ||
      fromIndex === toIndex
    ) {
      return;
    }

    const [movedItem] = queue.splice(fromIndex, 1);
    queue.splice(toIndex, 0, movedItem);

    let newCurrentIndex = store.currentIndex;
    if (store.currentIndex === fromIndex) {
      newCurrentIndex = toIndex;
    } else if (
      fromIndex < store.currentIndex &&
      toIndex >= store.currentIndex
    ) {
      newCurrentIndex -= 1;
    } else if (
      fromIndex > store.currentIndex &&
      toIndex <= store.currentIndex
    ) {
      newCurrentIndex += 1;
    }

    store.setQueue(queue);
    if (newCurrentIndex !== store.currentIndex) {
      store.setCurrentTrack(store.currentTrack, newCurrentIndex);
    }
    this.preloadNextTrack(store);
  }

  // the playing track is not removable from here: skip it instead
  // returns the undo, or null when nothing was removed
  public removeFromQueue(index: number): (() => void) | null {
    const store = usePlayerStore.getState();
    if (
      index < 0 ||
      index >= store.queue.length ||
      index === store.currentIndex
    )
      return null;

    const track = store.queue[index];
    const queue = store.queue.filter((_, i) => i !== index);
    store.setQueue(queue);
    if (index < store.currentIndex) {
      store.setCurrentTrack(store.currentTrack, store.currentIndex - 1);
    }
    if (store.smartGuestIds.includes(track.id)) {
      store.setSmartGuestIds(
        store.smartGuestIds.filter((id) => id !== track.id),
      );
    }
    const after = usePlayerStore.getState();
    this.preloadNextTrack(after);
    // removing the last upcoming track makes the playing one the last: refill like skipNext does
    if (after.currentTrack)
      this.maybeExtendQueue(
        this.sessionId,
        after.currentTrack.id,
        after.currentIndex,
        after.queue.length,
      );
    // undo only applies to the queue it was made on, not to a queue started or edited since
    return () => {
      if (usePlayerStore.getState().queue === queue)
        this.insertIntoQueue(index, track);
    };
  }

  // undo for removeFromQueue: puts the track back at the position it had
  public insertIntoQueue(index: number, track: Track): void {
    const store = usePlayerStore.getState();
    const at = Math.max(0, Math.min(index, store.queue.length));
    const queue = [...store.queue];
    queue.splice(at, 0, track);
    store.setQueue(queue);
    if (store.currentIndex >= 0 && at <= store.currentIndex) {
      store.setCurrentTrack(store.currentTrack, store.currentIndex + 1);
    }
    this.preloadNextTrack(usePlayerStore.getState());
  }

  public snapshotQueue(): Track[] {
    return [...usePlayerStore.getState().queue];
  }

  private stopPlayback(): void {
    if (playerRuntime) {
      playerRuntime.pause();
    }
  }

  private normalizeQueue(queue: Track[], selected: Track): Track[] {
    if (queue.length === 0) return [selected];
    return queue.map((item) => ({
      ...item,
      coverUrl: item.coverUrl || selected.coverUrl,
      durationMs: item.durationMs ?? 0,
    }));
  }

  private handlePlaybackError(info: {
    trackId: string;
    message: string;
  }): void {
    const store = usePlayerStore.getState();
    if (!store.currentTrack || store.currentTrack.id !== info.trackId) return;

    const track = store.currentTrack;
    const translate = createTranslatorSync(getStoredLocale());
    if (info.message.startsWith(OFFLINE_UNAVAILABLE_MESSAGE)) {
      this.consecutiveOfflineSkips += 1;
      if (this.consecutiveOfflineSkips > store.queue.length) {
        showToast(translate("offline.nothing_playable"), "info", {
          id: "offline-skip",
        });
        this.consecutiveOfflineSkips = 0;
        this.stopPlayback();
        store.setStatus("idle");
        store.setPosition(0);
        store.setDuration(0);
        store.setCurrentTrack(null, -1);
        return;
      }
      showToast(translate("offline.skipped_title"), "info", {
        id: "offline-skip",
        description: translate("offline.skipped_desc"),
      });
      void this.skipNext(false);
      return;
    }
    // youtube refusing every stream is about the connection (vpn, proxy, flagged ip), not this track
    const refused = info.message.startsWith(STREAMS_REFUSED_MESSAGE);
    noteYoutubeTrouble(refused ? "refused" : "failed");
    const refusedToast = {
      description: translate("player.youtube_refused_description"),
    };
    this.consecutiveAutoSkips += 1;

    // Stop only once every track in the queue has failed in a row (or
    // the small-queue floor is passed): a fixed cap of 3 used to kill
    // playback outright in a long queue — e.g. a mix — while tracks
    // that were never tried remained (Note 24). The cycle rule mirrors
    // the offline branch above and still bounds a repeat-all loop
    // through a fully broken queue.
    if (
      this.consecutiveAutoSkips >
      Math.max(MAX_CONSECUTIVE_AUTO_SKIPS, store.queue.length)
    ) {
      log(
        "red",
        "playback",
        `${this.consecutiveAutoSkips} consecutive tracks failed to play — stopping instead of skipping further`,
      );
      if (refused)
        showToast(
          translate("player.youtube_refused_title"),
          "error",
          refusedToast,
        );
      else
        showToast(
          translate("player.playback_stopped_too_many_errors"),
          "error",
        );
      this.consecutiveAutoSkips = 0;
      this.stopPlayback();
      store.setStatus("idle");
      store.setPosition(0);
      store.setDuration(0);
      store.setCurrentTrack(null, -1);
      return;
    }

    console.error("[PlaybackError]", info.trackId, info.message);
    log(
      "yellow",
      "playback",
      `"${track.title}" failed (${info.message}) — skipping to next`,
    );
    if (refused)
      showToast(
        translate("player.youtube_refused_title"),
        "error",
        refusedToast,
      );
    else
      showToast(translate("player.track_unavailable_title"), "error", {
        description: track.artists
          ? `${track.title} — ${track.artists}`
          : track.title,
      });
    void this.skipNext(false);
  }

  private computeNextIndex(isAutoEnd: boolean = false): number | null {
    const store = usePlayerStore.getState();
    const queueSize = store.queue.length;
    if (queueSize === 0 || store.currentIndex < 0) return null;
    if (isAutoEnd && store.repeat === "one") return store.currentIndex;

    if (store.currentIndex + 1 < queueSize) return store.currentIndex + 1;
    // radio never wraps to its first track; skipNext refills it instead
    if (isRadioContext(store.playbackContext)) return null;
    if (store.repeat === "all" || store.repeat === "one") return 0;
    return null;
  }

  /** queue refill trigger: radio refills early (one track left), autoplay-similar on the last track */
  private maybeExtendQueue(
    session: number,
    seedTrackId: string,
    index: number,
    queueLength: number,
  ): void {
    const radio = isRadioContext(usePlayerStore.getState().playbackContext);
    const due = radio
      ? shouldRefillRadio(queueLength, index)
      : index === queueLength - 1;
    if (due) this.scheduleAppendSimilarTracks(session, seedTrackId);
  }

  private scheduleAppendSimilarTracks(
    session: number,
    seedTrackId: string,
  ): void {
    if (this.radioAppendTimeout) {
      clearTimeout(this.radioAppendTimeout);
      this.radioAppendTimeout = null;
    }

    this.radioAppendTimeout = setTimeout(() => {
      void this.appendSimilarTracksForSeed(session, seedTrackId);
    }, 400);
  }

  private appendSimilarTracksForSeed(
    session: number,
    seedTrackId: string,
  ): Promise<void> {
    if (this.radioFetchInFlight) return this.radioFetchInFlight;
    const run = this.fetchAndAppendSimilarTracks(session, seedTrackId).finally(
      () => {
        if (this.radioFetchInFlight === run) this.radioFetchInFlight = null;
      },
    );
    this.radioFetchInFlight = run;
    return run;
  }

  private async fetchAndAppendSimilarTracks(
    session: number,
    seedTrackId: string,
  ): Promise<void> {
    const currentState = usePlayerStore.getState();
    // radio always continues; plain lists only when "autoplay similar" is on
    const radio = isRadioContext(currentState.playbackContext);
    if (!radio && !continuesWithSimilar(currentState)) return;
    if (isLocalTrackId(seedTrackId)) return;
    const startContext = currentState.playbackContext;

    const historyIds = currentState.queue
      .map((track) => track.id)
      .filter((id) => !isLocalTrackId(id));
    // keep paginating the same wave instance across queue generations
    if (!this.radioWaveId) this.radioWaveId = newRadioWaveId();
    const waveId = this.radioWaveId;

    let items: ApiRadioTrack[];
    try {
      const response = await api.getRadio(seedTrackId, {
        history: historyIds.slice(-20),
        k: 20,
        wave_id: waveId,
      });
      items = response.items;
    } catch (error) {
      log(
        "yellow",
        "radio",
        `similar tracks fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const state = usePlayerStore.getState();
    // radio: still valid while the same station plays (skipping within it is fine);
    // anything else: only for the exact track session that asked
    if (
      radio
        ? state.playbackContext !== startContext
        : session !== this.sessionId
    )
      return;
    if (!radio && !continuesWithSimilar(state)) return;

    const queuedIds = new Set(state.queue.map((track) => track.id));
    const additions = items
      .map(toClientTrack)
      .filter((track) => !queuedIds.has(track.id));
    if (additions.length === 0) return;

    const sample = additions
      .slice(0, 3)
      .map((t) => `"${t.title}" by ${t.artists || "Unknown"}`)
      .join(", ");
    log(
      "green",
      "radio",
      `appending ${additions.length} tracks from Radio Wave engine (wave=${waveId.slice(0, 8)} history=${historyIds.length}): [${sample}]`,
    );
    state.setQueue([...state.queue, ...additions]);
    this.preloadNextTrack(state);
  }

  private async syncDiscordPresence(
    _state: PlayerState,
    _trackChanged: boolean = false,
  ): Promise<void> {}

  private preloadNextTrack(state: PlayerState): void {
    const queue = state.queue;
    const currentIndex = state.currentIndex;
    let nextTrack: Track | null = null;
    if (currentIndex >= 0 && currentIndex < queue.length - 1) {
      nextTrack = queue[currentIndex + 1];
    } else if (
      state.repeat === "all" &&
      queue.length > 0 &&
      !isRadioContext(state.playbackContext)
    ) {
      nextTrack = queue[0];
    }

    if (!nextTrack) {
      this.lastPreloadKey = null;
      return;
    }

    const currentId = state.currentTrack?.id || "none";
    const preloadKey = `${currentId}->${nextTrack.id}`;
    if (this.lastPreloadKey === preloadKey) {
      return;
    }
    this.lastPreloadKey = preloadKey;

    if (nextTrack.coverUrl) {
      void preloadCoverArt(nextTrack.coverUrl);
    }
    if (!isLocalTrackId(nextTrack.id)) {
      void preloadArtistAvatars(nextTrack.artistId, nextTrack.artistList);
    }

    if (!lyricsCache.has(nextTrack.id)) {
      void this.prefetchLyrics(nextTrack.id, lyricsHint(nextTrack));
    }
    void loadAmbientScript(nextTrack.id);

    void linerDb.putTrack(nextTrack);

    if (playerRuntime) {
      void playerRuntime.preloadTrack(nextTrack);
    }
  }

  private async prefetchLyrics(
    trackId: string,
    hint?: LyricsHint,
  ): Promise<void> {
    if (!trackId || isLocalTrackId(trackId)) return;

    if (lyricsCache.has(trackId)) return;
    if (this.inFlightLyricsPrefetches.has(trackId)) {
      return this.inFlightLyricsPrefetches.get(trackId);
    }

    const prefetchPromise = (async () => {
      try {
        const existing = await linerDb.getLyrics(trackId);
        if (existing) {
          const lastChecked = existing.lastCheckedAt || 0;
          if (Date.now() - lastChecked < SEVEN_DAYS_MS) {
            return;
          }
        }

        let bestCandidate: LyricsCandidate | null = null;
        const providers: {
          provider: string;
          syncLevel: LyricsSyncLevel;
          quality: number;
          candidate: LyricsCandidate;
        }[] = [];
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        for await (const event of api.streamLyrics(
          trackId,
          controller.signal,
          hint,
        )) {
          if (event.type === "provider" && event.status === "found") {
            const candidate = event.candidate;
            if (shouldCacheLyricsCandidate(candidate)) {
              lyricsCache.setProvider(trackId, candidate);
            }
            providers.push({
              provider: candidate.provider,
              syncLevel: candidate.syncLevel,
              quality: candidate.quality.total,
              candidate,
            });
            if (
              !bestCandidate ||
              isBetterLyricsCandidate(candidate, bestCandidate)
            ) {
              bestCandidate = candidate;
            }
          } else if (event.type === "done") {
            break;
          }
        }
        clearTimeout(timeout);

        if (bestCandidate && shouldCacheLyricsCandidate(bestCandidate)) {
          lyricsCache.set(trackId, bestCandidate, providers);
          void linerDb.putLyrics({
            trackId,
            syncLevel: bestCandidate.syncLevel,
            quality: bestCandidate.quality.total,
            activeProvider: bestCandidate.provider,
            availableProviders: providers,
            rawLyrics: bestCandidate.lyrics.content,
            rawFormat: bestCandidate.lyrics.format,
            candidate: bestCandidate,
            lastCheckedAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      } catch {
      } finally {
        this.inFlightLyricsPrefetches.delete(trackId);
      }
    })();

    this.inFlightLyricsPrefetches.set(trackId, prefetchPromise);
    return prefetchPromise;
  }

  private showLyricsCandidate(
    trackId: string,
    candidate: LyricsCandidate,
    availableProviders: CachedLyricsItem["availableProviders"],
  ): void {
    const parsed = parseRawLyrics(
      candidate.lyrics.content,
      candidate.lyrics.format,
    );
    useLyricsStore.getState().setLyricsState({
      lyricsLoading: false,
      lyricsError: null,
      rawLyrics: candidate.lyrics.content,
      rawFormat: candidate.lyrics.format,
      braccatoLyrics: parsed.braccatoLyrics,
      syncedLines: parsed.syncedLines,
      plainLyrics: parsed.plainLyrics,
      lyricsQuality: candidate.quality.total,
      currentLyricsTrackId: trackId,
      activeProvider: candidate.provider,
      availableProviders,
    });
  }

  private showNoLyrics(trackId: string, lyricsError: string | null): void {
    useLyricsStore.getState().setLyricsState({
      lyricsLoading: false,
      lyricsError,
      rawLyrics: null,
      rawFormat: null,
      braccatoLyrics: [],
      syncedLines: [],
      plainLyrics: null,
      lyricsQuality: 0,
      currentLyricsTrackId: trackId,
      activeProvider: null,
      availableProviders: [],
    });
  }

  private async fetchLyricsForTrack(track: Track | null): Promise<void> {
    const lyricsStore = useLyricsStore.getState();

    if (!track) {
      this.currentLyricsTrackId = null;
      lyricsStore.reset();
      return;
    }

    const trackId = track.id;
    if (
      this.currentLyricsTrackId === trackId &&
      lyricsStore.currentLyricsTrackId === trackId
    ) {
      return;
    }
    if (isLocalTrackId(trackId)) {
      this.currentLyricsTrackId = trackId;
      ++this.lyricsLoadToken;
      this.lyricsAbort?.abort();
      this.lyricsAbort = null;
      this.showNoLyrics(trackId, null);
      return;
    }

    this.currentLyricsTrackId = trackId;
    const token = ++this.lyricsLoadToken;
    this.lyricsAbort?.abort();
    const controller = new AbortController();
    this.lyricsAbort = controller;
    let bestCandidate: LyricsCandidate | null = null;
    // LRCLIB fallback bookkeeping: only a stream that reaches its done
    // event may trigger it — a thrown stream (outage) must not
    let streamCompleted = false;
    let streamInstrumental = false;
    let streamCandidateCount = 0;

    const memoryCached = lyricsCache.get(trackId);
    // Wave 4 (wrong-lyrics remedy): the user's persisted pick and
    // wrong-source mark for this track, read once from the lyrics
    // cache — their only home. They steer only what is DISPLAYED at
    // the decision points below; candidate ranking, cache writes and
    // the no-lyrics outcome are exactly as before. When the fields
    // are absent (e.g. a linerDb-only record) both stay undefined and
    // behaviour is unchanged.
    const userPickKey = memoryCached?.userProvider;
    const wrongMarkKey = memoryCached?.wrongProvider?.provider;
    let cached: CachedLyricsItem | CachedLyricsRecord | null =
      memoryCached || null;
    if (!cached) {
      try {
        cached = await linerDb.getLyrics(trackId);
      } catch {
        cached = null;
      }
    }
    if (!cached) {
      const saved = await readSavedLyrics(trackId, isLyricsCandidate);
      if (saved) {
        cached = { trackId, candidate: saved, timestamp: Date.now() };
        lyricsCache.set(trackId, saved, [
          {
            provider: saved.provider,
            syncLevel: saved.syncLevel,
            quality: saved.quality.total,
            candidate: saved,
          },
        ]);
      }
    }

    // Note 22 / M3: a persisted plain-only LRCLIB fallback candidate
    // counts as absent here — it can never sync, so the track falls
    // through to the stream (and the fallback rule below) instead of
    // being served from the cache forever
    if (
      cached &&
      cached.candidate &&
      !isPlainOnlyLrclibFallback(cached.candidate)
    ) {
      // Wave 4: the displayed candidate honours the persisted pick /
      // wrong-source mark; everything below (freshness, provisional
      // refresh) still keys off the stored candidate itself
      const shownCandidate = resolveDisplayedCachedCandidate({
        candidate: cached.candidate,
        availableProviders: cached.availableProviders,
        userProvider: (cached as CachedLyricsItem).userProvider,
        wrongProvider: (cached as CachedLyricsItem).wrongProvider,
      });
      bestCandidate = shownCandidate;
      const parsed = parseRawLyrics(
        shownCandidate.lyrics.content,
        shownCandidate.lyrics.format,
      );
      lyricsStore.setLyricsState({
        lyricsLoading: false,
        lyricsError: null,
        rawLyrics: shownCandidate.lyrics.content,
        rawFormat: shownCandidate.lyrics.format,
        braccatoLyrics: parsed.braccatoLyrics,
        syncedLines: parsed.syncedLines,
        plainLyrics: parsed.plainLyrics,
        lyricsQuality: shownCandidate.quality.total,
        currentLyricsTrackId: trackId,
        activeProvider: shownCandidate.provider,
        availableProviders: cached.availableProviders || [
          {
            provider: shownCandidate.provider,
            syncLevel: shownCandidate.syncLevel,
            quality: shownCandidate.quality.total,
            candidate: shownCandidate,
          },
        ],
      });

      const lastChecked =
        (cached as any).lastCheckedAt || (cached as any).timestamp || 0;
      log(
        "cyan",
        "lyrics",
        `cache hit for "${track.title}" (age: ${Math.round((Date.now() - lastChecked) / 1000)}s)`,
      );
      const isStale = Date.now() - lastChecked >= SEVEN_DAYS_MS;
      const needsRefresh =
        isStale || isProvisionalLyricsCandidate(cached.candidate);
      if (!needsRefresh || (cached as any).userLocked) {
        return;
      }

      void linerDb.updateLyricsChecked(trackId);
    } else {
      lyricsStore.setLyricsState({
        lyricsLoading: true,
        lyricsError: null,
        rawLyrics: null,
        rawFormat: null,
        braccatoLyrics: [],
        syncedLines: [],
        plainLyrics: null,
        lyricsQuality: 0,
        currentLyricsTrackId: trackId,
        activeProvider: null,
        availableProviders: [],
      });
    }

    if (this.inFlightLyricsPrefetches.has(trackId)) {
      try {
        await this.inFlightLyricsPrefetches.get(trackId);
        if (token !== this.lyricsLoadToken || controller.signal.aborted) return;
        const freshCached =
          lyricsCache.get(trackId) || (await linerDb.getLyrics(trackId));
        if (
          freshCached &&
          freshCached.candidate &&
          !isPlainOnlyLrclibFallback(freshCached.candidate)
        ) {
          // Wave 4: same pick / wrong-mark resolution as the cache
          // read above — this is the same decision reached by a
          // different road
          const shownFresh = resolveDisplayedCachedCandidate({
            candidate: freshCached.candidate,
            availableProviders: freshCached.availableProviders,
            userProvider: (freshCached as CachedLyricsItem).userProvider,
            wrongProvider: (freshCached as CachedLyricsItem).wrongProvider,
          });
          const parsed = parseRawLyrics(
            shownFresh.lyrics.content,
            shownFresh.lyrics.format,
          );
          lyricsStore.setLyricsState({
            lyricsLoading: false,
            lyricsError: null,
            rawLyrics: shownFresh.lyrics.content,
            rawFormat: shownFresh.lyrics.format,
            braccatoLyrics: parsed.braccatoLyrics,
            syncedLines: parsed.syncedLines,
            plainLyrics: parsed.plainLyrics,
            lyricsQuality: shownFresh.quality.total,
            currentLyricsTrackId: trackId,
            activeProvider: shownFresh.provider,
            availableProviders: freshCached.availableProviders || [],
          });
          return;
        }
      } catch {}
    }

    log("cyan", "lyrics", `fetching for "${track.title}"`);

    try {
      for await (const event of api.streamLyrics(
        trackId,
        controller.signal,
        lyricsHint(track),
      )) {
        if (token !== this.lyricsLoadToken || controller.signal.aborted) break;

        if (event.type === "provider" && event.status === "found") {
          ++streamCandidateCount;
          const candidate = event.candidate;
          const currentStore = useLyricsStore.getState();
          const option = {
            provider: candidate.provider,
            syncLevel: candidate.syncLevel,
            quality: candidate.quality.total,
            candidate,
          };
          const updatedProviders = [
            ...currentStore.availableProviders.filter(
              (p) => p.provider !== candidate.provider,
            ),
            option,
          ].sort((a, b) => compareLyricsCandidates(a.candidate, b.candidate));

          // cache provider individually if it satisfies provider rules
          if (shouldCacheLyricsCandidate(candidate)) {
            lyricsCache.setProvider(trackId, candidate);
          }

          if (
            !bestCandidate ||
            isBetterLyricsCandidate(candidate, bestCandidate)
          ) {
            bestCandidate = candidate;

            const parsed = parseRawLyrics(
              candidate.lyrics.content,
              candidate.lyrics.format,
            );
            if (token !== this.lyricsLoadToken || controller.signal.aborted)
              break;

            useLyricsStore.getState().setLyricsState({
              activeProvider: candidate.provider,
              availableProviders: updatedProviders,
              rawLyrics: candidate.lyrics.content,
              rawFormat: candidate.lyrics.format,
              braccatoLyrics: parsed.braccatoLyrics,
              syncedLines: parsed.syncedLines,
              plainLyrics: parsed.plainLyrics,
              lyricsQuality: candidate.quality.total,
            });
            if (shouldCacheLyricsCandidate(candidate)) {
              lyricsCache.set(trackId, candidate, updatedProviders);
              void linerDb.putLyrics({
                trackId,
                syncLevel: candidate.syncLevel,
                quality: candidate.quality.total,
                activeProvider: candidate.provider,
                availableProviders: updatedProviders,
                rawLyrics: candidate.lyrics.content,
                rawFormat: candidate.lyrics.format,
                candidate,
                lastCheckedAt: Date.now(),
                updatedAt: Date.now(),
              });
            }
            log(
              "green",
              "lyrics",
              `candidate ${candidate.provider} q=${candidate.quality.total} sync=${candidate.syncLevel}`,
            );
          } else {
            useLyricsStore.getState().setLyricsState({
              availableProviders: updatedProviders,
            });
            log(
              "yellow",
              "lyrics",
              `skip worse candidate ${candidate.provider} q=${candidate.quality.total}`,
            );
          }

          // Wave 4: display steering at this same decision point. The
          // quality-best bookkeeping above is untouched — it feeds the
          // cache write at done and the no-lyrics outcome. What changes
          // is only which assembled candidate is on screen: a persisted
          // pick that has arrived is shown (a manual choice stands,
          // even of the marked source), and a marked source is passed
          // over once an unmarked alternative has arrived.
          if (userPickKey || wrongMarkKey) {
            const displayState = useLyricsStore.getState();
            const pickOption = userPickKey
              ? updatedProviders.find(
                  (p) => p.provider.toLowerCase().trim() === userPickKey,
                )
              : undefined;
            let steerTo: LyricsProviderOption | undefined;
            if (pickOption) {
              if (displayState.activeProvider !== pickOption.provider) {
                steerTo = pickOption;
              }
            } else if (
              wrongMarkKey &&
              bestCandidate &&
              bestCandidate.provider.toLowerCase().trim() === wrongMarkKey
            ) {
              // the automatic best is the marked source: the screen
              // belongs to the best unmarked option assembled so far
              // (the list rides in quality order). While the marked
              // source is the only one assembled there is nothing to
              // pass over to, and it stays — the sole-candidate rule.
              const bestUnmarked = updatedProviders.find(
                (p) => p.provider.toLowerCase().trim() !== wrongMarkKey,
              );
              if (
                bestUnmarked &&
                displayState.activeProvider !== bestUnmarked.provider
              ) {
                steerTo = bestUnmarked;
              }
            }
            if (steerTo) {
              const steerParsed = parseRawLyrics(
                steerTo.candidate.lyrics.content,
                steerTo.candidate.lyrics.format,
              );
              useLyricsStore.getState().setLyricsState({
                activeProvider: steerTo.provider,
                availableProviders: updatedProviders,
                rawLyrics: steerTo.candidate.lyrics.content,
                rawFormat: steerTo.candidate.lyrics.format,
                braccatoLyrics: steerParsed.braccatoLyrics,
                syncedLines: steerParsed.syncedLines,
                plainLyrics: steerParsed.plainLyrics,
                lyricsQuality: steerTo.candidate.quality.total,
              });
            }
          }
        } else if (event.type === "provider" && event.status === "error") {
          log(
            "yellow",
            "lyrics",
            `provider ${event.provider} error: ${event.message}`,
          );
        } else if (event.type === "done") {
          streamCompleted = true;
          streamInstrumental = Boolean(event.instrumental);
          if (bestCandidate && shouldCacheLyricsCandidate(bestCandidate)) {
            const currentProviders =
              useLyricsStore.getState().availableProviders;
            lyricsCache.set(trackId, bestCandidate, currentProviders);
            void linerDb.putLyrics({
              trackId,
              syncLevel: bestCandidate.syncLevel,
              quality: bestCandidate.quality.total,
              activeProvider: bestCandidate.provider,
              availableProviders: currentProviders,
              rawLyrics: bestCandidate.lyrics.content,
              rawFormat: bestCandidate.lyrics.format,
              candidate: bestCandidate,
              lastCheckedAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
          if (!bestCandidate && event.instrumental) {
            useLyricsStore.getState().setLyricsState({ instrumental: true });
          }
          log(
            "cyan",
            "lyrics",
            event.best
              ? `done, best=${event.best.provider} q=${event.best.quality}`
              : event.instrumental
                ? "done, instrumental"
                : "done, no lyrics found",
          );
          break;
        }
      }
    } catch (error) {
      if (token !== this.lyricsLoadToken || controller.signal.aborted) return;
      log(
        "red",
        "lyrics",
        `stream failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!cached) {
        useLyricsStore.getState().setLyricsState({
          lyricsError: "Failed to load lyrics.",
        });
      }
    } finally {
      if (token === this.lyricsLoadToken) {
        useLyricsStore.getState().setLyricsState({ lyricsLoading: false });
      }
    }

    // LRCLIB fallback: the primary stream completed and found nothing, and
    // no cached candidate was shown. A persisted LRCLIB candidate is shown
    // with no network; otherwise one direct lrclib.net attempt per track
    // per session. A stream exception never reaches here as a trigger
    // because streamCompleted stays false.
    if (
      token === this.lyricsLoadToken &&
      !controller.signal.aborted &&
      streamCompleted &&
      !bestCandidate &&
      !streamInstrumental
    ) {
      const persistedFallback =
        lyricsCache.getProvider(trackId, "lrclib") ||
        (cached as CachedLyricsRecord | null)?.providers?.["lrclib"] ||
        (cached as CachedLyricsRecord | null)?.availableProviders?.find(
          (p) => p.provider.toLowerCase().trim() === "lrclib",
        )?.candidate ||
        null;
      // Note 22 / M3: a plain-only persisted fallback entry counts as
      // absent, so installs carrying one heal without a cache wipe
      const cachedFallback =
        persistedFallback && !isPlainOnlyLrclibFallback(persistedFallback)
          ? persistedFallback
          : null;

      if (cachedFallback) {
        const cachedItem = lyricsCache.get(trackId);
        this.showLyricsCandidate(
          trackId,
          cachedFallback,
          cachedItem?.availableProviders ||
            (cached as CachedLyricsRecord | null)?.availableProviders || [
              {
                provider: cachedFallback.provider,
                syncLevel: cachedFallback.syncLevel,
                quality: cachedFallback.quality.total,
                candidate: cachedFallback,
              },
            ],
        );
        log("cyan", "lyrics", `cached LRCLIB fallback for "${track.title}"`);
      } else if (
        shouldAttemptLrclibFallback({
          streamCompleted,
          candidateCount: streamCandidateCount,
          instrumental: streamInstrumental,
          enabled: useLyricsStore.getState().lrclibFallbackEnabled,
          alreadyAttempted: hasAttemptedLrclibFallback(trackId),
          hasCachedFallback: false,
        })
      ) {
        markLrclibFallbackAttempted(trackId);
        const fallbackCandidate = await fetchLrclibCandidate(
          lyricsHint(track),
          controller.signal,
        );
        if (token !== this.lyricsLoadToken || controller.signal.aborted) {
          return;
        }
        if (fallbackCandidate) {
          lyricsCache.setProvider(trackId, fallbackCandidate);
          const fallbackProviders = lyricsCache.get(trackId)
            ?.availableProviders || [
            {
              provider: fallbackCandidate.provider,
              syncLevel: fallbackCandidate.syncLevel,
              quality: fallbackCandidate.quality.total,
              candidate: fallbackCandidate,
            },
          ];
          lyricsCache.set(trackId, fallbackCandidate, fallbackProviders);
          void linerDb.putLyrics({
            trackId,
            syncLevel: fallbackCandidate.syncLevel,
            quality: fallbackCandidate.quality.total,
            activeProvider: fallbackCandidate.provider,
            availableProviders: fallbackProviders,
            rawLyrics: fallbackCandidate.lyrics.content,
            rawFormat: fallbackCandidate.lyrics.format,
            candidate: fallbackCandidate,
            // stale by construction: the next play shows this cached
            // fallback instantly while the primary stream re-runs
            lastCheckedAt: 0,
            updatedAt: Date.now(),
          });
          this.showLyricsCandidate(
            trackId,
            fallbackCandidate,
            fallbackProviders,
          );
          log(
            "green",
            "lyrics",
            `LRCLIB fallback hit for "${track.title}" sync=${fallbackCandidate.syncLevel}`,
          );
        } else {
          log("cyan", "lyrics", `LRCLIB fallback miss for "${track.title}"`);
        }
      }
    }
  }
}

export const playerEngine = new PlayerEngine();
