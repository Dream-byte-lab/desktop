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
  /** Peaking band at 1 kHz; recipe EQ automation writes here. Neutral (0 dB) unless a recipe says otherwise. */
  readonly mid: BiquadFilterNode;
  /** High-shelf at 4 kHz; recipe EQ automation writes here. Neutral (0 dB) unless a recipe says otherwise. */
  readonly high: BiquadFilterNode;
  /** Lowpass; recipe filter automation writes its cutoff. Fully open (20 kHz) unless a recipe sweeps it. */
  readonly filter: BiquadFilterNode;
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
  /**
   * The scratch gate (the revamp's R2): a per-deck gain stage in
   * series just before the volume fader, resting at exactly 1
   * (transparent). Only scratch performance ever writes to it — the
   * fader-gated techniques (chirp, transformer, flare) chop the
   * deck's sound through here while the hand works the rate. It is
   * deliberately NOT the volume fader: the recipe's blend curves own
   * `gain`, and a gate fighting them for one parameter would corrupt
   * both. No automation, blend, or manual control touches this node.
   */
  readonly scratchGate: GainNode;
  /**
   * The fx gate (the revamp's R3): a per-deck gain stage in series
   * just before the volume fader, resting at exactly 1
   * (transparent). Only trans performance ever writes to it — the
   * trans effect chops the deck's sound through here at a stated
   * division, dipping to (1 − depth) and returning home. It is
   * deliberately NOT the volume fader: the recipe's blend curves
   * own `gain`, and a gate fighting them for one parameter would
   * corrupt both. It is also NOT the scratch gate: that gate is
   * the scratch techniques' fader, this one is trans's alone, so
   * the two fader patterns can never fight over one parameter
   * either. No automation, blend, or manual control touches this
   * node.
   */
  readonly fxGate: GainNode;
  /**
   * Post-fader sends into the mixer's shared effect networks (the
   * revamp's R3), each resting at 0 (silent) and tapped exactly
   * like echoSend (`this.gain.connect(send)`): what is sent is
   * what the listener hears, fader and all. Effect performance
   * raises a send for its window and returns it to 0; nothing
   * else writes to them.
   */
  readonly reverbSend: GainNode;
  readonly delaySend: GainNode;
  readonly flangerSend: GainNode;
  readonly phaserSend: GainNode;
  readonly distortionSend: GainNode;
  readonly spiralSend: GainNode;
  readonly rollSend: GainNode;
  /**
   * Per-track level matching: a static gain set when a track loads,
   * so quiet and loud masters play at comparable loudness. It sits
   * before everything else; no automation ever writes to it.
   */
  readonly level: GainNode;

  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  /**
   * Segment sources (the revamp's J1): short, pre-scheduled plays
   * of a defined span of the loaded buffer — the primitive beat
   * juggling is made of. They sound through the same permanent
   * chain as the main source, but they are NOT the main source:
   * play()/stop() discipline is untouched, and the mixer silences
   * segments explicitly (stopSegments) on every path that takes
   * the decks over, so a segment can never bleed into whatever
   * sounds next.
   */
  private segmentSources: AudioBufferSourceNode[] = [];

  constructor(
    private readonly context: AudioContext,
    destination: AudioNode,
    echoInput?: AudioNode,
    fxInputs?: Partial<
      Record<
        | "reverb"
        | "delay"
        | "flanger"
        | "phaser"
        | "distortion"
        | "spiral"
        | "roll",
        AudioNode
      >
    >,
  ) {
    this.bass = context.createBiquadFilter();
    this.bass.type = "lowshelf";
    this.bass.frequency.value = 160;
    this.bass.gain.value = BASS_FLAT_DB;

    this.mid = context.createBiquadFilter();
    this.mid.type = "peaking";
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.8;
    this.mid.gain.value = BASS_FLAT_DB;

    this.high = context.createBiquadFilter();
    this.high.type = "highshelf";
    this.high.frequency.value = 4000;
    this.high.gain.value = BASS_FLAT_DB;

    this.filter = context.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 20_000;
    this.filter.Q.value = 0.5;

    this.bassTrim = context.createBiquadFilter();
    this.bassTrim.type = "lowshelf";
    this.bassTrim.frequency.value = 160;
    this.bassTrim.gain.value = BASS_FLAT_DB;

    this.gain = context.createGain();
    this.gain.gain.value = 0;

    this.scratchGate = context.createGain();
    this.scratchGate.gain.value = 1;

    this.fxGate = context.createGain();
    this.fxGate.gain.value = 1;

    this.echoSend = context.createGain();
    this.echoSend.gain.value = 0;

    this.reverbSend = context.createGain();
    this.reverbSend.gain.value = 0;
    this.delaySend = context.createGain();
    this.delaySend.gain.value = 0;
    this.flangerSend = context.createGain();
    this.flangerSend.gain.value = 0;
    this.phaserSend = context.createGain();
    this.phaserSend.gain.value = 0;
    this.distortionSend = context.createGain();
    this.distortionSend.gain.value = 0;
    this.spiralSend = context.createGain();
    this.spiralSend.gain.value = 0;
    this.rollSend = context.createGain();
    this.rollSend.gain.value = 0;

    this.level = context.createGain();
    this.level.gain.value = 1;

    this.level.connect(this.bass);
    this.bass.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.filter);
    this.filter.connect(this.bassTrim);
    this.bassTrim.connect(this.scratchGate);
    this.scratchGate.connect(this.fxGate);
    this.fxGate.connect(this.gain);
    this.gain.connect(destination);
    if (echoInput) {
      this.gain.connect(this.echoSend);
      this.echoSend.connect(echoInput);
    }
    // The R3 sends: tapped post-fader exactly like echoSend, and
    // wired out only where the mixer provided a network input.
    const sends: [GainNode, AudioNode | undefined][] = [
      [this.reverbSend, fxInputs?.reverb],
      [this.delaySend, fxInputs?.delay],
      [this.flangerSend, fxInputs?.flanger],
      [this.phaserSend, fxInputs?.phaser],
      [this.distortionSend, fxInputs?.distortion],
      [this.spiralSend, fxInputs?.spiral],
      [this.rollSend, fxInputs?.roll],
    ];
    for (const [send, input] of sends) {
      if (input) {
        this.gain.connect(send);
        send.connect(input);
      }
    }
  }

  load(buffer: AudioBuffer): void {
    this.buffer = buffer;
  }

  /** Sets this deck's level-matching gain (see levelMatch). */
  setLevel(gainValue: number): void {
    this.level.gain.value = gainValue;
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
    source.connect(this.level);
    source.start(when, Math.max(0, offsetSec));
    this.source = source;
  }

  /** The live playback-rate control of the playing source, if any. */
  get rateControl(): AudioParam | null {
    return this.source ? this.source.playbackRate : null;
  }

  /**
   * Plays one defined segment of the loaded track: a fresh source
   * that starts at audio-clock time `whenCtx` from track position
   * `offsetSec` and stops at `stopCtxTime`. The segment is
   * registered so stopSegments can silence it mid-flight. Returns
   * false when no buffer is loaded (nothing was scheduled).
   */
  playSegment(
    whenCtx: number,
    offsetSec: number,
    stopCtxTime: number,
    rate = 1,
  ): boolean {
    if (!this.buffer) return false;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = rate;
    source.connect(this.level);
    source.start(whenCtx, Math.max(0, offsetSec));
    try {
      source.stop(stopCtxTime);
    } catch {
      // already stopped — nothing to do
    }
    this.segmentSources.push(source);
    return true;
  }

  /** How many segment sources are currently registered on this deck. */
  get segmentCount(): number {
    return this.segmentSources.length;
  }

  /**
   * Silences every registered segment source at `when` (default:
   * now) and forgets them. Returns how many were silenced — the
   * mixer reads a nonzero count as "a juggle was sounding on this
   * deck" and restores that deck's fader accordingly.
   */
  stopSegments(when?: number): number {
    const count = this.segmentSources.length;
    if (count === 0) return 0;
    const at = when ?? this.context.currentTime;
    for (const source of this.segmentSources) {
      try {
        source.stop(at);
      } catch {
        // already stopped — nothing to do
      }
      try {
        source.disconnect();
      } catch {
        // already disconnected — nothing to do
      }
    }
    this.segmentSources = [];
    return count;
  }

  /**
   * Arms a loop on the live source (buffer-time seconds, per the Web
   * Audio spec): playback repeats the region until the loop is
   * cleared or the deck stops. Recipe loop blocks are performed
   * through here. A no-op when nothing is playing.
   */
  setLoopRegion(startSec: number, endSec: number): void {
    if (!this.source) return;
    this.source.loopStart = Math.max(0, startSec);
    this.source.loopEnd = Math.max(startSec + 0.05, endSec);
    this.source.loop = true;
  }

  /** Disarms any loop on the live source. */
  clearLoop(): void {
    if (this.source) this.source.loop = false;
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
