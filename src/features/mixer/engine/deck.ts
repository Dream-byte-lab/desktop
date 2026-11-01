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
  /**
   * A second low-shelf the automation never touches — the manual bass
   * control (the Pro layer's bass kill / trim). It sits in series with
   * the automated shelf, so a hand on it can never fight a blend.
   */
  readonly bassTrim: BiquadFilterNode;
  /**
   * Post-fader send into the mixer's shared echo network, for
   * echo-outs. Normally 0 (silent); the mixer raises it for the last
   * moments of a track that is leaving without a blend.
   */
  readonly echoSend: GainNode;

  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  constructor(
    private readonly context: AudioContext,
    destination: AudioNode,
    echoInput?: AudioNode,
  ) {
    this.bass = context.createBiquadFilter();
    this.bass.type = "lowshelf";
    this.bass.frequency.value = 160;
    this.bass.gain.value = BASS_FLAT_DB;

    this.bassTrim = context.createBiquadFilter();
    this.bassTrim.type = "lowshelf";
    this.bassTrim.frequency.value = 160;
    this.bassTrim.gain.value = BASS_FLAT_DB;

    this.gain = context.createGain();
    this.gain.gain.value = 0;

    this.echoSend = context.createGain();
    this.echoSend.gain.value = 0;

    this.bass.connect(this.bassTrim);
    this.bassTrim.connect(this.gain);
    this.gain.connect(destination);
    if (echoInput) {
      this.gain.connect(this.echoSend);
      this.echoSend.connect(echoInput);
    }
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
