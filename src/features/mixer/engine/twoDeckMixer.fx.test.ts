import { describe, expect, it } from "vitest";
import {
  flatCurve,
  OPEN_FILTER_HZ,
  type RecipeEffectBlock,
  type RecipeFx,
  type TransitionRecipe,
} from "./recipe";
import { TwoDeckMixer } from "./twoDeckMixer";

// The revamp's R3 — effects, performed. An EXTENDED recording fake
// (the R1/R2 fake plus the node factories only the lazy builders
// may touch: convolver, waveshaper, oscillator, buffer), so each
// effect's AUDIBLE signature is asserted on the reconstructed
// curves — a send envelope opens and closes, a gate dips and comes
// home, a captured slice circulates and dies — and a plain recipe
// is asserted to have built NOTHING and scheduled NOTHING new.

interface ParamEvent {
  type: "set" | "ramp" | "exp-ramp" | "curve" | "cancel" | "target";
  value: number | Float32Array;
  time: number;
  duration?: number;
}

class FakeParam {
  value = 0;
  events: ParamEvent[] = [];
  setValueAtTime(value: number, time: number): void {
    this.events.push({ type: "set", value, time });
    this.value = value;
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ type: "ramp", value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.events.push({ type: "exp-ramp", value, time });
  }
  setValueCurveAtTime(
    values: Float32Array,
    time: number,
    duration: number,
  ): void {
    this.events.push({ type: "curve", value: values, time, duration });
  }
  cancelScheduledValues(time: number): void {
    this.events.push({ type: "cancel", value: 0, time });
  }
  setTargetAtTime(value: number, time: number): void {
    this.events.push({ type: "target", value, time });
  }
}

class FakeGain {
  gain = new FakeParam();
  connect(): void {}
}
class FakeFilter {
  type = "";
  frequency = new FakeParam();
  gain = new FakeParam();
  Q = { value: 0 };
  connect(): void {}
}
class FakeDelay {
  delayTime = new FakeParam();
  connect(): void {}
}
class FakeConvolver {
  buffer: unknown = null;
  connect(): void {}
}
class FakeWaveShaper {
  curve: Float32Array | null = null;
  oversample = "none";
  connect(): void {}
}
class FakeOscillator {
  frequency = new FakeParam();
  type = "sine";
  started = false;
  connect(): void {}
  start(): void {
    this.started = true;
  }
}
class FakeAudioBuffer {
  channels: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
  }
  getChannelData(ch: number): Float32Array {
    return this.channels[ch];
  }
}
class FakeSource {
  buffer: unknown = null;
  playbackRate = new FakeParam();
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  startedWith: { when: number; offset: number } | null = null;
  stoppedAt: number | null = null;
  constructor() {
    this.playbackRate.value = 1;
  }
  connect(): void {}
  disconnect(): void {}
  start(when: number, offset: number): void {
    this.startedWith = { when, offset };
  }
  stop(when?: number): void {
    this.stoppedAt = when ?? 0;
  }
}
class FakeContext {
  currentTime = 1000;
  sampleRate = 48000;
  destination = {};
  sources: FakeSource[] = [];
  delays: FakeDelay[] = [];
  convolvers: FakeConvolver[] = [];
  shapers: FakeWaveShaper[] = [];
  oscillators: FakeOscillator[] = [];
  buffers: FakeAudioBuffer[] = [];
  createGain(): FakeGain {
    return new FakeGain();
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }
  createDelay(): FakeDelay {
    const d = new FakeDelay();
    this.delays.push(d);
    return d;
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createConvolver(): FakeConvolver {
    const c = new FakeConvolver();
    this.convolvers.push(c);
    return c;
  }
  createWaveShaper(): FakeWaveShaper {
    const s = new FakeWaveShaper();
    this.shapers.push(s);
    return s;
  }
  createOscillator(): FakeOscillator {
    const o = new FakeOscillator();
    this.oscillators.push(o);
    return o;
  }
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): FakeAudioBuffer {
    const b = new FakeAudioBuffer(channels, length, sampleRate);
    this.buffers.push(b);
    return b;
  }
}

/** The scratch suites' curve reconstruction, sorted first (see there). */
function paramAt(events: ParamEvent[], t: number): number {
  const ordered = [...events].sort((a, b) => a.time - b.time);
  let prevTime = -Infinity;
  let prevValue = 1;
  let value = 1;
  for (const e of ordered) {
    if (e.type === "curve" || e.type === "cancel" || e.type === "target") {
      continue;
    }
    const target = e.value as number;
    if (e.time > t) {
      if (prevTime === -Infinity) return prevValue;
      const span = e.time - prevTime;
      if (span <= 0) return target;
      const phase = (t - prevTime) / span;
      if (e.type === "ramp") return prevValue + (target - prevValue) * phase;
      if (e.type === "exp-ramp") {
        return prevValue * Math.pow(target / prevValue, phase);
      }
      return prevValue;
    }
    value = target;
    prevTime = e.time;
    prevValue = target;
  }
  return value;
}

const buffer = (duration = 240): AudioBuffer =>
  ({ duration }) as unknown as AudioBuffer;

function flatEq() {
  return flatCurve("eq-gain", "decibels", 0);
}

/** A rate-1 recipe at 120 BPM, anchored at A=120 s / B=0, lead-in 4 s. */
function fxRecipe(
  fx: RecipeFx,
  effects: RecipeEffectBlock[],
  durationMs = 8000,
): TransitionRecipe {
  return {
    version: 1,
    preset: "cut",
    overlap: {
      startAMs: 120_000,
      startBMs: 0,
      durationMs,
      durationBars: 4,
      beatmatched: false,
      rateA: 1,
      rateB: 1,
      stretchB: null,
      bpmA: 120,
      bpmB: 120,
    },
    leadInSec: 4,
    automation: {
      volumeOut: flatCurve("linear-gain", "linear", 1),
      volumeIn: flatCurve("linear-gain", "linear", 1),
      eqOut: { low: flatEq(), mid: flatEq(), high: flatEq() },
      eqIn: { low: flatEq(), mid: flatEq(), high: flatEq() },
      filterOut: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      filterIn: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      rateB: flatCurve("rate", "ratio", 1),
      echoSendOut: flatCurve("dry-wet", "percent", 0),
      echoSendIn: flatCurve("dry-wet", "percent", 0),
    },
    loops: [],
    fx,
    effects,
    fingerprints: { aAudioHash: null, bAudioHash: null, analysisVersion: null },
    fallback: { kind: "cut", note: "test fallback" },
    evidence: {
      entryReason: "test",
      exitReason: "test",
      vocalOverlap: 0,
      vocalEvidence: "trusted",
      tempoStretch: 0,
      keyScore: null,
      refereeShortened: false,
    },
  };
}

function newMixer(): { ctx: FakeContext; mixer: TwoDeckMixer } {
  const ctx = new FakeContext();
  const mixer = new TwoDeckMixer(ctx as unknown as AudioContext);
  return { ctx, mixer };
}

interface FakeDeck {
  fxGate: { gain: FakeParam };
  reverbSend: { gain: FakeParam };
  delaySend: { gain: FakeParam };
  flangerSend: { gain: FakeParam };
  phaserSend: { gain: FakeParam };
  distortionSend: { gain: FakeParam };
  spiralSend: { gain: FakeParam };
  rollSend: { gain: FakeParam };
}
const asDeck = (deck: unknown): FakeDeck => deck as unknown as FakeDeck;

interface MixerInternals {
  reverbNet: {
    convolver: FakeConvolver;
    wet: FakeGain;
    builtDecaySec: number;
  } | null;
  delayNet: { delay: FakeDelay; feedback: FakeGain; wet: FakeGain } | null;
  spiralNet: { delay: FakeDelay; feedback: FakeGain; wet: FakeGain } | null;
  flangerNet: {
    delay: FakeDelay;
    feedback: FakeGain;
    wet: FakeGain;
    osc: FakeOscillator;
    depthGain: FakeGain;
  } | null;
  phaserNet: {
    filters: FakeFilter[];
    centres: number[];
    wet: FakeGain;
    osc: FakeOscillator;
    depthGains: FakeGain[];
  } | null;
  distortionNet: {
    drive: FakeGain;
    shaper: FakeWaveShaper;
    wet: FakeGain;
  } | null;
  rollNet: { delay: FakeDelay; feedback: FakeGain; wet: FakeGain } | null;
  cascadeGain: FakeGain;
  cascadeWired: boolean;
}
const internals = (mixer: TwoDeckMixer): MixerInternals =>
  mixer as unknown as MixerInternals;

// The blend starts at ctx 1004 (currentTime 1000 + lead-in 4). An
// A block at its anchor (120 s) and a B block at its anchor (0)
// both open at 1004; a 2 s block closes at 1006.
const START = 1004;
const END = 1006;

describe("performRecipe — R3 effects", () => {
  it("reverb: the convolver is built, its IR is decay × sampleRate long, and the send opens and closes", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const out = asDeck(mixer.currentDeck);
    const recipe = fxRecipe({ reverb: { decaySec: 2, wet: 0.4 } }, [
      {
        kind: "reverb",
        side: "A",
        startMs: 120_000,
        endMs: 122_000,
        beats: 4,
        level: 0.8,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    expect(ctx.convolvers).toHaveLength(1);
    const ir = ctx.convolvers[0].buffer as FakeAudioBuffer;
    expect(ir.length).toBe(2 * 48000);
    expect(ir.getChannelData(0)).toHaveLength(96000);
    const net = internals(mixer).reverbNet;
    expect(net?.wet.gain.events).toContainEqual({
      type: "set",
      value: 0.4,
      time: START,
    });
    const send = out.reverbSend.gain.events;
    expect(paramAt(send, START)).toBeCloseTo(0, 6);
    // Reverb's attack is min(0.5, 0.25 × duration) = 0.5 s here.
    expect(paramAt(send, START + 0.5)).toBeCloseTo(0.8, 6);
    expect(paramAt(send, START + 1)).toBeCloseTo(0.8, 6);
    expect(paramAt(send, END)).toBeCloseTo(0, 6);
  });

  it("delay: the network is retuned at blendStart and the send carries the window", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const incoming = asDeck(mixer.nextDeck);
    const recipe = fxRecipe(
      { delay: { delaySec: 0.375, feedback: 0.4, wet: 0.5 } },
      [
        {
          kind: "delay",
          side: "B",
          startMs: 0,
          endMs: 2000,
          beats: 4,
          level: 0.7,
        },
      ],
    );
    mixer.performRecipe(buffer(), recipe, {});

    const net = internals(mixer).delayNet;
    expect(net?.delay.delayTime.events).toContainEqual({
      type: "set",
      value: 0.375,
      time: START,
    });
    expect(net?.feedback.gain.events).toContainEqual({
      type: "set",
      value: 0.4,
      time: START,
    });
    expect(net?.wet.gain.events).toContainEqual({
      type: "set",
      value: 0.5,
      time: START,
    });
    const send = incoming.delaySend.gain.events;
    expect(paramAt(send, START)).toBeCloseTo(0, 6);
    expect(paramAt(send, START + 0.1)).toBeCloseTo(0.7, 6);
    expect(paramAt(send, START + 1)).toBeCloseTo(0.7, 6);
    expect(paramAt(send, END)).toBeCloseTo(0, 6);
  });

  it("spiral: the delay time is set at the window's start and sweeps exponentially to delaySec × ratio", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const out = asDeck(mixer.currentDeck);
    const recipe = fxRecipe(
      {
        spiral: { delaySec: 0.5, sweepToRatio: 0.5, feedback: 0.3, wet: 0.6 },
      },
      [
        {
          kind: "spiral",
          side: "A",
          startMs: 120_000,
          endMs: 122_000,
          beats: 4,
          level: 0.9,
        },
      ],
    );
    mixer.performRecipe(buffer(), recipe, {});

    const net = internals(mixer).spiralNet;
    expect(net?.delay.delayTime.events).toContainEqual({
      type: "set",
      value: 0.5,
      time: START,
    });
    expect(net?.delay.delayTime.events).toContainEqual({
      type: "exp-ramp",
      value: 0.25,
      time: END,
    });
    expect(net?.feedback.gain.events).toContainEqual({
      type: "set",
      value: 0.3,
      time: START,
    });
    expect(net?.wet.gain.events).toContainEqual({
      type: "set",
      value: 0.6,
      time: START,
    });
    const send = out.spiralSend.gain.events;
    expect(paramAt(send, START + 1)).toBeCloseTo(0.9, 6);
    expect(paramAt(send, END)).toBeCloseTo(0, 6);
  });

  it("flanger: the oscillator starts at the config's rate and the send carries the window", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const incoming = asDeck(mixer.nextDeck);
    const recipe = fxRecipe(
      { flanger: { rateHz: 2, depthMs: 2, feedback: 0.3, wet: 0.5 } },
      [
        {
          kind: "flanger",
          side: "B",
          startMs: 0,
          endMs: 2000,
          beats: 4,
          level: 0.6,
        },
      ],
    );
    mixer.performRecipe(buffer(), recipe, {});

    expect(ctx.oscillators).toHaveLength(1);
    expect(ctx.oscillators[0].started).toBe(true);
    const net = internals(mixer).flangerNet;
    expect(net?.osc.frequency.events).toContainEqual({
      type: "set",
      value: 2,
      time: START,
    });
    expect(net?.depthGain.gain.events).toContainEqual({
      type: "set",
      value: 0.002,
      time: START,
    });
    const send = incoming.flangerSend.gain.events;
    expect(paramAt(send, START + 1)).toBeCloseTo(0.6, 6);
    expect(paramAt(send, END)).toBeCloseTo(0, 6);
  });

  it("phaser: four allpass filters sweep under one oscillator, and the send carries the window", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const out = asDeck(mixer.currentDeck);
    const recipe = fxRecipe({ phaser: { rateHz: 1.5, depth: 0.8, wet: 0.5 } }, [
      {
        kind: "phaser",
        side: "A",
        startMs: 120_000,
        endMs: 122_000,
        beats: 4,
        level: 0.7,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    const net = internals(mixer).phaserNet;
    expect(net?.filters).toHaveLength(4);
    for (const f of net?.filters ?? []) expect(f.type).toBe("allpass");
    expect(net?.osc.frequency.events).toContainEqual({
      type: "set",
      value: 1.5,
      time: START,
    });
    // Depth mapping: centre × depth × 0.75 = centre × 0.6 here.
    expect(net?.depthGains[0].gain.events).toContainEqual({
      type: "set",
      value: 240,
      time: START,
    });
    expect(net?.depthGains[3].gain.events).toContainEqual({
      type: "set",
      value: 1920,
      time: START,
    });
    const send = out.phaserSend.gain.events;
    expect(paramAt(send, START + 1)).toBeCloseTo(0.7, 6);
    expect(paramAt(send, END)).toBeCloseTo(0, 6);
  });

  it("distortion: the shaper carries a non-identity 1024-point curve and the send carries the window", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const incoming = asDeck(mixer.nextDeck);
    const recipe = fxRecipe({ distortion: { amount: 0.7, wet: 0.5 } }, [
      {
        kind: "distortion",
        side: "B",
        startMs: 0,
        endMs: 2000,
        beats: 4,
        level: 0.6,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    expect(ctx.shapers).toHaveLength(1);
    expect(ctx.shapers[0].oversample).toBe("2x");
    const curve = ctx.shapers[0].curve;
    expect(curve).not.toBeNull();
    expect(curve).toHaveLength(1024);
    // Non-identity: at x ≈ 0.5 the saturated curve sits far above x.
    const mid = Math.round(0.75 * 1023);
    expect(curve?.[mid]).toBeGreaterThan(0.9);
    const net = internals(mixer).distortionNet;
    expect(net?.drive.gain.events).toContainEqual({
      type: "set",
      value: 1 + 0.7 * 12,
      time: START,
    });
    expect(net?.wet.gain.events).toContainEqual({
      type: "set",
      value: 0.5,
      time: START,
    });
    const send = incoming.distortionSend.gain.events;
    expect(paramAt(send, START + 1)).toBeCloseTo(0.6, 6);
    expect(paramAt(send, END)).toBeCloseTo(0, 6);
  });

  it("trans: the fx gate dips to 1 − depth at the division rhythm and is exactly 1 at the window's end", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const out = asDeck(mixer.currentDeck);
    const recipe = fxRecipe({ trans: { divisionBeats: 1, depth: 0.8 } }, [
      {
        kind: "trans",
        side: "A",
        startMs: 120_000,
        endMs: 122_000,
        beats: 4,
        level: 1,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    // At 120 BPM a 1-beat division is a 0.5 s cycle: dip in the
    // first half, home in the second.
    const gate = out.fxGate.gain.events;
    expect(paramAt(gate, START)).toBeCloseTo(1, 6);
    expect(paramAt(gate, START + 0.125)).toBeCloseTo(0.2, 6);
    expect(paramAt(gate, START + 0.375)).toBeCloseTo(1, 6);
    expect(paramAt(gate, START + 0.625)).toBeCloseTo(0.2, 6);
    expect(paramAt(gate, END)).toBeCloseTo(1, 6);
  });

  it("roll: a slice is captured, the send closes one slice later, and the tail dies at the window's end", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const incoming = asDeck(mixer.nextDeck);
    const recipe = fxRecipe({ roll: { sliceBeats: 0.5, feedback: 0.9 } }, [
      {
        kind: "roll",
        side: "B",
        startMs: 0,
        endMs: 2000,
        beats: 4,
        level: 0.8,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    const net = internals(mixer).rollNet;
    // sliceSec = 0.5 beats × (60/120) = 0.25 s.
    expect(net?.delay.delayTime.events).toContainEqual({
      type: "set",
      value: 0.25,
      time: START,
    });
    expect(net?.feedback.gain.events).toContainEqual({
      type: "set",
      value: 0.9,
      time: START,
    });
    expect(net?.wet.gain.events).toContainEqual({
      type: "set",
      value: 1,
      time: START,
    });
    const send = incoming.rollSend.gain.events;
    expect(paramAt(send, START + 0.1)).toBeCloseTo(0.8, 6);
    // Capture closed: one slice (plus the closing ramp) later the
    // send is silent while the slice circulates alone.
    expect(paramAt(send, START + 0.26)).toBeCloseTo(0, 6);
    // The tail dies inside the recipe.
    expect(paramAt(net?.feedback.gain.events ?? [], END)).toBeCloseTo(0, 6);
    expect(paramAt(net?.wet.gain.events ?? [], END)).toBeCloseTo(0, 6);
  });

  it("chain: delay into reverb sets the cascade gain to 0.6 at blendStart", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = fxRecipe(
      {
        delay: { delaySec: 0.375, feedback: 0.4, wet: 0.5 },
        reverb: { decaySec: 2, wet: 0.4 },
        chainDelayIntoReverb: true,
      },
      [],
    );
    mixer.performRecipe(buffer(), recipe, {});

    const m = internals(mixer);
    expect(m.delayNet).not.toBeNull();
    expect(m.reverbNet).not.toBeNull();
    expect(m.cascadeWired).toBe(true);
    expect(m.cascadeGain.gain.events).toContainEqual({
      type: "set",
      value: 0.6,
      time: START,
    });
  });

  it("a PLAIN recipe builds nothing and schedules nothing on any new send or gate", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const incoming = asDeck(mixer.nextDeck);
    const recipe = fxRecipe({}, []);
    mixer.performRecipe(buffer(), recipe, {});

    expect(ctx.convolvers).toHaveLength(0);
    expect(ctx.oscillators).toHaveLength(0);
    expect(ctx.shapers).toHaveLength(0);
    expect(ctx.buffers).toHaveLength(0);
    for (const param of [
      incoming.fxGate.gain,
      incoming.reverbSend.gain,
      incoming.delaySend.gain,
      incoming.flangerSend.gain,
      incoming.phaserSend.gain,
      incoming.distortionSend.gain,
      incoming.spiralSend.gain,
      incoming.rollSend.gain,
    ]) {
      expect(param.events).toEqual([]);
    }
  });

  it("playNow neutralises a deck an fx performance used: sends to 0, gate home, cascade closed", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = fxRecipe(
      { delay: { delaySec: 0.375, feedback: 0.4, wet: 0.5 } },
      [
        {
          kind: "delay",
          side: "B",
          startMs: 0,
          endMs: 2000,
          beats: 4,
          level: 0.7,
        },
      ],
    );
    mixer.performRecipe(buffer(), recipe, {});
    // The incoming deck is now current; a plain start on it must
    // leave nothing of the performance behind.
    const deck = asDeck(mixer.currentDeck);
    mixer.playNow(buffer());
    for (const param of [
      deck.reverbSend.gain,
      deck.delaySend.gain,
      deck.flangerSend.gain,
      deck.phaserSend.gain,
      deck.distortionSend.gain,
      deck.spiralSend.gain,
      deck.rollSend.gain,
    ]) {
      expect(param.events).toContainEqual({
        type: "set",
        value: 0,
        time: 1000,
      });
    }
    expect(deck.fxGate.gain.events).toContainEqual({
      type: "set",
      value: 1,
      time: 1000,
    });
    expect(internals(mixer).cascadeGain.gain.events).toContainEqual({
      type: "set",
      value: 0,
      time: 1000,
    });
  });

  it("the referee clamp: a block authored past the performed overlap is back to 0 by blendEnd", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const out = asDeck(mixer.currentDeck);
    // The performed overlap is only 0.5 s; the block was authored
    // for 4 s starting at the overlap's head. The clamp cuts its
    // envelope at the performed end (1004.5), not the authored one.
    const recipe = fxRecipe(
      { delay: { delaySec: 0.375, feedback: 0.4, wet: 0.5 } },
      [
        {
          kind: "delay",
          side: "A",
          startMs: 120_000,
          endMs: 124_000,
          beats: 8,
          level: 0.7,
        },
      ],
      500,
    );
    const times = mixer.performRecipe(buffer(), recipe, {});
    expect(times.blendEndCtxTime).toBeCloseTo(1004.5, 6);
    const send = out.delaySend.gain.events;
    expect(paramAt(send, START + 0.25)).toBeCloseTo(0.7, 6);
    expect(paramAt(send, 1004.5)).toBeCloseTo(0, 6);
    for (const e of send) expect(e.time).toBeLessThanOrEqual(1004.5);
  });

  it("an A-side block with NO A anchor falls back — never a guessed position (the jog guard, extended)", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const out = asDeck(mixer.currentDeck);
    const recipe = fxRecipe({ reverb: { decaySec: 2, wet: 0.4 } }, [
      {
        kind: "reverb",
        side: "A",
        startMs: 120_000,
        endMs: 122_000,
        beats: 4,
        level: 0.8,
      },
    ]);
    recipe.overlap.startAMs = null;
    // playNow's neutralisation already wrote its resting 0 on this
    // send; the performance must add NOTHING to it.
    const eventsBefore = out.reverbSend.gain.events.length;
    const times = mixer.performRecipe(buffer(), recipe, {});
    // The fallback cut's signature: start and end are one instant,
    // no network was built, and the performance never moved a send.
    expect(times.blendEndCtxTime).toBe(times.blendStartCtxTime);
    expect(ctx.convolvers).toHaveLength(0);
    expect(out.reverbSend.gain.events).toHaveLength(eventsBefore);
  });
});
