import { BASS_CUT_DB, BASS_FLAT_DB, Deck } from "./deck";
import type { TransitionPlan } from "./transitionPlanner";

// Two decks and a master volume: the smallest honest DJ mixer. One deck
// plays; a planned transition starts the other deck tempo-matched and
// phrase-aligned, overlaps the two with an equal-power blend (so the
// room never hears a volume dip in the middle), swaps the bass from the
// old track to the new one on a bar boundary, ends the old track exactly
// as the new track's entry beat lands, and then glides the new track back
// to its natural tempo.
//
// This engine is deliberately standalone: it plays decoded audio buffers
// and knows nothing about Liner's player, queues or sources yet. Wiring
// it into the player is a separate, later step.

const CURVE_POINTS = 64;
/** Safety gap between "now" and the earliest scheduled event, in seconds. */
const SCHEDULE_AHEAD_SEC = 0.1;

function equalPowerCurves(): { outCurve: Float32Array; inCurve: Float32Array } {
  const outCurve = new Float32Array(CURVE_POINTS);
  const inCurve = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i += 1) {
    const t = i / (CURVE_POINTS - 1);
    outCurve[i] = Math.cos((t * Math.PI) / 2);
    inCurve[i] = Math.sin((t * Math.PI) / 2);
  }
  return { outCurve, inCurve };
}

/**
 * Crossfader gains for a position in -1..1. This crossfader is a lean
 * control layered over the automation, not the primary fader, so the
 * centre is transparent (both decks at full) — an untouched crossfader
 * must never change what the automatic blends sound like. Moving it
 * fades the opposite deck out along a cosine curve.
 */
export function crossfadeGains(position: number): [number, number] {
  const p = Math.min(1, Math.max(-1, position));
  const deck1 = p <= 0 ? 1 : Math.cos((p * Math.PI) / 2);
  const deck2 = p >= 0 ? 1 : Math.cos((-p * Math.PI) / 2);
  return [deck1, deck2];
}

export type DeckIndex = 0 | 1;

/**
 * The echo's delay time for a tempo: a dotted eighth note (¾ of a
 * beat) — the classic echo-out spacing — clamped to a sane range.
 */
export function echoDelaySec(bpm: number): number {
  if (bpm <= 0) return 0.3;
  return Math.min(1.2, Math.max(0.08, 0.75 * (60 / bpm)));
}

export class TwoDeckMixer {
  readonly master: GainNode;
  private readonly decks: [Deck, Deck];
  private readonly trims: [GainNode, GainNode];
  private readonly echoDelay: DelayNode;
  private current = 0;
  private crossfadePosition = 0;
  private readonly deckTrimLevels: [number, number] = [1, 1];

  constructor(private readonly context: AudioContext) {
    this.master = context.createGain();
    this.master.gain.value = 1;
    this.master.connect(context.destination);

    // The shared echo network: a feedback delay with a low-pass in
    // the loop, so each repeat comes back darker and softer than the
    // last and the tail dissolves instead of ringing forever. Both
    // decks can send into it (post-fader); the wet signal returns
    // straight to the master, so a tail keeps sounding across a deck
    // change — which is exactly what an echo-out needs.
    this.echoDelay = context.createDelay(2);
    this.echoDelay.delayTime.value = 0.3;
    const echoFilter = context.createBiquadFilter();
    echoFilter.type = "lowpass";
    echoFilter.frequency.value = 1200;
    const echoFeedback = context.createGain();
    echoFeedback.gain.value = 0.38;
    const echoWet = context.createGain();
    echoWet.gain.value = 0.55;
    this.echoDelay.connect(echoFilter);
    echoFilter.connect(echoFeedback);
    echoFeedback.connect(this.echoDelay);
    this.echoDelay.connect(echoWet);
    echoWet.connect(this.master);

    // The manual stage: each deck runs through its own trim gain before
    // the master. The automation writes the decks' own gains; hands
    // (the Pro layer) write these trims and the crossfader. Because the
    // two multiply rather than share one control, a hand on the mixer
    // can lean on a blend but can never corrupt its scheduling.
    this.trims = [context.createGain(), context.createGain()];
    for (const trim of this.trims) trim.connect(this.master);
    this.decks = [
      new Deck(context, this.trims[0], this.echoDelay),
      new Deck(context, this.trims[1], this.echoDelay),
    ];
  }

  /**
   * Opens the current deck's echo send, beat-synced to its tempo, for
   * about a second of capture; the delay network then rings the tail
   * out over whatever plays next. The send closes itself so later
   * tracks are never echoed by accident.
   */
  echoOutCurrent(bpm: number): void {
    const now = this.context.currentTime;
    this.echoDelay.delayTime.setValueAtTime(echoDelaySec(bpm), now);
    const send = this.currentDeck.echoSend.gain;
    send.cancelScheduledValues(now);
    send.setTargetAtTime(0.9, now, 0.03);
    send.setTargetAtTime(0, now + 0.9, 0.1);
  }

  /** Which physical deck currently holds the playing track. */
  get currentDeckIndex(): DeckIndex {
    return this.current as DeckIndex;
  }

  /** Manual crossfader, -1 (deck 1 only) .. 1 (deck 2 only). */
  setCrossfade(position: number): void {
    this.crossfadePosition = Math.min(1, Math.max(-1, position));
    this.applyManualStage();
  }

  /** Manual per-deck volume trim, 0..1.25. */
  setDeckTrim(index: DeckIndex, level: number): void {
    this.deckTrimLevels[index] = Math.min(1.25, Math.max(0, level));
    this.applyManualStage();
  }

  /** Manual bass kill for one physical deck. */
  setDeckBassCut(index: DeckIndex, cut: boolean): void {
    this.decks[index].bassTrim.gain.setValueAtTime(
      cut ? BASS_CUT_DB : BASS_FLAT_DB,
      this.context.currentTime,
    );
  }

  private applyManualStage(): void {
    const [a, b] = crossfadeGains(this.crossfadePosition);
    const levels: [number, number] = [
      a * this.deckTrimLevels[0],
      b * this.deckTrimLevels[1],
    ];
    for (let i = 0; i < 2; i += 1) {
      this.trims[i].gain.setTargetAtTime(
        levels[i],
        this.context.currentTime,
        0.03,
      );
    }
  }

  /** The deck currently playing (or next to play). */
  get currentDeck(): Deck {
    return this.decks[this.current];
  }

  /** The idle deck, waiting for the next track. */
  get nextDeck(): Deck {
    return this.decks[1 - this.current];
  }

  /**
   * Starts a track on the current deck, full volume, natural tempo.
   * Returns the audio-clock time at which it starts.
   */
  playNow(buffer: AudioBuffer, offsetSec = 0): number {
    const deck = this.currentDeck;
    deck.load(buffer);
    const now = this.context.currentTime;
    deck.gain.gain.setValueAtTime(1, now);
    deck.bass.gain.setValueAtTime(BASS_FLAT_DB, now);
    const startAt = now + SCHEDULE_AHEAD_SEC;
    deck.play(startAt, offsetSec, 1);
    return startAt;
  }

  /** Stops both decks and silences them. */
  stopAll(): void {
    const now = this.context.currentTime;
    for (const deck of this.decks) {
      deck.gain.gain.cancelScheduledValues(now);
      deck.gain.gain.setValueAtTime(0, now);
      deck.stop(now);
    }
  }

  /**
   * Performs a planned transition into a new track on the idle deck.
   * The plan's times are relative to the moment it was made; this call
   * anchors them to the audio clock and returns the anchored blend
   * start/end so callers can track positions against the same clock.
   */
  transitionTo(
    nextBuffer: AudioBuffer,
    plan: TransitionPlan,
  ): { blendStartCtxTime: number; blendEndCtxTime: number } {
    const outgoing = this.currentDeck;
    const incoming = this.nextDeck;
    incoming.load(nextBuffer);

    const blendStart =
      this.context.currentTime + Math.max(SCHEDULE_AHEAD_SEC, plan.startsInSec);
    const blendEnd = blendStart + plan.blendDurationSec;
    const swapAt = blendStart + (plan.bassSwapInSec - plan.startsInSec);
    const { outCurve, inCurve } = equalPowerCurves();

    // Incoming: silent until the blend, equal-power rise across it, bass
    // cut until the swap — the outgoing track owns the low end first.
    incoming.gain.gain.setValueAtTime(0, blendStart);
    incoming.gain.gain.setValueCurveAtTime(
      inCurve,
      blendStart,
      plan.blendDurationSec,
    );
    incoming.bass.gain.setValueAtTime(BASS_CUT_DB, blendStart);
    incoming.bass.gain.setValueAtTime(BASS_CUT_DB, swapAt);
    incoming.bass.gain.linearRampToValueAtTime(BASS_FLAT_DB, swapAt + 0.02);
    incoming.play(blendStart, plan.incomingStartSec, plan.incomingRate);

    // Outgoing: equal-power fall across the blend, bass handed over at
    // the swap, stopped the moment the blend ends.
    outgoing.gain.gain.setValueCurveAtTime(
      outCurve,
      blendStart,
      plan.blendDurationSec,
    );
    outgoing.bass.gain.setValueAtTime(BASS_FLAT_DB, blendStart);
    outgoing.bass.gain.setValueAtTime(BASS_FLAT_DB, swapAt);
    outgoing.bass.gain.linearRampToValueAtTime(BASS_CUT_DB, swapAt + 0.02);
    outgoing.stop(blendEnd + 0.05);

    // After the blend the incoming track is on its own: glide its tempo
    // back to natural over the following phrase.
    const rate = incoming.rateControl;
    if (rate && plan.incomingRate !== 1) {
      rate.setValueAtTime(plan.incomingRate, blendEnd);
      rate.linearRampToValueAtTime(1, blendEnd + plan.rateReturnDurationSec);
    }

    this.current = 1 - this.current;
    return { blendStartCtxTime: blendStart, blendEndCtxTime: blendEnd };
  }
}
