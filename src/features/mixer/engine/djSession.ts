import type { Track } from "@/shared/types";
import { usePlayerStore } from "../../player/store/playerStore";
import { chooseEntryBeat } from "./entryBeat";
import { loadTrackForMixing, type PreparedTrack } from "./trackSource";
import { planTransition, type TransitionPlan } from "./transitionPlanner";
import { TwoDeckMixer } from "./twoDeckMixer";

// The DJ session: a whole queue played on the two decks, blended
// automatically. It is a guest in Liner's house, and behaves like one:
//
// - the normal player is paused through its own command channel before
//   the session makes any sound;
// - everything the interface shows — current track, queue, position,
//   duration, playing/paused — is written into the player's own store
//   through its public setters, so the existing UI simply follows;
// - tracks are prepared (downloaded, decoded, analysed) one ahead of
//   the playing track; when the next track is ready, a transition is
//   planned against the live position and scheduled on the audio clock;
// - a track that cannot be prepared, or a pair with no honest blend,
//   falls back to a plain cut at the end of the current track instead
//   of stalling the session.
//
// Positions are tracked as rate segments against the audio clock, so
// pausing (which freezes the clock) freezes the position for free.

interface RateSegment {
  fromCtxTime: number;
  trackTimeAtStart: number;
  rate: number;
}

const TICK_MS = 250;
/** Start planning a transition once the current track has less than this left. */
const PLAN_WHEN_REMAINING_SEC = 150;

export class DjSession {
  private context: AudioContext | null = null;
  private mixer: TwoDeckMixer | null = null;
  private queue: Track[] = [];
  private index = -1;
  private current: PreparedTrack | null = null;
  private next: PreparedTrack | null = null;
  private segments: RateSegment[] = [];
  private ticker: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private transitionPlanned = false;
  private lastVolume = -1;

  /** Notified whenever the session starts or stops, for UI state. */
  onRunningChange: ((running: boolean) => void) | null = null;

  get isRunning(): boolean {
    return this.mixer !== null;
  }

  get isPaused(): boolean {
    return this.context?.state === "suspended";
  }

  async start(queue: Track[], startIndex = 0): Promise<void> {
    this.stop();
    if (queue.length === 0 || startIndex >= queue.length) return;

    // Ask the normal player to be quiet before the decks make a sound.
    usePlayerStore.getState().dispatch({ type: "PAUSE_REQUESTED" });

    this.context = new AudioContext();
    this.mixer = new TwoDeckMixer(this.context);
    this.queue = queue;
    const store = usePlayerStore.getState();
    store.setQueue(queue);
    store.setStatus("loading", null);

    const first = await loadTrackForMixing(queue[startIndex]);
    if (!first || !this.mixer) {
      store.setStatus("error", "That track could not be prepared for mixing.");
      this.stop();
      return;
    }
    this.beginTrack(first, startIndex);
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

  /** Cuts straight to the next track, abandoning any planned blend. */
  skipNext(): void {
    if (!this.mixer || !this.current) return;
    if (this.next) {
      const next = this.next;
      this.clearTimers();
      this.mixer.stopAll();
      this.beginTrack(next, this.index + 1);
      return;
    }
    const nextTrack = this.queue[this.index + 1];
    if (!nextTrack) return;
    void loadTrackForMixing(nextTrack).then((prepared) => {
      if (!prepared || !this.mixer) return;
      this.clearTimers();
      this.mixer.stopAll();
      this.beginTrack(prepared, this.index + 1);
    });
  }

  /**
   * Back to the previous track — or, as players conventionally do,
   * back to the start of the current one when it has barely begun or
   * there is no previous track.
   */
  skipPrevious(): void {
    if (!this.mixer || !this.current) return;
    if (this.index <= 0 || this.positionNow() > 3) {
      this.restartCurrent();
      return;
    }
    const previousTrack = this.queue[this.index - 1];
    void loadTrackForMixing(previousTrack).then((prepared) => {
      if (!prepared || !this.mixer) return;
      this.clearTimers();
      this.mixer.stopAll();
      this.beginTrack(prepared, this.index - 1);
    });
  }

  /** Restarts the current track from the beginning. */
  restartCurrent(): void {
    if (!this.mixer || !this.current) return;
    this.clearTimers();
    this.mixer.stopAll();
    this.beginTrack(this.current, this.index);
  }

  /**
   * Jumps to a position inside the current track. Any planned or
   * in-progress blend is abandoned; planning resumes from the new
   * position on the next tick.
   */
  seekTo(positionMs: number): void {
    if (!this.mixer || !this.context || !this.current) return;
    const duration = this.current.buffer.duration;
    const target = Math.min(Math.max(0, positionMs / 1000), duration - 0.1);
    this.clearTimers();
    this.transitionPlanned = false;
    this.mixer.stopAll();
    const startAt = this.mixer.playNow(this.current.buffer, target);
    this.segments = [
      { fromCtxTime: startAt, trackTimeAtStart: target, rate: 1 },
    ];
    usePlayerStore.getState().setPosition(Math.round(target * 1000));
  }

  stop(): void {
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
    this.queue = [];
    this.index = -1;
    this.current = null;
    this.next = null;
    this.segments = [];
    this.transitionPlanned = false;
    this.onRunningChange?.(false);
  }

  private beginTrack(prepared: PreparedTrack, index: number): void {
    if (!this.mixer || !this.context) return;
    this.current = prepared;
    this.next = null;
    this.index = index;
    this.transitionPlanned = false;

    const startAt = this.mixer.playNow(prepared.buffer, 0);
    this.segments = [{ fromCtxTime: startAt, trackTimeAtStart: 0, rate: 1 }];

    const store = usePlayerStore.getState();
    store.setCurrentTrack(prepared.track, index);
    store.setDuration(
      prepared.track.durationMs ?? Math.round(prepared.buffer.duration * 1000),
    );
    store.setPosition(0);
    store.setStatus("playing");

    void this.prepareNext();
  }

  private async prepareNext(): Promise<void> {
    const nextTrack = this.queue[this.index + 1];
    if (!nextTrack) {
      this.next = null;
      return;
    }
    const prepared = await loadTrackForMixing(nextTrack);
    // The session may have moved on while this was downloading.
    if (!prepared || this.queue[this.index + 1]?.id !== nextTrack.id) return;
    this.next = prepared;
  }

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

  private tick(): void {
    if (!this.current || !this.context) return;
    const store = usePlayerStore.getState();

    if (store.volume !== this.lastVolume && this.mixer) {
      this.lastVolume = store.volume;
      this.mixer.master.gain.value = store.volume;
    }

    const position = this.positionNow();
    store.setPosition(Math.max(0, Math.round(position * 1000)));
    const duration = this.current.buffer.duration;
    const remaining = duration - position;

    if (remaining <= 0.05) {
      if (this.next) {
        this.skipNext();
      } else {
        store.setStatus("idle");
        this.stop();
      }
      return;
    }

    if (this.transitionPlanned || !this.next) return;
    if (remaining > PLAN_WHEN_REMAINING_SEC) return;

    const plan = planTransition({
      outgoing: this.current.analysis.beatMap,
      outgoingPositionSec: position,
      incoming: this.next.analysis.beatMap,
      incomingEntryBeat: chooseEntryBeat(this.next.analysis),
      outgoingKey: this.current.analysis.key,
      incomingKey: this.next.analysis.key,
    });
    this.transitionPlanned = true;
    if (plan) {
      this.after(plan.startsInSec * 1000, () => this.executeTransition(plan));
    } else {
      // No honest blend from here: cut at the end of the track.
      this.after(Math.max(0, remaining * 1000 - 50), () => this.skipNext());
    }
  }

  private executeTransition(plan: TransitionPlan): void {
    if (!this.mixer || !this.next || !this.context) return;
    const incoming = this.next;
    const times = this.mixer.transitionTo(incoming.buffer, plan);

    const blendSpan = plan.blendDurationSec * plan.incomingRate;
    const entryTrackTime = plan.incomingStartSec + blendSpan;
    const glideEnd = times.blendEndCtxTime + plan.rateReturnDurationSec;
    const glideSpan =
      plan.rateReturnDurationSec * ((plan.incomingRate + 1) / 2);
    const pendingSegments: RateSegment[] = [
      {
        fromCtxTime: times.blendStartCtxTime,
        trackTimeAtStart: plan.incomingStartSec,
        rate: plan.incomingRate,
      },
      {
        fromCtxTime: times.blendEndCtxTime,
        trackTimeAtStart: entryTrackTime,
        rate: (plan.incomingRate + 1) / 2,
      },
      {
        fromCtxTime: glideEnd,
        trackTimeAtStart: entryTrackTime + glideSpan,
        rate: 1,
      },
    ];

    this.after(plan.blendDurationSec * 1000, () => {
      this.segments = pendingSegments;
      this.current = incoming;
      this.next = null;
      this.index += 1;
      this.transitionPlanned = false;
      const store = usePlayerStore.getState();
      store.setCurrentTrack(incoming.track, this.index);
      store.setDuration(
        incoming.track.durationMs ??
          Math.round(incoming.buffer.duration * 1000),
      );
      void this.prepareNext();
    });
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
