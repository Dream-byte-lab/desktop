import { usePlayerStore } from "../store/playerStore";
import { ApiError } from "@/shared/api";
import { log } from "@/shared/utils/logger";
import { telemetry } from "@/shared/telemetry";
import { linerDb, audioCache } from "@/shared/storage";
import { isStandaloneAudioFile } from "@/shared/storage/audioFormat";
import type { Track } from "@/shared/types";
import { markLinerStreamFailed } from "@/shared/media/liner/linerPlayback";
import { isLocalTrackId } from "@/shared/media/local";
import { isSavedTrack } from "@/shared/media/saved";
import { pitchShifter } from "./pitchShifter";
import { FLAT_EQ, isEqActive } from "./equalizer";
import { resolvePlaybackStream, type PlaybackStream } from "./streamResolver";
import { logNowPlaying } from "./nowPlayingLog";
import { nextTrackForSongFade, songFadeWindowMs } from "./songFade";
import { crossfadeGains } from "./crossfade";
import {
  downloadAudioBytes,
  isBotCheckError,
  isYoutubeSignInDeclined,
  isYoutubeSignedIn,
  prefersSignInPrompt,
  requestYoutubeSignIn,
} from "@/shared/youtube";

// error recovery tuning (see the audio "error" handler)
const RECOVERY_HOLD_MS = 3000;
const WAITING_GRACE_MS = 300; // a buffering hiccup shorter than this never shows // must play this far past a recovery before it may retry again

/**
 * How long loadAndPlay waits for an in-flight background preload of the
 * same track before falling back to resolving the stream progressively.
 * The preload downloads the whole file; on a slow connection that wait
 * used to last until the download finished (or forever, if it stalled),
 * leaving a long silence — or a hang — between songs. After the grace
 * the preload keeps running in the background and may still serve a
 * later play from the cache.
 */
export const PRELOAD_WAIT_GRACE_MS = 1500;

/**
 * Whether an "ended" event means the track genuinely played out, as
 * opposed to an empty media load or teardown artefact (an element with
 * a source attached but nothing ever played). The old rule — position
 * within 1.5s of the reported duration — swallowed real ends whenever
 * the delivered audio was shorter than its metadata duration
 * (truncated or progressive streams, misreported durations) or the
 * element reported no usable duration at all: playback then simply
 * stopped with the next track showing in the queue (Note 24). A track
 * that audibly played (>= 1s in) and then ended is a genuine end,
 * wherever the reported duration claims it should have finished.
 */
export function isGenuineTrackEnd(
  durationSec: number,
  currentTimeSec: number,
): boolean {
  if (currentTimeSec >= 1) return true;
  return (
    Number.isFinite(durationSec) &&
    durationSec > 0 &&
    currentTimeSec >= Math.max(0, durationSec - 1.5)
  );
}

/**
 * One in-flight overlapping crossfade (plain playback). The outgoing
 * track keeps playing on the primary element while the incoming track
 * loads onto the standby element; once the incoming is sounding
 * ("overlapping"), an equal-power ramp runs off the outgoing's
 * playhead, and at the boundary the standby is promoted to primary.
 * See ./crossfade for the preference and the interplay ruling.
 */
interface CrossfadeState {
  outgoingTrackId: string;
  incomingTrack: Track;
  windowMs: number;
  phase: "loading" | "overlapping";
  generation: number;
  startedAtMs: number;
  cacheHit: boolean;
}

export class PlayerRuntime {
  private audio: HTMLAudioElement;
  private currentTrackId: string | null = null;
  private loadEpoch = 0;
  private loadAbortController: AbortController | null = null;
  private isResetting = false;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private stallStartTime: number | null = null;
  private loadStartTime = 0;
  private ttfbMs = 0;
  private activePlayPromise: Promise<void> | null = null;
  private activeBlobUrl: string | null = null;
  private releaseActiveStream: (() => void) | null = null;
  // track whose audio is attached to the element right now. During a skip the old
  // source stays attached (paused) until the next one is ready, so this can lag
  // currentTrackId for a moment.
  private attachedTrackId: string | null = null;
  // the attached source is a presigned r2 url (not a blob, not youtube)
  private attachedFromLiner = false;
  private preloadingTrackId: string | null = null;
  private preloadingPromise: Promise<void> | null = null;
  private preloadAbortController: AbortController | null = null;
  private backgroundCacheAbortController: AbortController | null = null;
  private currentSessionExpiresAt: number | null = null;
  private recoveryAttempts = 0;
  // after a recovery, the retry budget only refills once playback gets past this
  // position: a "playing" event alone is not proof (a bad frame further on would
  // otherwise error -> recover -> play -> error forever, reloading every time)
  private recoveryHoldUntilMs: number | null = null;
  // a "waiting" only becomes the loading state if it lasts: a seek inside an already
  // loaded / cached track fires waiting -> playing within milliseconds, and flipping
  // the status for that re-animated the play / pause button on every seek
  private waitingTimer: ReturnType<typeof setTimeout> | null = null;
  // song fade (plain playback): the track whose end-of-track fade-out has
  // been armed/performed, the window it used, and the fade-in duration the
  // next different track should start with. See ./songFade.
  private songFadeTrackId: string | null = null;
  private songFadeWindowMs = 0;
  private pendingFadeInMs: number | null = null;
  // crossfade (plain playback): the second element and everything
  // attached to it while it is the standby. At promotion the elements
  // swap roles and the standby slot's fields move into the primary
  // fields above (activeBlobUrl, releaseActiveStream, ...). See
  // ./crossfade and promoteCrossfade().
  private standbyAudio: HTMLAudioElement | null = null;
  private standbyAttachedTrackId: string | null = null;
  private standbyBlobUrl: string | null = null;
  private standbyReleaseStream: (() => void) | null = null;
  private standbyAttachedFromLiner = false;
  private standbySessionExpiresAt: number | null = null;
  private standbyStream: PlaybackStream | null = null;
  private crossfade: CrossfadeState | null = null;
  private crossfadeTimer: ReturnType<typeof setTimeout> | null = null;
  private crossfadeAbort: AbortController | null = null;
  private crossfadeGeneration = 0;
  public onEnded?: () => void;
  public onError?: (info: { trackId: string; message: string }) => void;

  constructor() {
    const win = typeof window !== "undefined" ? (window as any) : null;
    let audio = (win?.__liner_audio ||
      (typeof document !== "undefined" &&
        document.getElementById("liner-audio"))) as HTMLAudioElement | null;
    if (!audio) {
      audio = new Audio();
      audio.id = "liner-audio";
      audio.crossOrigin = "anonymous";
      audio.preload = "auto";
      if (typeof document !== "undefined") {
        document.body.appendChild(audio);
      }
    }
    if (win) {
      win.__liner_audio = audio;
    }
    this.audio = audio;
    this.setupAudioListeners(this.audio);
    this.watchStandbyErrors(this.audio);

    const initialVolume = usePlayerStore.getState().volume;
    this.audio.volume = Math.min(1, Math.max(0, initialVolume));
    this.applyPlaybackRateAndPitch();
    pitchShifter.setUserVolume(initialVolume, this.audio);
    log("cyan", "boot", `volume ${initialVolume}`);

    usePlayerStore.subscribe((state, prevState) => {
      if (state.status !== prevState.status) {
        this.syncMediaSessionState(state.status);
      }
      if (state.volume !== prevState.volume) {
        this.cancelFade();
        // During a crossfade overlap the ramp owns both elements'
        // volumes (it recomputes from the store volume on every tick),
        // so the direct write to the outgoing element is skipped.
        if (!this.audio.paused && this.crossfade?.phase !== "overlapping") {
          this.audio.volume = Math.min(1, Math.max(0, state.volume));
        }
        pitchShifter.setUserVolume(state.volume, this.audio);
        if (state.volume > 1) {
          const available = pitchShifter.isAttached();
          if (state.volumeBoostAvailable !== available) {
            state.setVolumeBoostAvailable(available);
          }
        }
      }
      if (
        state.playbackRate !== prevState.playbackRate ||
        state.isPitchLinked !== prevState.isPitchLinked ||
        state.pitchSemitones !== prevState.pitchSemitones ||
        state.isReverbEnabled !== prevState.isReverbEnabled ||
        state.reverbLevel !== prevState.reverbLevel ||
        state.isEqEnabled !== prevState.isEqEnabled ||
        state.eqGains !== prevState.eqGains
      ) {
        const rate = state.playbackRate ?? 1;
        const preservesPitch = !state.isPitchLinked;
        this.applyPlaybackRateAndPitch(rate, preservesPitch);
      }
    });

    this.setupDeviceChangeListener();
    this.setupMediaSession();
    log("green", "boot", "player runtime initialized");
  }

  private setupDeviceChangeListener() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;

    let initial = true;
    const onDeviceChange = () => {
      if (initial) {
        initial = false;
        return;
      }
      if (!usePlayerStore.getState().pauseOnDeviceChange) return;
      if (
        !this.audio.paused &&
        usePlayerStore.getState().status === "playing"
      ) {
        this.pause();
      }
    };

    try {
      navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
      void navigator.mediaDevices.enumerateDevices().then(() => {
        initial = false;
      });
    } catch {
      // ignore unsupported environments
    }
  }

  private setupMediaSession() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;

    try {
      navigator.mediaSession.setActionHandler("play", () => {
        usePlayerStore.getState().dispatch({ type: "RESUME_REQUESTED" });
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        usePlayerStore.getState().dispatch({ type: "PAUSE_REQUESTED" });
      });
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        usePlayerStore.getState().dispatch({ type: "SKIP_PREVIOUS" });
      });
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        usePlayerStore.getState().dispatch({ type: "SKIP_NEXT" });
      });
      navigator.mediaSession.setActionHandler("stop", () => {
        usePlayerStore.getState().dispatch({ type: "PAUSE_REQUESTED" });
      });
      const seekBy = (deltaSeconds: number) => {
        const st = usePlayerStore.getState();
        const max =
          st.durationMs > 0 ? st.durationMs : Number.POSITIVE_INFINITY;
        const next = Math.min(
          max,
          Math.max(0, st.positionMs + deltaSeconds * 1000),
        );
        st.dispatch({ type: "SEEK_COMMITTED", positionMs: Math.round(next) });
      };
      navigator.mediaSession.setActionHandler("seekbackward", (details) => {
        seekBy(-(details.seekOffset ?? 10));
      });
      navigator.mediaSession.setActionHandler("seekforward", (details) => {
        seekBy(details.seekOffset ?? 10);
      });
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details.seekTime !== undefined && !Number.isNaN(details.seekTime)) {
          usePlayerStore.getState().dispatch({
            type: "SEEK_COMMITTED",
            positionMs: Math.round(details.seekTime * 1000),
          });
        }
      });
    } catch {
      // ignore unsupported media session actions
    }
  }

  // windows' media controls (and apps built on them, like FluentFlyout) read this.
  // "loading" between tracks still reports playing so the session never looks finished.
  private syncMediaSessionState(status: string) {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;
    try {
      navigator.mediaSession.playbackState =
        status === "playing" || status === "loading"
          ? "playing"
          : status === "paused"
            ? "paused"
            : "none";
      if (status === "idle") navigator.mediaSession.metadata = null;
    } catch {
      // ignore unsupported environments
    }
  }

  // progress / seek bar in the system controls
  private syncMediaSessionPosition() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;
    const ms = navigator.mediaSession as MediaSession & {
      setPositionState?: (state?: MediaPositionState) => void;
    };
    if (typeof ms.setPositionState !== "function") return;
    if (this.attachedTrackId !== this.currentTrackId) return;
    const duration = this.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      ms.setPositionState({
        duration,
        playbackRate: this.audio.playbackRate > 0 ? this.audio.playbackRate : 1,
        position: Math.min(duration, Math.max(0, this.audio.currentTime || 0)),
      });
    } catch {
      // ignore invalid transient states
    }
  }

  public updateMediaSessionMetadata(track: Track | null) {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artists,
        album: (track as { albumTitle?: string }).albumTitle || "Linerave",
        artwork: track.coverUrl
          ? [
              { src: track.coverUrl, sizes: "96x96", type: "image/jpeg" },
              { src: track.coverUrl, sizes: "256x256", type: "image/jpeg" },
              { src: track.coverUrl, sizes: "512x512", type: "image/jpeg" },
            ]
          : [],
      });
    } catch {
      // ignore metadata assignment failures
    }
  }

  private setupAudioListeners(audioEl: HTMLAudioElement) {
    audioEl.addEventListener("timeupdate", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (!this.currentTrackId) return;
      if (usePlayerStore.getState().status === "loading") return;
      if (Number.isNaN(audioEl.currentTime)) return;

      const posMs = Math.round(audioEl.currentTime * 1000);
      usePlayerStore.getState().setPosition(posMs);
      if (
        this.recoveryHoldUntilMs !== null &&
        posMs >= this.recoveryHoldUntilMs
      ) {
        this.recoveryHoldUntilMs = null;
        this.recoveryAttempts = 0;
      }
      this.maybeCrossfade(audioEl);
      this.maybeSongFade(audioEl);
    });

    audioEl.addEventListener("durationchange", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (!this.currentTrackId) return;
      if (Number.isNaN(audioEl.duration) || audioEl.duration <= 0) return;

      usePlayerStore
        .getState()
        .setDuration(Math.round(audioEl.duration * 1000));
      this.syncMediaSessionPosition();
    });

    for (const type of [
      "seeked",
      "ratechange",
      "play",
      "pause",
      "loadedmetadata",
    ]) {
      audioEl.addEventListener(type, () => {
        if (this.isResetting || audioEl !== this.audio) return;
        this.syncMediaSessionPosition();
      });
    }

    audioEl.addEventListener("waiting", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      log("yellow", "audio", "buffering (waiting)");
      this.stallStartTime = performance.now();
      if (this.waitingTimer) clearTimeout(this.waitingTimer);
      this.waitingTimer = setTimeout(() => {
        this.waitingTimer = null;
        // still stuck: a real stall, show it
        if (audioEl !== this.audio || audioEl.paused || audioEl.readyState >= 3)
          return;
        if (usePlayerStore.getState().status === "playing") {
          usePlayerStore.getState().setStatus("loading");
        }
      }, WAITING_GRACE_MS);
    });

    // resumed (or never really stalled): drop a pending "loading"
    for (const type of ["playing", "seeked", "canplay", "pause", "emptied"]) {
      audioEl.addEventListener(type, () => {
        if (audioEl !== this.audio || !this.waitingTimer) return;
        if (type === "seeked" && audioEl.readyState < 3) return; // seeked but still no data
        clearTimeout(this.waitingTimer);
        this.waitingTimer = null;
      });
    }

    audioEl.addEventListener("ended", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (!this.currentTrackId) return;
      if (this.attachedTrackId !== this.currentTrackId) return;

      // Ensure the track truly finished playing (not an empty media load or teardown artefact)
      const duration = audioEl.duration;
      const currentTime = audioEl.currentTime;
      if (isGenuineTrackEnd(duration, currentTime)) {
        log("cyan", "audio", "ended — skipping to next");
        this.onEnded?.();
        const state = usePlayerStore.getState();
        state.dispatch({ type: "SKIP_NEXT", isAutoEnd: true });
      }
    });

    audioEl.addEventListener("playing", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      log("green", "audio", "playing");
      if (this.recoveryHoldUntilMs === null) this.recoveryAttempts = 0;
      this.applyPlaybackRateAndPitch();

      if (this.stallStartTime !== null) {
        const stallDurationMs = Math.round(
          performance.now() - this.stallStartTime,
        );
        if (stallDurationMs > 400) {
          telemetry.trackPlaybackHealth("STALL_BUFFERING", {
            trackId: this.currentTrackId || undefined,
            stallDurationMs,
          });
        }
        this.stallStartTime = null;
      }

      if (!this.currentTrackId || audioEl.paused) return;
      const currentStatus = usePlayerStore.getState().status;
      if (currentStatus !== "paused") {
        usePlayerStore.getState().setStatus("playing");
      }
    });

    audioEl.addEventListener("pause", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      log("cyan", "audio", "paused");
      const st = usePlayerStore.getState().status;
      if (st === "playing") {
        usePlayerStore.getState().setStatus("paused");
      }
    });

    audioEl.addEventListener("error", () => {
      if (this.isResetting || audioEl !== this.audio) return;
      if (
        !this.currentTrackId ||
        !audioEl.src ||
        audioEl.src === window.location.href
      )
        return;
      // the previous track's source is still attached while the next one loads
      if (this.attachedTrackId !== this.currentTrackId) return;

      const message = audioEl.error?.message || "Audio playback error";
      const code = audioEl.error?.code;
      console.error(
        "[AudioElementError]",
        this.currentTrackId,
        code,
        message,
        audioEl.src,
      );
      log("red", "audio", `error (code ${code}): ${message}`);

      const isDecode =
        code ===
          (typeof MediaError !== "undefined"
            ? MediaError.MEDIA_ERR_DECODE
            : 3) ||
        code ===
          (typeof MediaError !== "undefined"
            ? MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            : 4);

      if (isDecode) {
        telemetry.trackPlaybackHealth("MEDIA_DECODE_ERROR", {
          trackId: this.currentTrackId || undefined,
          errorMessage: message,
          details: { mediaErrorCode: code },
        });
      }

      if (this.attachedFromLiner) {
        this.attachedFromLiner = false;
        markLinerStreamFailed(`media error ${code}`);
      }

      if (this.activeBlobUrl) {
        URL.revokeObjectURL(this.activeBlobUrl);
        this.activeBlobUrl = null;
        void linerDb.deleteAudio(this.currentTrackId);
        audioCache.deleteAudio(this.currentTrackId);
      }

      // The outgoing track errored mid-crossfade: do not spend the
      // recovery reload on a source that is already leaving — complete
      // the hand-off early instead. The engine's advance lands in
      // loadAndPlay, whose promotion branch swaps in the incoming
      // element (already sounding on the standby). During the
      // crossfade's loading phase the incoming is not sounding yet, so
      // the standard recovery below owns those errors.
      if (this.crossfade?.phase === "overlapping") {
        this.completeCrossfadeEarly();
        return;
      }

      const store = usePlayerStore.getState();
      const currentTrack = store.currentTrack;
      const posMs =
        Number.isFinite(audioEl.currentTime) && audioEl.currentTime > 0
          ? Math.round(audioEl.currentTime * 1000)
          : store.positionMs;

      if (
        currentTrack &&
        currentTrack.id === this.currentTrackId &&
        this.recoveryAttempts < 1
      ) {
        this.recoveryAttempts++;
        this.recoveryHoldUntilMs = posMs + RECOVERY_HOLD_MS;
        log(
          "yellow",
          "playback",
          `audio error encountered — recovering via cache/stream at ${posMs}ms`,
        );
        void this.loadAndPlay(currentTrack, posMs, true);
        return;
      }

      usePlayerStore.getState().setStatus("error", message);
      this.onError?.({ trackId: this.currentTrackId, message });
    });
  }

  public getCurrentTrackId(): string | null {
    return this.currentTrackId;
  }

  public hasLoadedSourceFor(trackId: string): boolean {
    const isExpired =
      this.currentSessionExpiresAt !== null &&
      Date.now() >= this.currentSessionExpiresAt - 15_000;
    return (
      this.currentTrackId === trackId &&
      this.attachedTrackId === trackId &&
      Boolean(this.audio.currentSrc || this.audio.src) &&
      this.audio.src !== window.location.href &&
      !this.audio.error &&
      !isExpired
    );
  }

  public applyPlaybackRateAndPitch(
    rate?: number,
    preservesPitch?: boolean,
  ): void {
    if (!this.audio) return;
    const store = usePlayerStore.getState();
    const targetRate = rate ?? store.playbackRate ?? 1;
    const targetPreserves =
      preservesPitch ??
      (store.isPitchLinked !== undefined ? !store.isPitchLinked : true);

    try {
      this.audio.playbackRate = targetRate;
      this.audio.defaultPlaybackRate = targetRate;
      this.audio.preservesPitch = targetPreserves;
      (this.audio as any).mozPreservesPitch = targetPreserves;
      (this.audio as any).webkitPreservesPitch = targetPreserves;
    } catch {
      // Audio element not initialized or properties unsupported
    }

    try {
      const isPitchLinked = store.isPitchLinked ?? true;
      const pitchSemitones = store.pitchSemitones ?? 0;
      const isReverbEnabled = store.isReverbEnabled ?? false;
      const reverbLevel = store.reverbLevel ?? 0.35;
      const isEqEnabled = store.isEqEnabled ?? false;
      const eqGains = store.eqGains ?? FLAT_EQ;
      const needsEffects =
        isReverbEnabled ||
        isEqActive(isEqEnabled, eqGains) ||
        (!isPitchLinked && Math.abs(pitchSemitones) >= 0.05);
      if (!needsEffects && !pitchShifter.isAttached()) return;
      pitchShifter.attach(this.audio);
      pitchShifter.update({
        pitchSemitones,
        isPitchLinked,
        isReverbEnabled,
        reverbLevel,
        isEqEnabled,
        eqGains,
      });
      pitchShifter.setUserVolume(store.volume, this.audio);
    } catch (err) {
      console.error("[PlayerRuntime] applyPlaybackRateAndPitch error:", err);
    }
  }

  private cancelFade(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  private fadeVolume(
    targetVolume: number,
    durationMs: number = 180,
    onComplete?: () => void,
  ): void {
    this.cancelFade();
    const startVolume = this.audio.volume;
    const diff = targetVolume - startVolume;
    if (Math.abs(diff) < 0.001 || durationMs <= 0) {
      this.audio.volume = Math.max(0, Math.min(1, targetVolume));
      onComplete?.();
      return;
    }

    const startTime = performance.now();

    const tick = () => {
      const now = performance.now();
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = 0.5 - 0.5 * Math.cos(progress * Math.PI);
      const current = startVolume + diff * eased;
      this.audio.volume = Math.max(0, Math.min(1, current));

      if (progress < 1) {
        // audio fade ticks independently of display vsync in background
        this.fadeTimer = setTimeout(tick, 16);
      } else {
        this.fadeTimer = null;
        this.audio.volume = Math.max(0, Math.min(1, targetVolume));
        onComplete?.();
      }
    };

    this.fadeTimer = setTimeout(tick, 16);
  }

  private clearSongFade(): void {
    this.songFadeTrackId = null;
    this.songFadeWindowMs = 0;
    this.pendingFadeInMs = null;
  }

  /**
   * Song fade, driven from timeupdate: when the playing track enters
   * the fade window before its end (and a next track exists to fade
   * toward), fade the element out over the remaining time and remember
   * the window so the next track fades in over the same span. Only the
   * plain element is ever faded: during a DJ session this element is
   * not the playing source, and the preference stays out of the
   * session's joins entirely.
   */
  private maybeSongFade(audioEl: HTMLAudioElement): void {
    if (!this.currentTrackId || this.attachedTrackId !== this.currentTrackId)
      return;
    const store = usePlayerStore.getState();
    // Interplay ruling (see ./crossfade): while the crossfade
    // preference is on, the crossfade owns the boundary and the song
    // fade never engages — the two must not stack on one change. A
    // fade armed before the preference was switched on is cancelled
    // and the volume restored, exactly like a seek back out of it.
    if (store.crossfadeSeconds > 0) {
      if (this.songFadeTrackId === this.currentTrackId) {
        this.cancelFade();
        if (!audioEl.paused && store.status === "playing") {
          audioEl.volume = Math.min(1, Math.max(0, store.volume));
        }
        this.clearSongFade();
      }
      return;
    }
    const duration = audioEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const rate = audioEl.playbackRate > 0 ? audioEl.playbackRate : 1;
    const remainingSec = (duration - audioEl.currentTime) / rate;

    if (this.songFadeTrackId === this.currentTrackId) {
      // A fade-out is armed for this track. If the listener seeked back
      // out of the window, cancel it and restore full volume; if a
      // pause/resume cycle restored the volume inside the window,
      // re-run the fade over what remains.
      if (remainingSec > this.songFadeWindowMs / 1000 + 1) {
        this.cancelFade();
        if (!audioEl.paused && store.status === "playing") {
          audioEl.volume = Math.min(1, Math.max(0, store.volume));
        }
        this.clearSongFade();
        return;
      }
      if (
        !audioEl.paused &&
        store.status === "playing" &&
        remainingSec > 0 &&
        this.fadeTimer === null &&
        audioEl.volume > 0.02
      ) {
        this.fadeVolume(0, Math.max(50, Math.round(remainingSec * 1000)));
      }
      return;
    }

    const preference = store.songFadeSeconds;
    if (!preference || preference <= 0) return;
    if (audioEl.paused || store.status !== "playing") return;
    const next = nextTrackForSongFade(store);
    if (!next) return;
    const windowMs = songFadeWindowMs(
      preference,
      duration,
      next.durationMs ? next.durationMs / 1000 : null,
    );
    if (windowMs <= 0) return;
    if (remainingSec <= 0 || remainingSec > windowMs / 1000) return;

    this.songFadeTrackId = this.currentTrackId;
    this.songFadeWindowMs = windowMs;
    this.pendingFadeInMs = windowMs;
    this.fadeVolume(0, Math.max(50, Math.round(remainingSec * 1000)));
  }

  // ------------------------------------------------------------------
  // Crossfade (plain playback): a second element, promoted into the
  // same machinery as the primary, overlaps the boundary. The full
  // design — hand-off protocol and failure semantics — is documented
  // in investigation/plain-playback-crossfade.md; the preference and
  // the song-fade interplay ruling live in ./crossfade.
  // ------------------------------------------------------------------

  /**
   * The standby element, created lazily on the first crossfade. It is
   * a full citizen from birth: the standard listener set is attached
   * (dormant while it is not this.audio — every listener guards on the
   * element's role), plus one dedicated error listener that only acts
   * while the element is the crossfade's incoming leg.
   */
  private ensureStandbyAudio(): HTMLAudioElement {
    if (this.standbyAudio) return this.standbyAudio;
    const el = new Audio();
    el.id = "liner-audio-b";
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    if (typeof document !== "undefined") {
      document.body.appendChild(el);
    }
    this.standbyAudio = el;
    this.setupAudioListeners(el);
    this.watchStandbyErrors(el);
    return el;
  }

  /**
   * The incoming leg's own error path, registered on BOTH elements:
   * whichever one is currently the standby, an error on the crossfade's
   * incoming source cancels the overlap and restores the outgoing —
   * the outgoing is never sacrificed to a failed incoming. Inert in
   * every other state (the standard error handler owns a primary's
   * errors, including the early hand-off case).
   */
  private watchStandbyErrors(el: HTMLAudioElement): void {
    el.addEventListener("error", () => {
      if (el !== this.standbyAudio) return;
      const cf = this.crossfade;
      if (!cf || cf.phase !== "overlapping") return;
      if (this.standbyAttachedTrackId !== cf.incomingTrack.id) return;
      if (!el.src || el.src === window.location.href) return;
      log(
        "yellow",
        "crossfade",
        `incoming track failed mid-overlap — cancelling the crossfade, the outgoing track plays on`,
      );
      this.cancelCrossfade(true);
    });
  }

  /**
   * Arm check, driven from the primary's timeupdate (the same place
   * the song fade arms from). Mirrors the song fade's conditions —
   * auto-end next track (never repeat-one, never radio), the shared
   * window maths, the primary actually playing — because a crossfade
   * is only ever an ornament on the existing advance, never a second
   * advance mechanism.
   */
  private maybeCrossfade(audioEl: HTMLAudioElement): void {
    if (this.crossfade) return;
    if (!this.currentTrackId || this.attachedTrackId !== this.currentTrackId)
      return;
    const store = usePlayerStore.getState();
    const preference = store.crossfadeSeconds;
    if (!preference || preference <= 0) return;
    if (audioEl.paused || store.status !== "playing") return;
    const duration = audioEl.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const next = nextTrackForSongFade(store);
    if (!next) return;
    const windowMs = songFadeWindowMs(
      preference,
      duration,
      next.durationMs ? next.durationMs / 1000 : null,
    );
    if (windowMs <= 0) return;
    const rate = audioEl.playbackRate > 0 ? audioEl.playbackRate : 1;
    const remainingSec = (duration - audioEl.currentTime) / rate;
    if (remainingSec <= 0 || remainingSec > windowMs / 1000) return;

    // The crossfade supersedes any song-fade bookkeeping for this
    // boundary (with the preference on, maybeSongFade never arms, but
    // a state left by an earlier boundary must not leak a fade-in).
    this.clearSongFade();
    const generation = ++this.crossfadeGeneration;
    this.crossfade = {
      outgoingTrackId: this.currentTrackId,
      incomingTrack: next,
      windowMs,
      phase: "loading",
      generation,
      startedAtMs: performance.now(),
      cacheHit: false,
    };
    log(
      "cyan",
      "crossfade",
      `armed: "${next.title}" overlaps the last ${Math.round(windowMs / 100) / 10}s`,
    );
    void this.loadStandby(next, generation);
  }

  /**
   * Loads the incoming track onto the standby element. Mirrors
   * loadAndPlay's source discipline (background-preload grace, audio
   * cache first, progressive stream otherwise) but touches nothing
   * the store or the primary owns: no status, no position, no media
   * session — the outgoing track is still the playing track until
   * promotion. Any failure cancels the crossfade and leaves the
   * outgoing exactly as it was; the boundary then runs through the
   * ordinary machinery (advance, its own recovery, the skip breaker).
   */
  private async loadStandby(track: Track, generation: number): Promise<void> {
    const el = this.ensureStandbyAudio();
    const stale = () =>
      generation !== this.crossfadeGeneration ||
      this.crossfade?.incomingTrack.id !== track.id;
    const fail = (reason: string) => {
      if (stale()) return;
      log("yellow", "crossfade", `incoming load abandoned: ${reason}`);
      this.cancelCrossfade(true);
    };

    // Same preload grace as loadAndPlay: if the background preload of
    // this very track is in flight, give it a bounded moment to land
    // in the cache; a slow download must not hold the overlap hostage.
    if (this.preloadingTrackId === track.id && this.preloadingPromise) {
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          this.preloadingPromise,
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, PRELOAD_WAIT_GRACE_MS);
          }),
        ]);
      } finally {
        if (graceTimer !== null) clearTimeout(graceTimer);
      }
      if (stale()) return;
    }

    const controller = new AbortController();
    this.crossfadeAbort = controller;

    try {
      const cachedAudio = isSavedTrack(track.id)
        ? null
        : await linerDb.getAudio(track.id);
      if (stale()) return;

      const isValidCachedBlob =
        Boolean(cachedAudio?.blob) &&
        cachedAudio!.blob.size > 0 &&
        (!cachedAudio!.blob.type ||
          cachedAudio!.blob.type.startsWith("audio/"));

      if (cachedAudio && isValidCachedBlob) {
        const blobUrl = URL.createObjectURL(cachedAudio.blob);
        this.attachStandbySource(blobUrl, true, track.id, false, null, null);
        if (this.crossfade) this.crossfade.cacheHit = true;
      } else {
        const stream = await resolvePlaybackStream(track, controller.signal, {
          progressive: true,
        });
        if (stale()) {
          stream.release?.();
          return;
        }
        const url = stream.blob ? URL.createObjectURL(stream.blob) : stream.url;
        this.attachStandbySource(
          url,
          Boolean(stream.blob),
          track.id,
          Boolean(stream.fromLiner),
          stream.expiresAtMs,
          stream,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      // A sign-in-shaped failure (YouTube bot-check) is NOT surfaced
      // from here: prompting mid-track would interrupt a song that is
      // playing fine. The boundary load raises it through the normal
      // path when the track actually starts.
      fail(error instanceof Error ? error.message : "incoming stream failed");
      return;
    }

    // Element-level playback parity with the primary: same rate and
    // pitch-preservation props. (Graph-level parity — EQ, reverb,
    // pitch shifting, boost — comes from the shared chain the
    // secondary leg feeds; see pitchShifter.attachSecondary.)
    try {
      const store = usePlayerStore.getState();
      const rate = store.playbackRate ?? 1;
      el.playbackRate = rate;
      el.defaultPlaybackRate = rate;
      const preserves =
        store.isPitchLinked !== undefined ? !store.isPitchLinked : true;
      el.preservesPitch = preserves;
      (el as any).mozPreservesPitch = preserves;
      (el as any).webkitPreservesPitch = preserves;
    } catch {
      // element props unsupported — the primary tolerates the same
    }
    pitchShifter.attachSecondary(el);

    el.volume = 0;
    el.load();
    if (el.readyState < 3) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        const done = () => {
          clearTimeout(timeout);
          el.removeEventListener("canplay", done);
          el.removeEventListener("error", done);
          resolve();
        };
        el.addEventListener("canplay", done, { once: true });
        el.addEventListener("error", done, { once: true });
      });
    }
    if (stale()) return;
    if (el.error) {
      fail(el.error.message || "incoming media error");
      return;
    }

    try {
      await el.play();
    } catch (error) {
      fail(error instanceof Error ? error.message : "incoming play() rejected");
      return;
    }
    if (stale()) {
      // A newer crossfade may already own this element — only pause
      // when nothing does (a plain cancellation left it sounding).
      if (!this.crossfade) el.pause();
      return;
    }
    if (!this.crossfade) return;
    // The listener switched the preference off while this loaded:
    // honour it rather than starting an overlap they just cancelled.
    if (usePlayerStore.getState().crossfadeSeconds <= 0) {
      this.cancelCrossfade(true);
      return;
    }
    this.crossfade.phase = "overlapping";
    log("cyan", "crossfade", `incoming sounding: "${track.title}"`);
    this.startCrossfadeRamp();
  }

  private attachStandbySource(
    url: string,
    isBlob: boolean,
    trackId: string,
    fromLiner: boolean,
    expiresAtMs: number | null,
    stream: PlaybackStream | null,
  ): void {
    const el = this.ensureStandbyAudio();
    this.releaseStandbySource();
    el.src = url;
    this.standbyBlobUrl = isBlob ? url : null;
    this.standbyAttachedTrackId = trackId;
    this.standbyAttachedFromLiner = fromLiner;
    this.standbySessionExpiresAt = expiresAtMs;
    this.standbyReleaseStream = stream?.release ?? null;
    this.standbyStream = stream;
  }

  /** Releases whatever the standby element currently holds. Idempotent. */
  private releaseStandbySource(): void {
    this.standbyReleaseStream?.();
    this.standbyReleaseStream = null;
    if (this.standbyBlobUrl) {
      URL.revokeObjectURL(this.standbyBlobUrl);
      this.standbyBlobUrl = null;
    }
    this.standbyStream = null;
    this.standbyAttachedTrackId = null;
    this.standbyAttachedFromLiner = false;
    this.standbySessionExpiresAt = null;
    pitchShifter.detachSecondary();
    const el = this.standbyAudio;
    if (el) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        // a detached element needs no ceremony
      }
    }
  }

  /**
   * The overlap ramp: a 16ms tick (the fadeVolume idiom) computing
   * progress from the OUTGOING's playhead — progress = how far into
   * the window the outgoing has travelled — and applying equal-power
   * gains to both elements, scaled by the store volume's element
   * share. Position-driven, so pause freezes the ramp with the music
   * and a resume picks it up from the frozen point; the outgoing's
   * natural end (or an early hand-off) ends it via promotion.
   */
  private startCrossfadeRamp(): void {
    this.stopCrossfadeRamp();
    const tick = () => {
      this.crossfadeTimer = null;
      const cf = this.crossfade;
      if (!cf || cf.phase !== "overlapping") return;
      // The preference was switched off mid-overlap: end it cleanly.
      if (usePlayerStore.getState().crossfadeSeconds <= 0) {
        this.cancelCrossfade(true);
        return;
      }
      const out = this.audio;
      const into = this.standbyAudio;
      if (!into) return;
      // If the graph attached after the standby loaded (an effect or
      // boost switched on mid-overlap), join the incoming leg now —
      // attachSecondary is idempotent.
      if (pitchShifter.isAttached()) pitchShifter.attachSecondary(into);
      if (out.paused || into.paused) return;
      const duration = out.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        this.crossfadeTimer = setTimeout(tick, 16);
        return;
      }
      const rate = out.playbackRate > 0 ? out.playbackRate : 1;
      const remainingSec = Math.max(0, (duration - out.currentTime) / rate);
      const progress = Math.min(
        1,
        Math.max(0, 1 - remainingSec / (cf.windowMs / 1000)),
      );
      const ceiling = Math.min(
        1,
        Math.max(0, usePlayerStore.getState().volume),
      );
      const { outGain, inGain } = crossfadeGains(progress);
      out.volume = outGain * ceiling;
      into.volume = inGain * ceiling;
      if (progress < 1) {
        this.crossfadeTimer = setTimeout(tick, 16);
      }
    };
    this.crossfadeTimer = setTimeout(tick, 16);
  }

  private stopCrossfadeRamp(): void {
    if (this.crossfadeTimer !== null) {
      clearTimeout(this.crossfadeTimer);
      this.crossfadeTimer = null;
    }
  }

  /**
   * Ends the crossfade without a hand-off: the standby is released
   * and, when asked, the outgoing's volume is restored to the store
   * ceiling — the outgoing track must never be sacrificed to a failed
   * or cancelled overlap; it plays on to its natural end, where the
   * ordinary boundary machinery takes over.
   */
  private cancelCrossfade(restoreOutgoingVolume: boolean): void {
    this.crossfadeGeneration += 1;
    this.crossfadeAbort?.abort();
    this.crossfadeAbort = null;
    this.stopCrossfadeRamp();
    const wasOverlapping = this.crossfade?.phase === "overlapping";
    this.crossfade = null;
    this.releaseStandbySource();
    if (restoreOutgoingVolume && wasOverlapping && !this.audio.paused) {
      this.audio.volume = Math.min(
        1,
        Math.max(0, usePlayerStore.getState().volume),
      );
    }
  }

  /**
   * The outgoing errored while the overlap was sounding: advance the
   * boundary NOW through the same dispatch a natural end uses, so the
   * engine lands in loadAndPlay and takes the promotion branch. The
   * broken source is never given the recovery reload.
   */
  private completeCrossfadeEarly(): void {
    log(
      "yellow",
      "crossfade",
      "outgoing failed mid-overlap — completing the hand-off early",
    );
    this.onEnded?.();
    usePlayerStore.getState().dispatch({ type: "SKIP_NEXT", isAutoEnd: true });
  }

  /**
   * The hand-off: the standby element becomes the primary and every
   * piece of machinery that keyed off the old element follows it —
   * element listeners (already attached, role-guarded), the effects
   * graph (the secondary leg is promoted), the id / window handle the
   * rest of the app looks the element up by, media-session metadata
   * and position, store position/duration, now-playing logging, the
   * full-source watch and the background cache. The old element is
   * paused, unloaded and parked as the new standby.
   */
  private promoteCrossfade(track: Track): void {
    const cf = this.crossfade;
    const standby = this.standbyAudio;
    if (!cf || !standby) return;
    this.stopCrossfadeRamp();
    this.crossfade = null;
    this.crossfadeAbort = null;
    this.cancelFade();
    this.loadEpoch += 1;
    this.pendingStartPositionMs = 0;

    // Capture the incoming leg's source state before the swap.
    const inBlobUrl = this.standbyBlobUrl;
    const inRelease = this.standbyReleaseStream;
    const inFromLiner = this.standbyAttachedFromLiner;
    const inExpiresAt = this.standbySessionExpiresAt;
    const inStream = this.standbyStream;
    this.standbyBlobUrl = null;
    this.standbyReleaseStream = null;
    this.standbyAttachedFromLiner = false;
    this.standbySessionExpiresAt = null;
    this.standbyStream = null;
    this.standbyAttachedTrackId = null;

    // Retire the outgoing element (it may already have ended).
    const outgoing = this.audio;
    this.isResetting = true;
    try {
      outgoing.pause();
      this.releaseStream();
      if (this.activeBlobUrl) {
        URL.revokeObjectURL(this.activeBlobUrl);
        this.activeBlobUrl = null;
      }
      outgoing.removeAttribute("src");
      outgoing.load();
    } catch {
    } finally {
      this.isResetting = false;
    }

    // Swap roles — elements, lookup ids, and the window handle.
    this.audio = standby;
    this.standbyAudio = outgoing;
    outgoing.id = "liner-audio-b";
    standby.id = "liner-audio";
    const win = typeof window !== "undefined" ? (window as any) : null;
    if (win) win.__liner_audio = standby;

    // The primary slot now describes the incoming track.
    this.activeBlobUrl = inBlobUrl;
    this.releaseActiveStream = inRelease;
    this.attachedTrackId = track.id;
    this.attachedFromLiner = inFromLiner;
    this.currentSessionExpiresAt = inExpiresAt;
    this.currentTrackId = track.id;
    this.recoveryAttempts = 0;
    this.recoveryHoldUntilMs = null;

    // The graph follows the hand-off, then rate/effects are asserted
    // on the new primary exactly as a fresh load would assert them.
    pitchShifter.promoteSecondary(standby);
    this.applyPlaybackRateAndPitch();

    // Land at full volume (the ramp had all but completed the fade-in;
    // a user skip mid-overlap lands here from part-way, which should
    // still arrive at full volume, not stay dipped).
    standby.volume = Math.min(1, Math.max(0, usePlayerStore.getState().volume));

    const store = usePlayerStore.getState();
    this.updateMediaSessionMetadata(track);
    store.setDuration(
      Number.isFinite(standby.duration) && standby.duration > 0
        ? Math.round(standby.duration * 1000)
        : (track.durationMs ?? 0),
    );
    store.setPosition(Math.round((standby.currentTime || 0) * 1000));
    store.setStatus("playing");
    this.syncMediaSessionPosition();

    // The deferred full-source watch and background caching register
    // against the primary now that the roles have swapped.
    if (inStream) {
      this.watchFullSource(track.id, inStream);
      this.backgroundCacheAbortController?.abort();
      const bgCacheController = new AbortController();
      this.backgroundCacheAbortController = bgCacheController;
      this.cacheAudioInBackground(track, inStream, bgCacheController.signal);
    }

    logNowPlaying(
      track,
      cf.cacheHit,
      Math.round(performance.now() - cf.startedAtMs),
    );
    log("green", "crossfade", `hand-off complete: "${track.title}" is primary`);
  }

  private releaseStream() {
    this.releaseActiveStream?.();
    this.releaseActiveStream = null;
  }

  private watchFullSource(trackId: string, stream: PlaybackStream) {
    const { completed, needsFullSource } = stream;
    if (!completed || !needsFullSource) return;
    void completed
      .then((blob) => {
        if (this.currentTrackId !== trackId || this.audio.src !== stream.url)
          return;
        if (needsFullSource()) this.swapToFullSource(blob);
      })
      .catch(() => undefined);
  }

  private swapToFullSource(blob: Blob) {
    const position = this.audio.currentTime;
    const wasPlaying = !this.audio.paused;
    const url = URL.createObjectURL(blob);
    this.isResetting = true;
    this.releaseStream();
    if (this.activeBlobUrl) URL.revokeObjectURL(this.activeBlobUrl);
    this.activeBlobUrl = url;
    this.audio.src = url;
    this.attachedFromLiner = false;
    this.applyPlaybackRateAndPitch();
    const settle = () => {
      this.isResetting = false;
    };
    this.audio.addEventListener(
      "loadedmetadata",
      () => {
        this.audio.currentTime = position;
        if (wasPlaying) void this.audio.play().then(settle, settle);
        else settle();
      },
      { once: true },
    );
    log("cyan", "playback", "switched to the fully downloaded source");
  }

  private safeResetAudioElement() {
    this.isResetting = true;
    this.currentSessionExpiresAt = null;
    try {
      this.cancelFade();
      this.audio.pause();
      this.releaseStream();
      if (this.activeBlobUrl) {
        URL.revokeObjectURL(this.activeBlobUrl);
        this.activeBlobUrl = null;
      }
      this.audio.removeAttribute("src");
      this.audio.load();
      this.attachedTrackId = null;
    } catch {
    } finally {
      this.isResetting = false;
    }
  }

  // between tracks: silence the old source but keep it attached until the next one
  // is ready. Emptying the element here made Chromium drop the system media session
  // during every skip, so Windows controls / FluentFlyout lost Liner after a track change.
  private pauseForTransition() {
    this.isResetting = true;
    this.currentSessionExpiresAt = null;
    try {
      this.cancelFade();
      this.audio.pause();
    } catch {
    } finally {
      this.isResetting = false;
    }
  }

  private attachSource(url: string, isBlob: boolean, trackId: string) {
    const previousBlob = this.activeBlobUrl;
    this.audio.src = url;
    this.activeBlobUrl = isBlob ? url : null;
    this.attachedTrackId = trackId;
    this.attachedFromLiner = false;
    if (previousBlob && previousBlob !== url) URL.revokeObjectURL(previousBlob);
  }

  public cancelPendingLoad(): void {
    this.loadEpoch += 1;
    this.cancelCrossfade(false);
    this.clearSongFade();
    this.loadAbortController?.abort();
    this.loadAbortController = null;
    this.backgroundCacheAbortController?.abort();
    this.backgroundCacheAbortController = null;
    this.currentTrackId = null;
    this.currentSessionExpiresAt = null;
    this.recoveryAttempts = 0;
    this.recoveryHoldUntilMs = null;
    this.safeResetAudioElement();
    usePlayerStore.getState().setStatus("paused");
    log("cyan", "playback", "pending load cancelled");
  }

  public async preloadTrack(track: Track): Promise<void> {
    if (isLocalTrackId(track.id) || isSavedTrack(track.id)) return;
    if (this.currentTrackId === track.id) return;
    if (this.preloadingTrackId === track.id) return;

    const cached = await linerDb.getAudio(track.id);
    if (cached) return;

    this.preloadAbortController?.abort();
    const controller = new AbortController();
    this.preloadAbortController = controller;
    this.preloadingTrackId = track.id;

    const generation = audioCache.currentGeneration();
    const promise = (async () => {
      try {
        const stream = await resolvePlaybackStream(track, controller.signal);
        if (controller.signal.aborted) return;

        const blob = await this.downloadAudioBlob(stream, controller.signal);
        if (!blob || controller.signal.aborted) return;
        if (
          !(await audioCache.saveAudioBlob(
            track.id,
            blob,
            blob.type,
            generation,
          ))
        )
          return;
        await linerDb.putTrack(track);
        log(
          "green",
          "preload",
          `preloaded audio: "${track.title}" (${Math.round(blob.size / 1024)} KB)`,
        );
      } catch {
      } finally {
        if (this.preloadingTrackId === track.id) {
          this.preloadingTrackId = null;
          this.preloadingPromise = null;
          this.preloadAbortController = null;
        }
      }
    })();

    this.preloadingPromise = promise;
    await promise;
  }

  private pendingStartPositionMs = 0;

  public stop(): void {
    this.cancelPendingLoad();
    this.updateMediaSessionMetadata(null);
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.playbackState = "none";
      } catch {}
    }
  }

  public setPendingSeek(positionMs: number): void {
    this.pendingStartPositionMs = positionMs;
    usePlayerStore.getState().setPosition(positionMs);
    if (this.audio.src && this.audio.src !== window.location.href) {
      try {
        if (this.audio.readyState >= 1) {
          this.audio.currentTime = positionMs / 1000;
        } else {
          this.audio.addEventListener(
            "loadedmetadata",
            () => {
              try {
                this.audio.currentTime = positionMs / 1000;
              } catch {}
            },
            { once: true },
          );
        }
      } catch {}
    }
  }

  public async loadAndPlay(
    track: Track,
    startPositionMs: number = 0,
    bypassCache: boolean = false,
  ) {
    // Crossfade hand-off: the engine advanced to the very track that
    // is already sounding on the standby element — promote it instead
    // of loading it again. Any other load (a different track, a seeked
    // or recovery reload, a load for a not-yet-sounding incoming) ends
    // the overlap and proceeds exactly as before.
    const cf = this.crossfade;
    if (cf) {
      if (
        cf.phase === "overlapping" &&
        cf.incomingTrack.id === track.id &&
        startPositionMs <= 0 &&
        !bypassCache
      ) {
        this.promoteCrossfade(track);
        return;
      }
      this.cancelCrossfade(false);
    }
    this.cancelFade();
    this.pendingStartPositionMs = startPositionMs;
    const epoch = ++this.loadEpoch;

    // A song fade-out on the previous track lends this load its fade-in
    // duration — but only when a different track is loading (a
    // repeat-one reload keeps the standard short fade).
    const startFadeMs =
      this.pendingFadeInMs !== null && this.songFadeTrackId !== track.id
        ? this.pendingFadeInMs
        : null;
    this.clearSongFade();

    if (this.currentTrackId !== track.id) {
      this.recoveryAttempts = 0;
      this.recoveryHoldUntilMs = null;
    }

    if (this.preloadingTrackId === track.id && this.preloadingPromise) {
      // Wait for the background preload only briefly: it downloads the
      // whole file, and a slow or stalled download must not hold the
      // next song hostage (Note 24). The preload keeps running and may
      // still serve a later play from the cache.
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          this.preloadingPromise,
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, PRELOAD_WAIT_GRACE_MS);
          }),
        ]);
      } finally {
        if (graceTimer !== null) clearTimeout(graceTimer);
      }
    } else if (this.preloadingTrackId && this.preloadingTrackId !== track.id) {
      this.preloadAbortController?.abort();
      this.preloadAbortController = null;
      this.preloadingTrackId = null;
      this.preloadingPromise = null;
    }

    this.loadAbortController?.abort();
    const controller = new AbortController();
    this.loadAbortController = controller;

    this.backgroundCacheAbortController?.abort();
    const bgCacheController = new AbortController();
    this.backgroundCacheAbortController = bgCacheController;

    const store = usePlayerStore.getState();
    if (!store.keepSpeedAcrossTracks && this.currentTrackId !== track.id) {
      store.resetSpeedAndPitch();
    }
    this.currentTrackId = track.id;
    this.loadStartTime = performance.now();
    this.updateMediaSessionMetadata(track);

    store.setStatus("loading", null);
    store.setPosition(startPositionMs > 0 ? startPositionMs : 0);

    this.pauseForTransition();

    try {
      const cachedAudio =
        bypassCache || isSavedTrack(track.id)
          ? null
          : await linerDb.getAudio(track.id);
      if (epoch !== this.loadEpoch || controller.signal.aborted) {
        return;
      }

      const isValidCachedBlob =
        Boolean(cachedAudio?.blob) &&
        cachedAudio!.blob.size > 0 &&
        (!cachedAudio!.blob.type ||
          cachedAudio!.blob.type.startsWith("audio/"));

      if (cachedAudio && !isValidCachedBlob) {
        void linerDb.deleteAudio(track.id);
        audioCache.deleteAudio(track.id);
      }

      if (cachedAudio && isValidCachedBlob) {
        this.currentSessionExpiresAt = null;
        void linerDb.putTrack(track);
        const blobUrl = URL.createObjectURL(cachedAudio.blob);
        this.attachSource(blobUrl, true, track.id);
        this.audio.volume = 0;
        this.audio.load();
        this.applyPlaybackRateAndPitch();

        const targetPosition =
          this.pendingStartPositionMs > 0
            ? this.pendingStartPositionMs
            : startPositionMs;
        this.seekWhenReady(epoch, targetPosition);
        log(
          "cyan",
          "playback",
          `audio cache hit for "${track.title}" (${Math.round(cachedAudio.byteSize / 1024)} KB)`,
        );

        if (this.audio.readyState < 3) {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 3000);
            const onCanPlay = () => {
              clearTimeout(timeout);
              this.audio.removeEventListener("canplay", onCanPlay);
              this.audio.removeEventListener("error", onCanPlay);
              resolve();
            };
            this.audio.addEventListener("canplay", onCanPlay, { once: true });
            this.audio.addEventListener("error", onCanPlay, { once: true });
          });
        }

        if (epoch !== this.loadEpoch || controller.signal.aborted) return;

        const playPromise = this.audio.play();
        this.activePlayPromise = playPromise;
        await playPromise;

        const audioStartLatencyMs = Math.round(
          performance.now() - this.loadStartTime,
        );

        if (epoch === this.loadEpoch) {
          usePlayerStore.getState().setStatus("playing");
          this.fadeVolume(usePlayerStore.getState().volume, startFadeMs ?? 180);
        }
        logNowPlaying(track, true, audioStartLatencyMs);
        return;
      }

      const stream = await resolvePlaybackStream(track, controller.signal, {
        progressive: true,
      });
      this.ttfbMs = Math.round(performance.now() - this.loadStartTime);

      if (epoch !== this.loadEpoch || controller.signal.aborted) {
        stream.release?.();
        log(
          "yellow",
          "playback",
          `superseded before stream ready (${track.title})`,
        );
        return;
      }

      const streamCodec = stream.codec;
      const streamBitrate = stream.bitrate;
      this.currentSessionExpiresAt = stream.expiresAtMs;
      log("cyan", "playback", `resolved stream for ${track.title}`);
      this.releaseStream();
      const url = stream.blob ? URL.createObjectURL(stream.blob) : stream.url;
      this.attachSource(url, Boolean(stream.blob), track.id);
      this.attachedFromLiner = Boolean(stream.fromLiner);
      this.releaseActiveStream = stream.release ?? null;
      this.watchFullSource(track.id, stream);
      this.audio.volume = 0;
      this.audio.load();
      this.applyPlaybackRateAndPitch();

      const targetPosition =
        this.pendingStartPositionMs > 0
          ? this.pendingStartPositionMs
          : startPositionMs;
      this.seekWhenReady(epoch, targetPosition);
      log(
        "green",
        "playback",
        `stream attached: ${streamCodec} ${streamBitrate} bps (${track.title})`,
      );

      if (this.audio.readyState < 3) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 3000);
          const onCanPlay = () => {
            clearTimeout(timeout);
            this.audio.removeEventListener("canplay", onCanPlay);
            this.audio.removeEventListener("error", onCanPlay);
            resolve();
          };
          this.audio.addEventListener("canplay", onCanPlay, { once: true });
          this.audio.addEventListener("error", onCanPlay, { once: true });
        });
      }

      if (epoch !== this.loadEpoch || controller.signal.aborted) return;

      const playPromise = this.audio.play();
      this.activePlayPromise = playPromise;
      await playPromise;

      const audioStartLatencyMs = Math.round(
        performance.now() - this.loadStartTime,
      );

      if (epoch === this.loadEpoch) {
        usePlayerStore.getState().setStatus("playing");
        this.fadeVolume(usePlayerStore.getState().volume, startFadeMs ?? 180);
        this.cacheAudioInBackground(track, stream, bgCacheController.signal);
      }
      logNowPlaying(track, false, audioStartLatencyMs);

      telemetry.trackPlaybackHealth("INIT_LATENCY", {
        trackId: track.id,
        codec: streamCodec,
        bitrate: streamBitrate,
        timeToFirstByteMs: this.ttfbMs,
        audioStartLatencyMs,
      });
    } catch (error) {
      if (epoch !== this.loadEpoch || controller.signal.aborted) {
        return;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      if (error instanceof DOMException && error.name === "NotAllowedError") {
        log(
          "yellow",
          "playback",
          "autoplay blocked — waiting for user gesture",
        );
        usePlayerStore.getState().setStatus("paused");
        return;
      }

      if (
        isBotCheckError(error) &&
        !isYoutubeSignedIn() &&
        !isYoutubeSignInDeclined() &&
        prefersSignInPrompt()
      ) {
        log("yellow", "playback", "youtube sign-in required, pausing");
        usePlayerStore.getState().setStatus("paused");
        requestYoutubeSignIn();
        return;
      }

      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Playback failed to start.";
      console.error("[LoadAndPlayError]", track.id, error);
      log("red", "playback", `failed: ${message}`);
      usePlayerStore.getState().setStatus("error", message);

      telemetry
        .reportError(error, {
          action: "playback_failed",
          trackId: track.id,
          title: track.title,
        })
        .catch(() => {});

      this.onError?.({ trackId: track.id, message });
    } finally {
      if (epoch === this.loadEpoch) {
        this.activePlayPromise = null;
      }
    }
  }

  private seekWhenReady(epoch: number, positionMs: number) {
    if (positionMs <= 0) return;
    const apply = () => {
      if (epoch !== this.loadEpoch) return;
      try {
        this.audio.currentTime = positionMs / 1000;
      } catch {
        // Media not seekable yet — ignore
      }
    };
    if (this.audio.readyState >= 1) {
      apply();
    } else {
      this.audio.addEventListener("loadedmetadata", apply, { once: true });
    }
  }

  public pause() {
    const epoch = ++this.loadEpoch;
    this.loadAbortController?.abort();
    this.loadAbortController = null;
    // Pause coherence: a pause ends any overlap — the standby is
    // silenced and released with the crossfade, and this fade-out
    // starts from whatever level the ramp had reached. The outgoing's
    // position freezes mid-window, so a resume inside the window
    // simply re-arms a fresh crossfade from the frozen point.
    this.cancelCrossfade(false);
    usePlayerStore.getState().setStatus("paused");
    log("cyan", "audio", "pause requested (fading out)");

    this.fadeVolume(0, 180, () => {
      if (epoch !== this.loadEpoch) return;
      this.audio.pause();
    });
  }

  public resume() {
    const epoch = ++this.loadEpoch;
    this.loadAbortController?.abort();
    this.loadAbortController = null;

    const targetVolume = usePlayerStore.getState().volume;
    usePlayerStore.getState().setStatus("playing");
    pitchShifter.resumeContext();
    this.applyPlaybackRateAndPitch();
    log("cyan", "audio", "resume requested (fading in)");

    const currentTrack = usePlayerStore.getState().currentTrack;
    const isExpired =
      this.currentSessionExpiresAt !== null &&
      Date.now() >= this.currentSessionExpiresAt - 15_000;
    const hasMediaError = Boolean(this.audio.error);
    const hasValidSource =
      Boolean(this.audio.src) &&
      this.audio.src !== window.location.href &&
      !isExpired &&
      !hasMediaError;

    if (!hasValidSource && currentTrack) {
      void this.loadAndPlay(currentTrack, usePlayerStore.getState().positionMs);
      return;
    }

    if (this.audio.paused) {
      this.audio.volume = 0;
      const playPromise = this.audio.play();
      this.activePlayPromise = playPromise;
      playPromise
        .then(() => {
          if (epoch !== this.loadEpoch) return;
          this.fadeVolume(targetVolume, 180);
        })
        .catch((error) => {
          if (epoch !== this.loadEpoch) return;
          if (error.name === "NotAllowedError") {
            log("yellow", "audio", "play blocked — waiting for user gesture");
            usePlayerStore.getState().setStatus("paused");
          } else if (error.name !== "AbortError") {
            log("red", "audio", `play failed: ${String(error)}`);
            if (currentTrack && this.recoveryAttempts < 1) {
              this.recoveryAttempts++;
              log(
                "yellow",
                "playback",
                "resume failed — attempting cache/stream recovery",
              );
              void this.loadAndPlay(
                currentTrack,
                usePlayerStore.getState().positionMs,
                true,
              );
              return;
            }
            usePlayerStore.getState().setStatus("paused");
          }
        })
        .finally(() => {
          if (epoch === this.loadEpoch) this.activePlayPromise = null;
        });
    } else {
      this.fadeVolume(targetVolume, 180);
    }
  }

  public seek(positionMs: number) {
    // A seek during the window cancels the crossfade cleanly: the
    // incoming is released and the outgoing's level restored before
    // the playhead moves, so the listener hears one track again.
    if (this.crossfade) this.cancelCrossfade(true);
    if (!this.audio.src || this.audio.src === window.location.href) return;
    try {
      if (this.audio.readyState >= 1) {
        this.audio.currentTime = positionMs / 1000;
      } else {
        this.audio.addEventListener(
          "loadedmetadata",
          () => {
            try {
              this.audio.currentTime = positionMs / 1000;
            } catch {}
          },
          { once: true },
        );
      }
    } catch {
      // Ignore seek error if media not yet ready
    }
  }

  private async downloadAudioBlob(
    stream: PlaybackStream,
    signal: AbortSignal,
  ): Promise<Blob | null> {
    if (stream.blob) return stream.blob;
    if (stream.completed) return stream.completed;
    const startedAt = performance.now();
    let bytes: Uint8Array<ArrayBuffer> | null;
    try {
      bytes = await downloadAudioBytes(stream.url, {
        contentLength: stream.contentLength,
        signal,
      });
    } catch (error) {
      if (stream.fromLiner && !signal.aborted)
        markLinerStreamFailed(`download: ${String(error)}`);
      throw error;
    }
    if (!bytes || signal.aborted) return null;
    const mimeType = stream.mimeType || "audio/webm";
    if (!mimeType.startsWith("audio/") && !mimeType.startsWith("video/"))
      return null;
    if (!isStandaloneAudioFile(bytes.subarray(0, 16))) {
      log(
        "yellow",
        "download",
        `not caching: stream is not a standalone audio file`,
      );
      return null;
    }
    log(
      "cyan",
      "download",
      `${Math.round(bytes.byteLength / 1024)} KB in ${Math.round(performance.now() - startedAt)}ms (${stream.contentLength ? "chunked" : "single request"})`,
    );
    return new Blob([bytes], { type: mimeType });
  }

  private cacheAudioInBackground(
    track: Track,
    stream: PlaybackStream,
    signal: AbortSignal,
  ) {
    if (isLocalTrackId(track.id) || isSavedTrack(track.id)) return;
    if (track.durationMs && track.durationMs > 20 * 60 * 1000) return;
    const generation = audioCache.currentGeneration();
    void (async () => {
      try {
        const blob = await this.downloadAudioBlob(stream, signal);
        if (!blob || signal.aborted) return;
        if (
          !(await audioCache.saveAudioBlob(
            track.id,
            blob,
            blob.type,
            generation,
          ))
        )
          return;
        await linerDb.putTrack(track);
        log(
          "green",
          "playback",
          `background cached: ${track.title} (${Math.round(blob.size / 1024)} KB)`,
        );
      } catch {}
    })();
  }
}

export const playerRuntime =
  typeof window !== "undefined" ? new PlayerRuntime() : null;
