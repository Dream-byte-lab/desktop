// One deck: a single track's worth of Web Audio machinery — a buffer
// source running through its own bass control and its own volume, so two
// decks can be faded, EQ'd and tempo-shifted completely independently.
// The mixer drives the deck's automation parameters; the deck itself
// knows nothing about beats or plans.

export const BASS_CUT_DB = -32;
export const BASS_FLAT_DB = 0;

export class Deck {
  /** Volume of this deck; the mixer writes fade curves onto it. */
  readonly gain: GainNode;
  /** Low-shelf gain in dB; the mixer writes the bass swap onto it. */
  readonly bass: BiquadFilterNode;

  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  constructor(
    private readonly context: AudioContext,
    destination: AudioNode,
  ) {
    this.bass = context.createBiquadFilter();
    this.bass.type = "lowshelf";
    this.bass.frequency.value = 160;
    this.bass.gain.value = BASS_FLAT_DB;

    this.gain = context.createGain();
    this.gain.gain.value = 0;

    this.bass.connect(this.gain);
    this.gain.connect(destination);
  }

  load(buffer: AudioBuffer): void {
    this.buffer = buffer;
  }

  get loaded(): boolean {
    return this.buffer !== null;
  }

  /**
   * Starts the loaded track at a wall-clock time, from a track position,
   * at a playback rate. Any previous playback on this deck is stopped.
   */
  play(when: number, offsetSec: number, rate = 1): void {
    if (!this.buffer) return;
    this.stopSource();
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = rate;
    source.connect(this.bass);
    source.start(when, Math.max(0, offsetSec));
    this.source = source;
  }

  /** The live playback-rate control of the playing source, if any. */
  get rateControl(): AudioParam | null {
    return this.source ? this.source.playbackRate : null;
  }

  stop(when?: number): void {
    if (!this.source) return;
    try {
      this.source.stop(when ?? this.context.currentTime);
    } catch {
      // already stopped — nothing to do
    }
    this.source = null;
  }

  private stopSource(): void {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch {
      // already stopped — nothing to do
    }
    this.source.disconnect();
    this.source = null;
  }
}
