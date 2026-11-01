import type { Track } from "@/shared/types";
import { usePlayerStore } from "../../player/store/playerStore";
import { assembleSet, candidateFromAnalysis } from "./curatedSet";
import { levelGainFor } from "./levelMatch";
import { decideTransition } from "./transitionStyle";
import { recordListen } from "./tasteTracker";
import { loadTrackForMixing, type PreparedTrack } from "./trackSource";
import type { TransitionPlan } from "./transitionPlanner";
import { TwoDeckMixer, type DeckIndex } from "./twoDeckMixer";

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
  private blendingNow = false;
  private lastVolume = -1;

  /** Notified whenever the session starts or stops, for UI state. */
  onRunningChange: ((running: boolean) => void) | null = null;

  /** Notified when a blend starts sounding and when it completes. */
  onBlendChange: ((blending: boolean) => void) | null = null;

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

  /**
   * Reorders everything still to come into a curated set — the
   * remaining tracks get their own energy arc and compatible joins,
   * assembled from their analyses. The pool is only ever this queue,
   * so the owner's own selection (their Playlist Genre) is respected
   * by construction; the current track and anything already played
   * are untouched. Refused while a transition is planned or a blend
   * is sounding, because reordering under a live join is how joins
   * break. Returns whether the reorder happened.
   */
  async curateRemaining(): Promise<boolean> {
    if (!this.current || this.transitionPlanned || this.blendingNow) {
      return false;
    }
    const tail = this.queue.slice(this.index + 1);
    if (tail.length < 2) return false;

    const prepared: PreparedTrack[] = [];
    for (const track of tail) {
      const ready = await loadTrackForMixing(track);
      if (ready) prepared.push(ready);
    }
    // The session may have moved on while tracks were loading.
    if (!this.current || this.transitionPlanned || this.blendingNow) {
      return false;
    }
    if (prepared.length < 2) return false;

    const byId = new Map(prepared.map((item) => [item.track.id, item]));
    const order = assembleSet(
      prepared.map((item) =>
        candidateFromAnalysis(item.track.id, item.analysis),
      ),
    );
    const newTail = order
      .map((id) => byId.get(id)?.track)
      .filter((track) => track !== undefined);
    const unpreparable = tail.filter((track) => !byId.has(track.id));
    this.queue = [
      ...this.queue.slice(0, this.index + 1),
      ...newTail,
      ...unpreparable,
    ];
    usePlayerStore.getState().setQueue(this.queue);
    this.next = null;
    void this.prepareNext();
    return true;
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
    const startAt = this.mixer.playNow(
      this.current.buffer,
      target,
      levelGainFor(this.current.analysis.loudness),
    );
    this.segments = [
      { fromCtxTime: startAt, trackTimeAtStart: target, rate: 1 },
    ];
    usePlayerStore.getState().setPosition(Math.round(target * 1000));
  }

  stop(): void {
    if (this.current) this.reportOutgoing(false);
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
    this.blendingNow = false;
    this.onBlendChange?.(false);
    this.onRunningChange?.(false);
  }

  /**
   * Feeds the taste profile: the outgoing track leaves with the
   * fraction of it that was actually heard. Skips report themselves
   * through beginTrack, blends through the transition commit, and a
   * stopped session through stop().
   */
  private reportOutgoing(completed: boolean): void {
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
  }

  private beginTrack(
    prepared: PreparedTrack,
    index: number,
    offsetSec = 0,
  ): void {
    if (!this.mixer || !this.context) return;
    if (this.current && this.current.track.id !== prepared.track.id) {
      this.reportOutgoing(false);
    }
    this.current = prepared;
    this.next = null;
    this.index = index;
    this.transitionPlanned = false;
    this.blendingNow = false;
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

  /**
   * The drop-cut: the outgoing track ends and the incoming one starts
   * exactly at its drop, so the join lands with energy instead of
   * sagging through an intro the moment didn't want.
   */
  private cutToNextAtEntry(entrySec: number): void {
    if (!this.mixer || !this.next) return;
    const next = this.next;
    this.clearTimers();
    this.mixer.stopAll();
    this.beginTrack(next, this.index + 1, entrySec);
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

    // The style is chosen per pair, from the two tracks' own facts —
    // never one fixed formula.
    const decision = decideTransition({
      outgoing: this.current.analysis,
      outgoingPositionSec: position,
      incoming: this.next.analysis,
    });
    this.transitionPlanned = true;
    if (decision.kind === "blend") {
      const plan = decision.plan;
      this.after(plan.startsInSec * 1000, () => this.executeTransition(plan));
    } else if (decision.kind === "drop-cut") {
      this.after(Math.max(0, remaining * 1000 - 50), () =>
        this.cutToNextAtEntry(decision.entrySec),
      );
    } else if (decision.kind === "echo-out") {
      // Open the echo send for the outgoing track's last moments,
      // then hand over as usual; the tail rings over the next track.
      const bpm = this.current.analysis.beatMap.bpm;
      this.after(Math.max(0, remaining * 1000 - 500), () =>
        this.mixer?.echoOutCurrent(bpm),
      );
      this.after(Math.max(0, remaining * 1000 - 50), () => this.skipNext());
    } else {
      this.after(Math.max(0, remaining * 1000 - 50), () => this.skipNext());
    }
  }

  private executeTransition(plan: TransitionPlan): void {
    if (!this.mixer || !this.next || !this.context) return;
    const incoming = this.next;
    this.blendingNow = true;
    this.onBlendChange?.(true);
    const times = this.mixer.transitionTo(
      incoming.buffer,
      plan,
      levelGainFor(incoming.analysis.loudness),
    );

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
      this.reportOutgoing(true);
      this.segments = pendingSegments;
      this.current = incoming;
      this.next = null;
      this.index += 1;
      this.transitionPlanned = false;
      this.blendingNow = false;
      this.onBlendChange?.(false);
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
