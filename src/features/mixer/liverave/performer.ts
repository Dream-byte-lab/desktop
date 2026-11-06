// performer.ts — the fresh two-deck Web Audio performer (Wave 2B).
//
// LiveRavePerformer executes JoinRecipes from recipe.ts on two
// physical deck chains and exposes the manual stage seams the views
// and session drive. Written fresh for the rebuild — it imports
// NOTHING from src/features/mixer/engine/ (the purge).
//
// BEAT SPACE (binding ruling, design §3.2): curve points and block
// atBeat values are beats relative to the OVERLAP START — beat 0 is
// the audio-clock moment the outgoing deck reaches exitAnchorMs
// while the incoming deck is at entryAnchorMs. This module converts
// beats to seconds ONCE per recipe, in performRecipe:
//
//   beatSec = the outgoing grid's local beat duration AT the exit
//   anchor (factsA.timeAtBeatMs(exitBeat + 1) - timeAtBeatMs(exitBeat)),
//   falling back to 60 / factsA.tempo.bpm, then to 0.5 s (120 bpm).
//
// The grid-local value is preferred because a grid is measured
// evidence about THIS track's timing at THIS point; the recipe's
// overlapBeats and anchors are all phrased against the outgoing
// track's grid, so its beat is the join's beat.
//
// CURVE SCHEDULING CHOICE: dense sampling. Every curve is sampled
// with valueAt() from recipe.ts on a 0.25-beat grid PLUS every
// authored keyframe beat, and each sample becomes a
// setValueAtTime() on the target param. (setValueCurveAtTime would
// also work; dense setValueAtTime keeps every scheduled point
// individually visible to tests and debugging, and valueAt remains
// the single evaluator either way.)
//
// CURVE VALUE SEMANTICS (the recipe document does not carry units,
// so the performer states them): gain curves are linear multipliers
// applied to the deck's preGain; EQ curves are linear multipliers
// mapped to dB as 20*log10(clamp(v, 0.02, 4)) (1 = neutral 0 dB,
// 0.2 ≈ -14 dB, the classic bass-swap depth); filter curves are
// cutoff frequency in Hz, clamped to [30, 20000].
//
// RATES: a beatmatched sustained rate is realised as a pre-rendered
// pitch-preserved rendition (RenditionProvider, soundtouchjs by
// default) swapped in BEFORE the overlap, cached per
// (trackId, rate rounded to 0.001). playbackRate then carries only
// fine trim (1.0 nominal) plus jog/scratch motion — so jogs wobble
// pitch like vinyl, which is correct. A non-beatmatched rate is
// applied directly as playbackRate (pitch moves with it).
//
// SIDES ARE FIXED, WITH swapRoles(): deck chains are self-contained
// objects; after a join completes the session calls swapRoles() and
// the incoming deck's whole chain (track, nodes, strips) becomes
// side A for the next recipe. The session should re-apply the
// crossfader position after a swap (the playing deck arrives with
// its crossfader gain up).
//
// POSITION MODEL: positionMs is nominal — start stamp + elapsed
// ctx time × rendition rate × current playbackRate. Loop wraps and
// scratch-window excursions are not integrated into it; it is the
// transport position the session plans against, not a sample count.

import type { TrackFacts } from "./facts";
import {
  valueAt,
  type FxKind,
  type JoinRecipe,
  type KeyframedCurve,
  type RecipeSide,
} from "./recipe";
import * as SoundTouchModule from "soundtouchjs";

// ---------------------------------------------------------------------
// Public seam types
// ---------------------------------------------------------------------

export type DeckSide = RecipeSide;

export interface DeckLoad {
  trackId: string;
  buffer: AudioBuffer;
  facts: TrackFacts;
}

export interface DeckSnapshot {
  trackId: string | null;
  positionMs: number;
  playing: boolean;
  /** Effective track-time rate (rendition rate × playbackRate). */
  rate: number;
}

export interface PerformOptions {
  /**
   * Seconds from now until the overlap start (beat 0). When omitted:
   * if deck A is playing, beat 0 is when A reaches the exit anchor;
   * otherwise beat 0 is now.
   */
  startInSec?: number;
}

/** The manual FX rack's kinds (always-available sends). */
export type ManualFxKind = Extract<
  FxKind,
  "reverb" | "delay" | "flanger" | "phaser" | "saturation"
>;

export const MANUAL_FX_KINDS: readonly ManualFxKind[] = [
  "reverb",
  "delay",
  "flanger",
  "phaser",
  "saturation",
];

/**
 * Renders a pitch-preserved tempo-shifted rendition of a buffer.
 * render(buffer, rate): rate 1.09 returns audio whose track-time
 * runs 9% faster (duration / 1.09) at unchanged pitch.
 */
export interface RenditionProvider {
  render(buffer: AudioBuffer, rate: number): Promise<AudioBuffer>;
}

// ---------------------------------------------------------------------
// soundtouchjs glue (fresh; the library ships no types of its own)
// ---------------------------------------------------------------------

interface SoundTouchLike {
  tempo: number;
  rate: number;
  pitch: number;
  clear(): void;
}
interface SimpleFilterLike {
  extract(target: Float32Array, numFrames?: number): number;
}
interface BufferSourceLike {
  extract(target: Float32Array, numFrames?: number, position?: number): number;
}
interface SoundTouchModuleShape {
  SoundTouch: new () => SoundTouchLike;
  SimpleFilter: new (
    source: BufferSourceLike,
    pipe: SoundTouchLike,
    callback?: () => void,
  ) => SimpleFilterLike;
  WebAudioBufferSource: new (buffer: AudioBuffer) => BufferSourceLike;
}

const soundTouch = SoundTouchModule as unknown as SoundTouchModuleShape;

/**
 * Default RenditionProvider: offline SoundTouch pipeline
 * (WebAudioBufferSource → SimpleFilter → SoundTouch with tempo set,
 * rate/pitch at 1), pulled in chunks and de-interleaved into a new
 * AudioBuffer created on the performer's context.
 *
 * Verdict on the library: the offline pull pipeline drives cleanly
 * with no ScriptProcessor and no DOM — extract() returns 0 at end of
 * stream, which is the loop's stop condition. The streaming
 * PitchShifter/getWebAudioNode surface was NOT used (deprecated
 * ScriptProcessor, wrong shape for pre-rendered renditions).
 */
export class SoundTouchRenditionProvider implements RenditionProvider {
  constructor(private readonly bufferFactory: BaseAudioContext) {}

  async render(buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
    if (!Number.isFinite(rate) || rate <= 0 || Math.abs(rate - 1) < 1e-4) {
      return buffer;
    }
    const pipe = new soundTouch.SoundTouch();
    pipe.tempo = rate;
    pipe.rate = 1;
    pipe.pitch = 1;
    const source = new soundTouch.WebAudioBufferSource(buffer);
    const filter = new soundTouch.SimpleFilter(source, pipe);
    const chunkFrames = 4096;
    const chunk = new Float32Array(chunkFrames * 2);
    const left: number[] = [];
    const right: number[] = [];
    // The stretch pipeline needs priming and drains past the input's
    // end; the guard bounds the loop if a stream misbehaves.
    for (let guard = 0; guard < 100_000; guard += 1) {
      const frames = filter.extract(chunk, chunkFrames);
      if (frames === 0) break;
      for (let i = 0; i < frames; i += 1) {
        left.push(chunk[i * 2]);
        right.push(chunk[i * 2 + 1]);
      }
    }
    const outChannels = buffer.numberOfChannels >= 2 ? 2 : 1;
    const out = this.bufferFactory.createBuffer(
      outChannels,
      Math.max(1, left.length),
      buffer.sampleRate,
    );
    out.getChannelData(0).set(left);
    if (outChannels >= 2) {
      out.getChannelData(1).set(right.length > 0 ? right : left);
    }
    return out;
  }
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function roundRate(rate: number): number {
  return Math.round(rate * 1000) / 1000;
}

/** EQ curve multiplier → biquad gain dB (see header). */
function eqDbFromMultiplier(value: number): number {
  return 20 * Math.log10(clamp(value, 0.02, 4));
}

const CURVE_SAMPLE_STEP_BEATS = 0.25;

// ---------------------------------------------------------------------
// Internal deck / fx structures
// ---------------------------------------------------------------------

interface FxChain {
  input: GainNode;
  output: GainNode;
  nodes: AudioNode[];
  oscs: OscillatorNode[];
  params: AudioParam[];
  /** Spiral chains only: the scheduler animates these. */
  spiralFilter?: BiquadFilterNode;
  spiralFeedback?: GainNode;
}

interface DeckState {
  side: DeckSide;
  trackId: string | null;
  buffer: AudioBuffer | null;
  currentBuffer: AudioBuffer | null;
  facts: TrackFacts | null;
  // Graph (built once per physical deck).
  input: GainNode;
  scratchGate: GainNode;
  preGain: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  filter: BiquadFilterNode;
  channelGain: GainNode;
  fxGate: GainNode;
  crossfaderGain: GainNode;
  fxBus: GainNode;
  // Transport.
  source: AudioBufferSourceNode | null;
  extraSources: Set<AudioBufferSourceNode>;
  playing: boolean;
  startCtxTime: number;
  startTrackMs: number;
  pausedMs: number;
  stopAtCtx: number | null;
  generation: number;
  /** Track-time multiplier contributed by the current rendition. */
  rateFactor: number;
  /** Nominal playbackRate (trim / non-beatmatched rate). */
  planRate: number;
  loopSpan: { startMs: number; endMs: number } | null;
  // Manual FX.
  fxAssign: Map<ManualFxKind, boolean>;
  fxLevels: Map<ManualFxKind, number>;
  fxSends: Map<ManualFxKind, GainNode>;
  manualChains: Map<ManualFxKind, FxChain>;
  roll: { chain: FxChain; send: GainNode } | null;
}

const ALL_FX_KINDS: readonly FxKind[] = [
  "reverb",
  "delay",
  "spiral",
  "flanger",
  "phaser",
  "saturation",
  "gating",
  "slip-roll",
];

// ---------------------------------------------------------------------
// LiveRavePerformer
// ---------------------------------------------------------------------

export class LiveRavePerformer {
  /** Session hook: fired when a deck's source ends on its own. */
  onDeckEnded?: (side: DeckSide) => void;

  private readonly ctx: AudioContext;
  private readonly renditions: RenditionProvider;
  private readonly renditionCache = new Map<string, Promise<AudioBuffer>>();

  private readonly master: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly fxReturn: GainNode;
  private readonly tailBus: GainNode;
  private readonly decks: Record<DeckSide, DeckState>;

  /** Every param this performer has created (stopAll registry). */
  private readonly ownedParams = new Set<AudioParam>();
  private readonly ownedSources = new Set<AudioBufferSourceNode>();
  private readonly ownedOscs = new Set<OscillatorNode>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly ephemeralChains = new Set<FxChain>();
  private crossfaderValue = 0.5;

  constructor(
    contextOrFactory: AudioContext | (() => AudioContext),
    opts?: { renditionProvider?: RenditionProvider },
  ) {
    this.ctx =
      typeof contextOrFactory === "function"
        ? (contextOrFactory as () => AudioContext)()
        : contextOrFactory;
    this.renditions =
      opts?.renditionProvider ?? new SoundTouchRenditionProvider(this.ctx);

    this.master = this.newGain(1);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.fxReturn = this.ctx.createGain();
    this.fxReturn.gain.value = 1;
    this.track(this.fxReturn.gain);
    this.fxReturn.connect(this.master);

    this.tailBus = this.ctx.createGain();
    this.tailBus.gain.value = 1;
    this.track(this.tailBus.gain);

    this.decks = {
      A: this.buildDeck("A"),
      B: this.buildDeck("B"),
    };
    this.setCrossfader(this.crossfaderValue);
  }

  // -- registry helpers ------------------------------------------------

  private track(param: AudioParam): AudioParam {
    this.ownedParams.add(param);
    return param;
  }

  private newGain(value = 1): GainNode {
    const node = this.ctx.createGain();
    node.gain.value = value;
    this.track(node.gain);
    return node;
  }

  private newBiquad(
    type: BiquadFilterType,
    frequency: number,
    gainDb = 0,
    q = 1,
  ): BiquadFilterNode {
    const node = this.ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.gain.value = gainDb;
    node.Q.value = q;
    this.track(node.frequency);
    this.track(node.gain);
    this.track(node.Q);
    return node;
  }

  private after(delaySec: number, fn: () => void): void {
    if (!Number.isFinite(delaySec)) return;
    const handle = setTimeout(
      () => {
        this.timers.delete(handle);
        fn();
      },
      Math.max(0, delaySec * 1000),
    );
    this.timers.add(handle);
  }

  // -- graph construction ----------------------------------------------

  private buildDeck(side: DeckSide): DeckState {
    const input = this.newGain(1);
    const scratchGate = this.newGain(1);
    const preGain = this.newGain(1);
    const eqLow = this.newBiquad("lowshelf", 200);
    const eqMid = this.newBiquad("peaking", 1000, 0, 0.9);
    const eqHigh = this.newBiquad("highshelf", 4000);
    const filter = this.newBiquad("lowpass", 20_000, 0, 0.7);
    const channelGain = this.newGain(1);
    const fxGate = this.newGain(1);
    const crossfaderGain = this.newGain(1);
    const fxBus = this.newGain(1);

    // source → preGain → EQ → filter → channelGain → crossfaderGain
    // → master, with scratchGate at the input and fxGate between
    // channel and crossfader (the gating effect's home).
    input.connect(scratchGate);
    scratchGate.connect(preGain);
    preGain.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(filter);
    filter.connect(channelGain);
    channelGain.connect(fxGate);
    fxGate.connect(crossfaderGain);
    crossfaderGain.connect(this.master);
    // FX send tap (post channel strip) and the shared tail bus tap.
    channelGain.connect(fxBus);
    crossfaderGain.connect(this.tailBus);

    return {
      side,
      trackId: null,
      buffer: null,
      currentBuffer: null,
      facts: null,
      input,
      scratchGate,
      preGain,
      eqLow,
      eqMid,
      eqHigh,
      filter,
      channelGain,
      fxGate,
      crossfaderGain,
      fxBus,
      source: null,
      extraSources: new Set(),
      playing: false,
      startCtxTime: 0,
      startTrackMs: 0,
      pausedMs: 0,
      stopAtCtx: null,
      generation: 0,
      rateFactor: 1,
      planRate: 1,
      loopSpan: null,
      fxAssign: new Map(),
      fxLevels: new Map(),
      fxSends: new Map(),
      manualChains: new Map(),
      roll: null,
    };
  }

  // -- deck loading / transport -----------------------------------------

  loadDeck(side: DeckSide, load: DeckLoad): void {
    const deck = this.decks[side];
    this.stopSource(deck);
    deck.generation += 1;
    deck.trackId = load.trackId;
    deck.buffer = load.buffer;
    deck.currentBuffer = load.buffer;
    deck.facts = load.facts;
    deck.rateFactor = 1;
    deck.planRate = 1;
    deck.pausedMs = 0;
    deck.playing = false;
    deck.stopAtCtx = null;
    deck.loopSpan = null;
    // Fresh strip for the new track (manual trims are re-applied by
    // the stage; a stale cut EQ from the previous track must not
    // leak into this one).
    deck.preGain.gain.value = 1;
    deck.scratchGate.gain.value = 1;
    deck.fxGate.gain.value = 1;
    deck.eqLow.gain.value = 0;
    deck.eqMid.gain.value = 0;
    deck.eqHigh.gain.value = 0;
    deck.filter.frequency.value = 20_000;
    deck.channelGain.gain.value = 1;
    // stopAll() also zeroes the two remaining dry-path stages —
    // `input` (chain hop 0) and `crossfaderGain` (hop 9) — and no
    // other code path ever raises them again, so a deck loaded
    // after a stopAll (every takeover does exactly that) played
    // into two series gains held at 0: positions advanced over
    // digital silence (realcheck S1). Restore both here, where
    // their sibling gains already live, so every deck-loading path
    // (takeover, plain cut, join) reopens the full dry chain.
    deck.input.gain.value = 1;
    this.setCrossfader(this.crossfaderValue);
  }

  unloadDeck(side: DeckSide): void {
    const deck = this.decks[side];
    this.stopSource(deck);
    deck.generation += 1;
    deck.trackId = null;
    deck.buffer = null;
    deck.currentBuffer = null;
    deck.facts = null;
    deck.playing = false;
    deck.pausedMs = 0;
    deck.stopAtCtx = null;
    deck.loopSpan = null;
    // An unloaded deck must not keep a performed recipe's rate
    // (fix2-0119: an empty deck was seen still showing the last
    // join's 1.06× — the rate state now resets with the load).
    deck.rateFactor = 1;
    deck.planRate = 1;
  }

  playDeck(side: DeckSide, atMs?: number): void {
    const deck = this.decks[side];
    if (!deck.currentBuffer) return;
    if (deck.playing && atMs === undefined) return;
    const startMs = atMs ?? deck.pausedMs;
    this.startSource(deck, startMs, this.ctx.currentTime);
  }

  pauseDeck(side: DeckSide): void {
    const deck = this.decks[side];
    if (!deck.playing) return;
    deck.pausedMs = this.positionMs(side);
    this.stopSource(deck);
    deck.playing = false;
  }

  seekTo(side: DeckSide, ms: number): void {
    const deck = this.decks[side];
    const target = Math.max(0, ms);
    if (deck.playing && deck.currentBuffer) {
      this.startSource(deck, target, this.ctx.currentTime);
    } else {
      deck.pausedMs = target;
    }
  }

  positionMs(side: DeckSide): number {
    const deck = this.decks[side];
    if (!deck.playing || !deck.source) return deck.pausedMs;
    const now = this.ctx.currentTime;
    if (now <= deck.startCtxTime) return deck.startTrackMs;
    const endCtx = deck.stopAtCtx ?? now;
    const elapsed = Math.min(now, endCtx) - deck.startCtxTime;
    return deck.startTrackMs + elapsed * 1000 * this.effectiveRate(deck);
  }

  isPlaying(side: DeckSide): boolean {
    const deck = this.decks[side];
    if (!deck.playing) return false;
    if (deck.stopAtCtx !== null && this.ctx.currentTime >= deck.stopAtCtx) {
      return false;
    }
    return true;
  }

  snapshot(side: DeckSide): DeckSnapshot {
    const deck = this.decks[side];
    return {
      trackId: deck.trackId,
      positionMs: this.positionMs(side),
      playing: this.isPlaying(side),
      rate: this.effectiveRate(deck),
    };
  }

  masterAnalyser(): AnalyserNode {
    return this.analyser;
  }

  /**
   * The autoplay-policy seam (fix2-0119): this context is created
   * lazily, and one creation path — the intent wiring's
   * gesture-less auto-resume start — can bring it up "suspended".
   * A suspended context's currentTime never advances, so every
   * deck position freezes and the session's whole clock stops
   * with no error anywhere: silence that looks exactly like a
   * hang. Nothing in the performer can fix that from inside (its
   * scheduling already assumes a running clock), so the session
   * calls this at start, at takeover and on resume: a suspended
   * context is asked to run. A refusal (the browser still wants
   * a user gesture) is not an error — the attempt is swallowed
   * and the next call site retries.
   */
  ensureContextRunning(): void {
    if (this.ctx.state !== "suspended") return;
    try {
      void this.ctx.resume().catch(() => {});
    } catch {
      // A context that throws on resume is left as it is.
    }
  }

  /** The context's state, for the session's authority watch. */
  contextState(): AudioContextState {
    return this.ctx.state;
  }

  /**
   * Exchange the two deck chains: after a join, the incoming deck
   * (chain, track, strips and all) becomes side A. The session
   * should re-apply its crossfader position after swapping.
   */
  swapRoles(): void {
    const a = this.decks.A;
    const b = this.decks.B;
    a.side = "B";
    b.side = "A";
    this.decks.A = b;
    this.decks.B = a;
  }

  private effectiveRate(deck: DeckState): number {
    const trim = deck.source ? deck.source.playbackRate.value : deck.planRate;
    return deck.rateFactor * (trim || deck.planRate || 1);
  }

  private trackMsToBufferSec(deck: DeckState, trackMs: number): number {
    return trackMs / 1000 / (deck.rateFactor || 1);
  }

  /** Stop the current sources, then start a fresh main source. */
  private startSource(
    deck: DeckState,
    trackMs: number,
    when: number,
  ): AudioBufferSourceNode {
    this.stopSource(deck);
    return this.createScheduledSource(deck, trackMs, when);
  }

  /**
   * Create + start the deck's main source WITHOUT stopping anything.
   * Used by scratch/spinback schedulers, which have already arranged
   * the outgoing sources' stop times on the audio clock and must not
   * have those schedules clobbered by an immediate stop().
   */
  private createScheduledSource(
    deck: DeckState,
    trackMs: number,
    when: number,
  ): AudioBufferSourceNode {
    deck.generation += 1;
    const generation = deck.generation;
    const src = this.ctx.createBufferSource();
    src.buffer = deck.currentBuffer;
    src.playbackRate.value = deck.planRate;
    this.track(src.playbackRate);
    if (deck.loopSpan) {
      src.loop = true;
      src.loopStart = this.trackMsToBufferSec(deck, deck.loopSpan.startMs);
      src.loopEnd = this.trackMsToBufferSec(deck, deck.loopSpan.endMs);
    }
    src.connect(deck.input);
    src.onended = () => {
      if (deck.source === src && deck.generation === generation) {
        deck.playing = false;
        deck.source = null;
        this.onDeckEnded?.(deck.side);
      }
    };
    this.ownedSources.add(src);
    const offset = clamp(
      this.trackMsToBufferSec(deck, Math.max(0, trackMs)),
      0,
      deck.currentBuffer ? deck.currentBuffer.duration : 0,
    );
    try {
      src.start(when, offset);
    } catch {
      src.start(when);
    }
    deck.source = src;
    deck.startCtxTime = when;
    deck.startTrackMs = Math.max(0, trackMs);
    deck.playing = true;
    deck.stopAtCtx = null;
    return src;
  }

  private stopSource(deck: DeckState): void {
    for (const extra of deck.extraSources) {
      try {
        extra.stop();
      } catch {
        /* already stopped */
      }
      try {
        extra.disconnect();
      } catch {
        /* noop */
      }
    }
    deck.extraSources.clear();
    const src = deck.source;
    if (!src) return;
    deck.source = null;
    try {
      src.stop();
    } catch {
      /* not started or already stopped */
    }
    try {
      src.disconnect();
    } catch {
      /* noop */
    }
  }

  // -- FX chain builders -------------------------------------------------

  private makeImpulse(decaySec: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * Math.max(0.1, decaySec)));
    const impulse = this.ctx.createBuffer(2, length, rate);
    // Deterministic pseudo-noise (seeded LCG) so tests and sessions
    // hear the same generated room every time.
    let seed = 22222;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        data[i] = (next() * 2 - 1) * Math.exp((-3 * i) / length);
      }
    }
    return impulse;
  }

  private makeSaturationCurve(drive: number): Float32Array<ArrayBuffer> {
    const length = 256;
    const curve = new Float32Array(length);
    const norm = Math.tanh(drive) || 1;
    for (let i = 0; i < length; i += 1) {
      const x = (i / (length - 1)) * 2 - 1;
      curve[i] = Math.tanh(drive * x) / norm;
    }
    return curve;
  }

  private newOsc(type: OscillatorType, freq: number): OscillatorNode {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    this.track(osc.frequency);
    this.track(osc.detune);
    this.ownedOscs.add(osc);
    return osc;
  }

  /**
   * Build one FX processor chain (input gain → processor → output
   * gain). Handles the send-style kinds; gating and slip-roll have
   * their own schedulers/builders below.
   */
  private buildFxChain(
    kind: FxKind,
    params: Record<string, number>,
    beatSec: number,
  ): FxChain {
    const input = this.newGain(1);
    const output = this.newGain(1);
    const nodes: AudioNode[] = [input, output];
    const oscs: OscillatorNode[] = [];
    let spiralFilter: BiquadFilterNode | undefined;
    let spiralFeedback: GainNode | undefined;
    const chainParams: AudioParam[] = [input.gain, output.gain];
    const regDelay = (d: DelayNode): DelayNode => {
      this.track(d.delayTime);
      chainParams.push(d.delayTime);
      nodes.push(d);
      return d;
    };

    switch (kind) {
      case "reverb": {
        const convolver = this.ctx.createConvolver();
        convolver.buffer = this.makeImpulse(params.decay ?? 1.8);
        nodes.push(convolver);
        input.connect(convolver);
        convolver.connect(output);
        break;
      }
      case "delay":
      case "spiral": {
        const delay = regDelay(this.ctx.createDelay(4));
        delay.delayTime.value = params.timeSec ?? (params.beats ?? 1) * beatSec;
        const feedback = this.newGain(
          kind === "spiral" ? 0.3 : (params.feedback ?? 0.35),
        );
        chainParams.push(feedback.gain);
        input.connect(delay);
        delay.connect(output);
        if (kind === "spiral") {
          const sweep = this.newBiquad(
            "lowpass",
            params.freqStart ?? 800,
            0,
            0.8,
          );
          chainParams.push(sweep.frequency);
          delay.connect(sweep);
          sweep.connect(feedback);
          feedback.connect(delay);
          // Rising feedback + sweeping filter are scheduled by the
          // FxBlock scheduler via these chain fields.
          spiralFilter = sweep;
          spiralFeedback = feedback;
        } else {
          delay.connect(feedback);
          feedback.connect(delay);
        }
        break;
      }
      case "flanger": {
        const delay = regDelay(this.ctx.createDelay(0.05));
        delay.delayTime.value = params.baseDelay ?? 0.0035;
        const feedback = this.newGain(params.feedback ?? 0.35);
        chainParams.push(feedback.gain);
        const osc = this.newOsc("sine", params.rate ?? 0.25);
        const depth = this.newGain(params.depth ?? 0.002);
        chainParams.push(depth.gain);
        osc.connect(depth);
        depth.connect(delay.delayTime);
        input.connect(delay);
        input.connect(output);
        delay.connect(output);
        delay.connect(feedback);
        feedback.connect(delay);
        oscs.push(osc);
        break;
      }
      case "phaser": {
        const stages: BiquadFilterNode[] = [];
        let head: AudioNode = input;
        for (let i = 0; i < 4; i += 1) {
          const ap = this.newBiquad(
            "allpass",
            (params.freq ?? 800) * (1 + i * 0.35),
            0,
            8,
          );
          chainParams.push(ap.frequency);
          head.connect(ap);
          head = ap;
          stages.push(ap);
        }
        head.connect(output);
        const osc = this.newOsc("sine", params.rate ?? 0.5);
        const depth = this.newGain(params.depth ?? 400);
        chainParams.push(depth.gain);
        osc.connect(depth);
        for (const ap of stages) depth.connect(ap.frequency);
        oscs.push(osc);
        break;
      }
      case "saturation": {
        const shaper = this.ctx.createWaveShaper();
        shaper.curve = this.makeSaturationCurve(params.drive ?? 8);
        shaper.oversample = "2x";
        nodes.push(shaper);
        input.connect(shaper);
        shaper.connect(output);
        break;
      }
      default: {
        // gating / slip-roll never reach here; pass through safely.
        input.connect(output);
        break;
      }
    }

    const chain: FxChain = { input, output, nodes, oscs, params: chainParams };
    if (spiralFilter) chain.spiralFilter = spiralFilter;
    if (spiralFeedback) chain.spiralFeedback = spiralFeedback;
    return chain;
  }

  private buildSlipRollChain(sliceSec: number, feedback = 0.55): FxChain {
    const input = this.newGain(1);
    const output = this.newGain(1);
    const delay = this.ctx.createDelay(4);
    delay.delayTime.value = Math.max(0.02, sliceSec);
    this.track(delay.delayTime);
    const fb = this.newGain(feedback);
    input.connect(delay);
    delay.connect(output);
    delay.connect(fb);
    fb.connect(delay);
    return {
      input,
      output,
      nodes: [input, output, delay, fb],
      oscs: [],
      params: [input.gain, output.gain, delay.delayTime, fb.gain],
    };
  }

  private disposeChain(chain: FxChain): void {
    for (const osc of chain.oscs) {
      try {
        osc.stop();
      } catch {
        /* noop */
      }
    }
    for (const node of chain.nodes) {
      try {
        node.disconnect();
      } catch {
        /* noop */
      }
    }
    this.ephemeralChains.delete(chain);
  }

  // -- manual stage seams -------------------------------------------------

  setMasterGain(value: number): void {
    this.master.gain.value = clamp(value, 0, 2);
  }

  setChannelGain(side: DeckSide, value: number): void {
    this.decks[side].channelGain.gain.value = clamp(value, 0, 2);
  }

  /** EQ trim in dB for one band of one deck, applied live. */
  setEq(side: DeckSide, band: "low" | "mid" | "high", gainDb: number): void {
    const deck = this.decks[side];
    const node =
      band === "low" ? deck.eqLow : band === "mid" ? deck.eqMid : deck.eqHigh;
    node.gain.value = clamp(gainDb, -40, 24);
  }

  setFilter(side: DeckSide, freqHz: number, q?: number): void {
    const deck = this.decks[side];
    deck.filter.frequency.value = clamp(freqHz, 30, 20_000);
    if (q !== undefined) deck.filter.Q.value = clamp(q, 0.1, 18);
  }

  /** Crossfader position 0 (all A) … 1 (all B), equal-power. */
  setCrossfader(value: number): void {
    this.crossfaderValue = clamp(value, 0, 1);
    const angle = this.crossfaderValue * (Math.PI / 2);
    this.decks.A.crossfaderGain.gain.value = Math.cos(angle);
    this.decks.B.crossfaderGain.gain.value = Math.sin(angle);
  }

  private ensureManualFx(deck: DeckState, kind: ManualFxKind): GainNode {
    const existing = deck.fxSends.get(kind);
    if (existing) return existing;
    const chain = this.buildFxChain(kind, {}, 0.5);
    chain.output.connect(this.fxReturn);
    const send = this.newGain(0);
    deck.fxBus.connect(send);
    send.connect(chain.input);
    deck.fxSends.set(kind, send);
    // Manual chains live until stopAll; they are not ephemeral.
    deck.manualChains.set(kind, chain);
    for (const osc of chain.oscs) {
      try {
        osc.start();
      } catch {
        /* already started */
      }
    }
    return send;
  }

  private applyFxSend(deck: DeckState, kind: ManualFxKind): void {
    const send = deck.fxSends.get(kind);
    if (!send) return;
    const on = deck.fxAssign.get(kind) ?? false;
    const level = deck.fxLevels.get(kind) ?? 0;
    send.gain.value = on ? clamp(level, 0, 1) : 0;
  }

  setFxAssign(side: DeckSide, kind: ManualFxKind, on: boolean): void {
    const deck = this.decks[side];
    deck.fxAssign.set(kind, on);
    this.ensureManualFx(deck, kind);
    this.applyFxSend(deck, kind);
  }

  setFxSendLevel(side: DeckSide, kind: ManualFxKind, level: number): void {
    const deck = this.decks[side];
    deck.fxLevels.set(kind, clamp(level, 0, 1));
    this.ensureManualFx(deck, kind);
    this.applyFxSend(deck, kind);
  }

  /** Beat loop on a deck; span in track ms, or null to release. */
  setManualLoop(
    side: DeckSide,
    span: { startMs: number; endMs: number } | null,
  ): void {
    const deck = this.decks[side];
    deck.loopSpan = span;
    const src = deck.source;
    if (!src) return;
    if (span) {
      src.loop = true;
      src.loopStart = this.trackMsToBufferSec(deck, span.startMs);
      src.loopEnd = this.trackMsToBufferSec(deck, span.endMs);
    } else {
      src.loop = false;
    }
  }

  /** Slip-roll held by hand: captures a one-beat slice while on. */
  setManualRoll(side: DeckSide, on: boolean): void {
    const deck = this.decks[side];
    if (on && !deck.roll) {
      const bpm = deck.facts?.tempo.bpm ?? null;
      const sliceSec = bpm && bpm > 0 ? 60 / bpm : 0.5;
      const chain = this.buildSlipRollChain(sliceSec);
      chain.output.connect(this.fxReturn);
      const send = this.newGain(0);
      deck.fxBus.connect(send);
      send.connect(chain.input);
      deck.roll = { chain, send };
    }
    if (deck.roll) {
      deck.roll.send.gain.value = on ? 1 : 0;
      if (!on) {
        const roll = deck.roll;
        deck.roll = null;
        this.after(0.3, () => this.disposeChain(roll.chain));
        try {
          roll.send.disconnect();
        } catch {
          /* noop */
        }
      }
    }
  }

  // -- recipe performance ---------------------------------------------------

  /** Beat duration in seconds from the outgoing grid at the exit
   * anchor, falling back to tempo, then to 120 bpm (see header). */
  private beatSecondsFor(recipe: JoinRecipe, deckA: DeckState): number {
    const facts = deckA.facts;
    if (facts) {
      const t0 = facts.timeAtBeatMs(recipe.outgoing.exitBeat);
      const t1 = facts.timeAtBeatMs(recipe.outgoing.exitBeat + 1);
      if (t0 !== null && t1 !== null && t1 > t0) return (t1 - t0) / 1000;
      if (facts.tempo.bpm && facts.tempo.bpm > 0) {
        return 60 / facts.tempo.bpm;
      }
    }
    return 0.5;
  }

  private async getRendition(
    deck: DeckState,
    roundedRate: number,
  ): Promise<AudioBuffer> {
    const key = `${deck.trackId ?? "?"}@${roundedRate.toFixed(3)}`;
    let pending = this.renditionCache.get(key);
    if (!pending) {
      pending = this.renditions.render(deck.buffer as AudioBuffer, roundedRate);
      this.renditionCache.set(key, pending);
    }
    return pending;
  }

  /**
   * Swap a deck onto its beatmatched rendition BEFORE the overlap.
   * A playing deck restarts at its current track position on the
   * rendition; a stopped deck just changes buffer. On provider
   * failure the rate falls back to raw playbackRate (pitch moves).
   */
  private async applyRendition(deck: DeckState, rate: number): Promise<void> {
    const rounded = roundRate(rate);
    if (rounded === 1 || !deck.buffer) {
      deck.rateFactor = 1;
      deck.planRate = 1;
      if (deck.source) deck.source.playbackRate.value = 1;
      return;
    }
    try {
      const rendition = await this.getRendition(deck, rounded);
      const wasPlaying = deck.playing && deck.source !== null;
      const pos = wasPlaying ? this.positionMs(deck.side) : deck.pausedMs;
      deck.currentBuffer = rendition;
      deck.rateFactor = rounded;
      deck.planRate = 1;
      if (wasPlaying) {
        this.startSource(deck, pos, this.ctx.currentTime);
      }
    } catch {
      deck.rateFactor = 1;
      deck.planRate = rounded;
      if (deck.source) deck.source.playbackRate.value = rounded;
    }
  }

  private scheduleCurve(
    param: AudioParam,
    curve: KeyframedCurve,
    t0: number,
    beatSec: number,
    endBeat: number,
    map: (value: number) => number,
  ): void {
    if (!curve || curve.length === 0) return;
    const beats = new Set<number>();
    const from = Math.min(0, curve[0].atBeat);
    const to = Math.max(endBeat, curve[curve.length - 1].atBeat);
    for (let b = from; b <= to + 1e-9; b += CURVE_SAMPLE_STEP_BEATS) {
      beats.add(Math.round(b * 1000) / 1000);
    }
    for (const point of curve) beats.add(point.atBeat);
    const sorted = [...beats].sort((a, z) => a - z);
    for (const beat of sorted) {
      const time = Math.max(this.ctx.currentTime, t0 + beat * beatSec);
      param.setValueAtTime(map(valueAt(curve, beat)), time);
    }
  }

  async performRecipe(
    recipe: JoinRecipe,
    opts?: PerformOptions,
  ): Promise<void> {
    const deckA = this.decks.A;
    const deckB = this.decks.B;
    if (!deckA.currentBuffer || !deckB.currentBuffer) {
      throw new Error(
        "performRecipe: both decks must be loaded before a recipe can play",
      );
    }
    const beatSec = this.beatSecondsFor(recipe, deckA);
    const now = this.ctx.currentTime;

    // Beat 0 (the overlap start) on the audio clock.
    let t0: number;
    if (opts?.startInSec !== undefined) {
      t0 = now + Math.max(0, opts.startInSec);
    } else if (deckA.playing && deckA.source) {
      const remainMs = recipe.outgoing.exitAnchorMs - this.positionMs("A");
      t0 =
        now + Math.max(0, remainMs / 1000 / (this.effectiveRate(deckA) || 1));
    } else {
      t0 = now;
    }

    // Sustained rates BEFORE the overlap: renditions when
    // beatmatched, raw playbackRate otherwise.
    if (recipe.rates.beatmatched) {
      await this.applyRendition(deckA, recipe.rates.rateA);
      await this.applyRendition(deckB, recipe.rates.rateB);
    } else {
      deckA.rateFactor = 1;
      deckB.rateFactor = 1;
      deckA.planRate = recipe.rates.rateA;
      deckB.planRate = recipe.rates.rateB;
      if (deckA.source) deckA.source.playbackRate.value = deckA.planRate;
    }

    // Both decks playing: A reaches the exit anchor at t0, B starts
    // at the entry anchor at t0.
    if (!deckA.playing) {
      const leadMs =
        (t0 - this.ctx.currentTime) * 1000 * (this.effectiveRate(deckA) || 1);
      const startTrack = Math.max(0, recipe.outgoing.exitAnchorMs - leadMs);
      this.startSource(deckA, startTrack, this.ctx.currentTime);
    }
    if (!deckB.playing) {
      this.startSource(deckB, recipe.incoming.entryAnchorMs, t0);
    }

    // Curves (dense valueAt sampling — see header).
    const endBeat = recipe.overlapBeats;
    const identity = (v: number): number => Math.max(0, v);
    this.scheduleCurve(
      deckA.preGain.gain,
      recipe.curves.gainA,
      t0,
      beatSec,
      endBeat,
      identity,
    );
    this.scheduleCurve(
      deckB.preGain.gain,
      recipe.curves.gainB,
      t0,
      beatSec,
      endBeat,
      identity,
    );
    const eqMap = (v: number): number => eqDbFromMultiplier(v);
    this.scheduleCurve(
      deckA.eqLow.gain,
      recipe.curves.eqA.low,
      t0,
      beatSec,
      endBeat,
      eqMap,
    );
    this.scheduleCurve(
      deckA.eqMid.gain,
      recipe.curves.eqA.mid,
      t0,
      beatSec,
      endBeat,
      eqMap,
    );
    this.scheduleCurve(
      deckA.eqHigh.gain,
      recipe.curves.eqA.high,
      t0,
      beatSec,
      endBeat,
      eqMap,
    );
    this.scheduleCurve(
      deckB.eqLow.gain,
      recipe.curves.eqB.low,
      t0,
      beatSec,
      endBeat,
      eqMap,
    );
    this.scheduleCurve(
      deckB.eqMid.gain,
      recipe.curves.eqB.mid,
      t0,
      beatSec,
      endBeat,
      eqMap,
    );
    this.scheduleCurve(
      deckB.eqHigh.gain,
      recipe.curves.eqB.high,
      t0,
      beatSec,
      endBeat,
      eqMap,
    );
    const filterMap = (v: number): number => clamp(v, 30, 20_000);
    this.scheduleCurve(
      deckA.filter.frequency,
      recipe.curves.filterA,
      t0,
      beatSec,
      endBeat,
      filterMap,
    );
    this.scheduleCurve(
      deckB.filter.frequency,
      recipe.curves.filterB,
      t0,
      beatSec,
      endBeat,
      filterMap,
    );

    // Blocks.
    for (const block of recipe.blocks) {
      switch (block.type) {
        case "loop":
          this.scheduleLoopBlock(deckA, deckB, block, t0);
          break;
        case "jog":
          this.scheduleJogBlock(
            block.side === "A" ? deckA : deckB,
            block,
            recipe,
            t0,
            beatSec,
          );
          break;
        case "scratch":
          this.scheduleScratchBlock(
            block.side === "A" ? deckA : deckB,
            block,
            recipe,
            t0,
            beatSec,
          );
          break;
        case "fx":
          this.scheduleFxBlock(block, t0, beatSec);
          break;
      }
    }
  }

  // -- block schedulers -----------------------------------------------------

  private scheduleLoopBlock(
    deckA: DeckState,
    deckB: DeckState,
    block: Extract<JoinRecipe["blocks"][number], { type: "loop" }>,
    t0: number,
  ): void {
    const deck = block.side === "A" ? deckA : deckB;
    const src = deck.source;
    if (!src || !deck.currentBuffer) return;
    deck.loopSpan = { startMs: block.startMs, endMs: block.endMs };
    src.loop = true;
    src.loopStart = this.trackMsToBufferSec(deck, block.startMs);
    src.loopEnd = this.trackMsToBufferSec(deck, block.endMs);
    // Release after the span has wrapped `wraps` times: time to
    // first reach loopEnd, plus (wraps - 1) further span plays.
    const rate = this.effectiveRate(deck) || 1;
    const refPos =
      block.side === "B" ? deck.startTrackMs : this.positionMs(deck.side);
    const refTime = block.side === "B" ? t0 : this.ctx.currentTime;
    const spanSec = (block.endMs - block.startMs) / 1000 / rate;
    const toEndSec = Math.max(0, (block.endMs - refPos) / 1000 / rate);
    const releaseIn =
      refTime - this.ctx.currentTime + toEndSec + (block.wraps - 1) * spanSec;
    this.after(releaseIn, () => {
      if (deck.source === src) {
        src.loop = false;
        if (deck.loopSpan?.startMs === block.startMs) deck.loopSpan = null;
      }
    });
  }

  private scheduleJogBlock(
    deck: DeckState,
    block: Extract<JoinRecipe["blocks"][number], { type: "jog" }>,
    recipe: JoinRecipe,
    t0: number,
    beatSec: number,
  ): void {
    const src = deck.source;
    if (!src) return;
    const start = Math.max(this.ctx.currentTime, t0 + block.atBeat * beatSec);
    const dur = block.beats * beatSec;
    const end = start + dur;
    const param = src.playbackRate;
    const base = deck.planRate || 1;

    if (block.kind === "nudge") {
      const bend = block.bend ?? 1.02;
      param.setValueAtTime(base * bend, start);
      param.linearRampToValueAtTime(base, end);
      param.setValueAtTime(base, end);
      return;
    }
    if (block.kind === "brake") {
      // Vinyl brake: linear fall to a near-stop, then the deck ends.
      param.setValueAtTime(base, start);
      param.linearRampToValueAtTime(0.02, end);
      param.setValueAtTime(0.02, end);
      this.endDeckAt(deck, src, end);
      return;
    }
    if (block.kind === "vinyl-stop") {
      // Faster, exponential-feeling fall (a hand on the platter).
      param.setValueAtTime(base, start);
      param.exponentialRampToValueAtTime(0.02, end);
      param.setValueAtTime(0.02, end);
      this.endDeckAt(deck, src, end);
      return;
    }
    // spinback: swap to a reversed render of the window behind the
    // playhead, drive through it fast, then (unless this is the
    // outgoing deck of a stop-exit) resume at the rewound position.
    const rate = this.effectiveRate(deck) || 1;
    const posAtStart =
      deck.startTrackMs + (start - deck.startCtxTime) * 1000 * rate;
    const spanMs = block.beats * beatSec * 1000 * rate;
    const windowStartMs = Math.max(0, posAtStart - spanMs);
    const reversed = this.renderReversed(deck, windowStartMs, posAtStart);
    if (!reversed) return;
    try {
      src.stop(start);
    } catch {
      /* noop */
    }
    const rev = this.ctx.createBufferSource();
    rev.buffer = reversed;
    const revRate = block.peakRate ?? 2;
    rev.playbackRate.value = revRate;
    this.track(rev.playbackRate);
    rev.connect(deck.input);
    this.ownedSources.add(rev);
    deck.extraSources.add(rev);
    const revDur = reversed.duration / revRate;
    rev.start(start, 0);
    try {
      rev.stop(start + revDur);
    } catch {
      /* noop */
    }
    const isStopExitOut = recipe.family === "stop-exit" && deck.side === "A";
    if (isStopExitOut) {
      deck.stopAtCtx = start + revDur;
      this.after(start + revDur - this.ctx.currentTime, () => {
        if (deck.extraSources.has(rev)) deck.playing = false;
      });
    } else {
      this.createScheduledSource(deck, windowStartMs, start + revDur);
    }
  }

  private endDeckAt(
    deck: DeckState,
    src: AudioBufferSourceNode,
    endCtx: number,
  ): void {
    deck.stopAtCtx = endCtx + 0.02;
    try {
      src.stop(endCtx + 0.02);
    } catch {
      /* noop */
    }
  }

  /** Reverse-render a track-time window of the deck's buffer. */
  private renderReversed(
    deck: DeckState,
    startTrackMs: number,
    endTrackMs: number,
  ): AudioBuffer | null {
    const buffer = deck.currentBuffer;
    if (!buffer) return null;
    const startSec = this.trackMsToBufferSec(deck, startTrackMs);
    const endSec = this.trackMsToBufferSec(deck, endTrackMs);
    const startFrame = Math.max(0, Math.floor(startSec * buffer.sampleRate));
    const endFrame = Math.min(
      buffer.length,
      Math.ceil(endSec * buffer.sampleRate),
    );
    const frames = endFrame - startFrame;
    if (frames <= 0) return null;
    const out = this.ctx.createBuffer(
      buffer.numberOfChannels,
      frames,
      buffer.sampleRate,
    );
    for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
      const srcData = buffer.getChannelData(ch);
      const dstData = out.getChannelData(ch);
      for (let i = 0; i < frames; i += 1) {
        dstData[i] = srcData[endFrame - 1 - i];
      }
    }
    return out;
  }

  private scheduleScratchBlock(
    deck: DeckState,
    block: Extract<JoinRecipe["blocks"][number], { type: "scratch" }>,
    recipe: JoinRecipe,
    t0: number,
    beatSec: number,
  ): void {
    if (!deck.currentBuffer) return;
    const start = Math.max(this.ctx.currentTime, t0 + block.atBeat * beatSec);
    const dur = Math.max(0.05, block.beats * beatSec);
    const end = start + dur;

    // The main source hands over to a looped window source.
    if (deck.source) {
      try {
        deck.source.stop(start);
      } catch {
        /* noop */
      }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = deck.currentBuffer;
    src.loop = true;
    src.loopStart = this.trackMsToBufferSec(deck, block.windowStartMs);
    src.loopEnd = this.trackMsToBufferSec(deck, block.windowEndMs);
    src.connect(deck.input);
    this.track(src.playbackRate);
    this.ownedSources.add(src);
    deck.extraSources.add(src);

    // Hand strokes: alternating forward / return rate moves.
    const strokes = Math.max(2, Math.round(block.beats * 2));
    const strokeDur = dur / strokes;
    for (let i = 0; i < strokes; i += 1) {
      src.playbackRate.setValueAtTime(
        i % 2 === 0 ? 1.6 : 0.7,
        start + i * strokeDur,
      );
    }
    src.playbackRate.setValueAtTime(1, end);

    // Fader gate per technique (the audible signature).
    const gate = deck.scratchGate.gain;
    gate.setValueAtTime(1, start);
    if (block.technique === "chirp") {
      // Closed on forward strokes, open on returns.
      for (let s = 0; s + 1 < strokes; s += 2) {
        gate.setValueAtTime(0, start + s * strokeDur);
        gate.setValueAtTime(1, start + (s + 1) * strokeDur);
      }
    } else if (block.technique === "transformer") {
      // Rhythmic clicks at 4 per beat.
      const clicks = Math.max(2, Math.round(block.beats * 4));
      for (let k = 0; k < clicks; k += 1) {
        gate.setValueAtTime(k % 2 === 0 ? 0 : 1, start + (dur / clicks) * k);
      }
    } else if (block.technique === "flare") {
      // One short click per stroke pair.
      for (let s = 0; s + 1 < strokes; s += 2) {
        gate.setValueAtTime(0, start + s * strokeDur);
        gate.setValueAtTime(1, start + s * strokeDur + strokeDur * 0.25);
      }
    } else if (block.technique === "crab") {
      // Tapped bursts: three quick taps per stroke.
      for (let s = 0; s < strokes; s += 1) {
        for (let tap = 0; tap < 3; tap += 1) {
          const tapStart = start + s * strokeDur + (strokeDur / 3) * tap;
          gate.setValueAtTime(0, tapStart);
          gate.setValueAtTime(1, tapStart + strokeDur / 6);
        }
      }
    }
    // baby: gate stays open — the setValueAtTime(1, start) above
    // (plus the release below) is the whole pattern, by design.
    gate.setValueAtTime(1, end);

    src.start(start, src.loopStart);
    try {
      src.stop(end);
    } catch {
      /* noop */
    }

    // Resume the track after the window (scratch-in / mid-join
    // theatre), or leave the deck out (scratch-out on the outgoing).
    const resume = !(recipe.family === "scratch-out" && block.side === "A");
    if (resume) {
      this.createScheduledSource(deck, block.windowEndMs, end);
    } else {
      deck.stopAtCtx = end;
      this.after(end - this.ctx.currentTime, () => {
        if (deck.extraSources.has(src)) deck.playing = false;
      });
    }
  }

  private scheduleFxBlock(
    block: Extract<JoinRecipe["blocks"][number], { type: "fx" }>,
    t0: number,
    beatSec: number,
  ): void {
    const start = Math.max(this.ctx.currentTime, t0 + block.atBeat * beatSec);
    const dur = block.beats * beatSec;
    const end = start + dur;
    const params = block.params ?? {};
    const wet = clamp(params.wet ?? 0.5, 0, 1);

    if (block.kind === "gating") {
      // Scheduled gain pattern on the deck's fxGate (or, for the
      // tail bus, on the shared fx return).
      const target =
        block.side === "tail"
          ? this.fxReturn.gain
          : this.decks[block.side].fxGate.gain;
      const division = Math.max(1, Math.round(params.division ?? 4));
      const steps = Math.max(2, Math.round(block.beats * division));
      const low = clamp(params.low ?? 0, 0, 1);
      target.setValueAtTime(1, start);
      for (let k = 0; k < steps; k += 1) {
        target.setValueAtTime(k % 2 === 0 ? low : 1, start + (dur / steps) * k);
      }
      target.setValueAtTime(1, end);
      return;
    }

    const bus =
      block.side === "tail" ? this.tailBus : this.decks[block.side].fxBus;

    let chain: FxChain;
    if (block.kind === "slip-roll") {
      const sliceBeats = params.sliceBeats ?? 1;
      chain = this.buildSlipRollChain(
        sliceBeats * beatSec,
        params.feedback ?? 0.55,
      );
    } else {
      chain = this.buildFxChain(block.kind, params, beatSec);
    }
    this.ephemeralChains.add(chain);
    chain.output.connect(this.fxReturn);
    const send = this.newGain(0);
    bus.connect(send);
    send.connect(chain.input);
    chain.nodes.push(send);
    chain.params.push(send.gain);

    // Wet envelope: in fast, hold, out over a beat of tail (fx
    // tails may extend past the overlap — design §3.2).
    const sendTarget = block.kind === "slip-roll" ? (params.wet ?? 1) : wet;
    send.gain.setValueAtTime(0, start);
    send.gain.linearRampToValueAtTime(
      clamp(sendTarget, 0, 1),
      start + Math.min(0.1, dur / 4),
    );
    send.gain.setValueAtTime(clamp(sendTarget, 0, 1), end);
    send.gain.linearRampToValueAtTime(0, end + beatSec);

    if (block.kind === "spiral" && chain.spiralFeedback && chain.spiralFilter) {
      chain.spiralFeedback.gain.setValueAtTime(0.3, start);
      chain.spiralFeedback.gain.linearRampToValueAtTime(
        params.feedbackMax ?? 0.75,
        end,
      );
      chain.spiralFilter.frequency.setValueAtTime(
        params.freqStart ?? 800,
        start,
      );
      chain.spiralFilter.frequency.linearRampToValueAtTime(
        params.freqEnd ?? 4000,
        end,
      );
    }
    for (const osc of chain.oscs) {
      try {
        osc.start(start);
      } catch {
        /* noop */
      }
      try {
        osc.stop(end + beatSec);
      } catch {
        /* noop */
      }
    }
    this.after(end + beatSec + 1 - this.ctx.currentTime, () =>
      this.disposeChain(chain),
    );
  }

  // -- stopAll (the C4 requirement: total and immediate) --------------------

  stopAll(): void {
    const now = this.ctx.currentTime;
    for (const handle of this.timers) clearTimeout(handle);
    this.timers.clear();

    // Freeze positions before sources stop.
    for (const side of ["A", "B"] as const) {
      const deck = this.decks[side];
      if (deck.playing) deck.pausedMs = this.positionMs(side);
      deck.playing = false;
      deck.stopAtCtx = null;
      deck.generation += 1;
      this.stopSource(deck);
    }
    for (const src of this.ownedSources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* noop */
      }
    }
    for (const osc of this.ownedOscs) {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
      try {
        osc.disconnect();
      } catch {
        /* noop */
      }
    }
    // disposeChain deletes the chain from the set; deleting the
    // current element during Set iteration is well-defined.
    for (const chain of this.ephemeralChains) {
      this.disposeChain(chain);
    }
    for (const side of ["A", "B"] as const) {
      const deck = this.decks[side];
      for (const chain of deck.manualChains.values()) {
        this.disposeChain(chain);
      }
      deck.manualChains.clear();
      deck.fxSends.clear();
      if (deck.roll) {
        this.disposeChain(deck.roll.chain);
        deck.roll = null;
      }
    }
    // Cancel EVERY scheduled automation on EVERY owned param, then
    // silence the gains that carry audio.
    for (const param of this.ownedParams) {
      try {
        param.cancelScheduledValues(now);
      } catch {
        /* noop */
      }
    }
    const silence = (node: GainNode): void => {
      node.gain.setValueAtTime(0, now);
      node.gain.value = 0;
    };
    silence(this.master);
    silence(this.fxReturn);
    for (const side of ["A", "B"] as const) {
      const deck = this.decks[side];
      silence(deck.preGain);
      silence(deck.channelGain);
      silence(deck.crossfaderGain);
      silence(deck.fxBus);
      silence(deck.input);
    }
  }
}

export { ALL_FX_KINDS };
