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

export class TwoDeckMixer {
  readonly master: GainNode;
  private readonly decks: [Deck, Deck];
  private current = 0;

  constructor(private readonly context: AudioContext) {
    this.master = context.createGain();
    this.master.gain.value = 1;
    this.master.connect(context.destination);
    this.decks = [
      new Deck(context, this.master),
      new Deck(context, this.master),
    ];
  }

  /** The deck currently playing (or next to play). */
  get currentDeck(): Deck {
    return this.decks[this.current];
  }

  /** The idle deck, waiting for the next track. */
  get nextDeck(): Deck {
    return this.decks[1 - this.current];
  }

  /** Starts a track on the current deck, full volume, natural tempo. */
  playNow(buffer: AudioBuffer, offsetSec = 0): void {
    const deck = this.currentDeck;
    deck.load(buffer);
    const now = this.context.currentTime;
    deck.gain.gain.setValueAtTime(1, now);
    deck.bass.gain.setValueAtTime(BASS_FLAT_DB, now);
    deck.play(now + SCHEDULE_AHEAD_SEC, offsetSec, 1);
  }

  /**
   * Performs a planned transition into a new track on the idle deck.
   * The plan's times are relative to the moment it was made; this call
   * anchors them to the audio clock.
   */
  transitionTo(nextBuffer: AudioBuffer, plan: TransitionPlan): void {
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
  }
}
