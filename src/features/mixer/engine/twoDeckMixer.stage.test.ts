import { describe, expect, it } from "vitest";
import { flatCurve, OPEN_FILTER_HZ, type TransitionRecipe } from "./recipe";
import { crossfadeGains, TwoDeckMixer } from "./twoDeckMixer";

// The SESSION UNLOCK slice's mixer surface: crossfader curves, the
// lazy analyser taps and their meter summaries, the stage readings,
// and the manual stage's new hands (EQ / filter / FX assign+send).
// The fake is the fx suite's extended recording fake plus a
// FakeAnalyser whose creations the context COUNTS and whose
// time-domain data the test scripts.

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
class FakeAnalyser {
  fftSize = 0;
  /** The scripted time-domain pattern, tiled across any read window. */
  script: Float32Array;
  constructor(script: Float32Array) {
    this.script = script;
  }
  connect(): void {}
  getFloatTimeDomainData(array: Float32Array): void {
    if (this.script.length === 0) {
      array.fill(0);
      return;
    }
    for (let i = 0; i < array.length; i += 1) {
      array[i] = this.script[i % this.script.length];
    }
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
  analysers: FakeAnalyser[] = [];
  /** The time-domain pattern new analysers are born scripting. */
  analyserScript: Float32Array = new Float32Array(0);
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
  createAnalyser(): FakeAnalyser {
    const a = new FakeAnalyser(this.analyserScript);
    this.analysers.push(a);
    return a;
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

const buffer = (duration = 240): AudioBuffer =>
  ({ duration }) as unknown as AudioBuffer;

function flatEq() {
  return flatCurve("eq-gain", "decibels", 0);
}

/** A plain recipe (no fx, no blocks) — the laziness control case. */
function plainRecipe(): TransitionRecipe {
  return {
    version: 1,
    preset: "cut",
    overlap: {
      startAMs: 120_000,
      startBMs: 0,
      durationMs: 8000,
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
    fx: {},
    effects: [],
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
  gain: { gain: FakeParam };
  bass: { gain: FakeParam };
  mid: { gain: FakeParam };
  high: { gain: FakeParam };
  filter: { frequency: FakeParam };
  reverbSend: { gain: FakeParam };
  delaySend: { gain: FakeParam };
}
const asDeck = (deck: unknown): FakeDeck => deck as unknown as FakeDeck;

interface MixerInternals {
  trims: FakeGain[];
}
const internals = (mixer: TwoDeckMixer): MixerInternals =>
  mixer as unknown as MixerInternals;

/** The last setTargetAtTime value a trim gain was driven to. */
function lastTrimTarget(trim: FakeGain): number | undefined {
  const targets = trim.gain.events.filter((e) => e.type === "target");
  return targets[targets.length - 1]?.value as number | undefined;
}

describe("lazy analyser taps", () => {
  it("constructing a mixer and performing a plain recipe create NO analysers", () => {
    const { ctx, mixer } = newMixer();
    expect(ctx.analysers).toHaveLength(0);
    mixer.playNow(buffer());
    mixer.performRecipe(buffer(), plainRecipe(), {});
    expect(ctx.analysers).toHaveLength(0);
  });

  it("the first deckMeterSummary builds exactly one tap and reuses it; the master tap is separate", () => {
    const { ctx, mixer } = newMixer();
    ctx.analyserScript = new Float32Array([0.5]);
    const first = mixer.deckMeterSummary(0);
    expect(first).toEqual({ peak: 0.5, rms: 0.5 });
    expect(ctx.analysers).toHaveLength(1);
    expect(ctx.analysers[0].fftSize).toBe(2048);
    expect(mixer.deckAnalyser(0)).toBe(ctx.analysers[0]);
    mixer.deckMeterSummary(0);
    expect(ctx.analysers).toHaveLength(1);
    // The master tap is its own node, built on its own first ask.
    expect(mixer.masterMeterSummary()).toEqual({ peak: 0.5, rms: 0.5 });
    expect(ctx.analysers).toHaveLength(2);
    expect(mixer.masterAnalyser()).toBe(ctx.analysers[1]);
    mixer.masterMeterSummary();
    expect(ctx.analysers).toHaveLength(2);
  });

  it("meter math: peak is max |x| and rms is sqrt(mean x²), computed at call time", () => {
    const { ctx, mixer } = newMixer();
    ctx.analyserScript = new Float32Array([0.5]);
    expect(mixer.deckMeterSummary(0)).toEqual({ peak: 0.5, rms: 0.5 });
    const tap = ctx.analysers[0];
    tap.script = new Float32Array([1, -1]);
    expect(mixer.deckMeterSummary(0)).toEqual({ peak: 1, rms: 1 });
    tap.script = new Float32Array([0]);
    expect(mixer.deckMeterSummary(0)).toEqual({ peak: 0, rms: 0 });
    tap.script = new Float32Array([0.3, -0.4]);
    const mixed = mixer.deckMeterSummary(0);
    expect(mixed?.peak).toBeCloseTo(0.4, 6);
    expect(mixed?.rms).toBeCloseTo(Math.sqrt((0.09 + 0.16) / 2), 6);
  });
});

describe("stage readings", () => {
  it("stageDeckReadings after playNow: gain 1, flat EQ, open filter, rate 1", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    expect(mixer.stageDeckReadings(0)).toEqual({
      gainValue: 1,
      rateValue: 1,
      bassDb: 0,
      midDb: 0,
      highDb: 0,
      filterHz: 20_000,
    });
  });

  it("stageEffectReadings: an unbuilt network reports nulls; trans is always built with no levels", () => {
    const { mixer } = newMixer();
    expect(mixer.stageEffectReadings("reverb")).toEqual({
      built: false,
      wetLevel: null,
      sendLevels: { A: null, B: null },
    });
    expect(mixer.stageEffectReadings("trans")).toEqual({
      built: true,
      wetLevel: null,
      sendLevels: { A: null, B: null },
    });
  });
});

describe("manual setters — EQ and filter", () => {
  it("setDeckEq writes the band param and clamps to ±24 dB", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const deck = asDeck(mixer.currentDeck);
    mixer.setDeckEq(0, "bass", -12);
    expect(deck.bass.gain.value).toBe(-12);
    mixer.setDeckEq(0, "mid", 99);
    expect(deck.mid.gain.value).toBe(24);
    mixer.setDeckEq(0, "high", -99);
    expect(deck.high.gain.value).toBe(-24);
    // The readings see the grab.
    const readings = mixer.stageDeckReadings(0);
    expect(readings.bassDb).toBe(-12);
    expect(readings.midDb).toBe(24);
    expect(readings.highDb).toBe(-24);
  });

  it("setDeckFilter writes the cutoff and clamps to 20..20000 Hz", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const deck = asDeck(mixer.currentDeck);
    mixer.setDeckFilter(0, 500);
    expect(deck.filter.frequency.value).toBe(500);
    mixer.setDeckFilter(0, 5);
    expect(deck.filter.frequency.value).toBe(20);
    mixer.setDeckFilter(0, 99_999);
    expect(deck.filter.frequency.value).toBe(20_000);
  });
});

describe("crossfadeGains curves", () => {
  it("the centre is transparent under every curve", () => {
    expect(crossfadeGains(0, "smooth")).toEqual([1, 1]);
    expect(crossfadeGains(0, "constant-power")).toEqual([1, 1]);
    expect(crossfadeGains(0, "cut")).toEqual([1, 1]);
  });

  it("constant-power: the faded deck's gain is sqrt(1 − |p|), the leaned-to deck stays 1", () => {
    const [a, b] = crossfadeGains(0.5, "constant-power");
    expect(a).toBeCloseTo(Math.sqrt(0.5), 6);
    expect(b).toBe(1);
    const [c, d] = crossfadeGains(-0.5, "constant-power");
    expect(c).toBe(1);
    expect(d).toBeCloseTo(Math.sqrt(0.5), 6);
    expect(crossfadeGains(1, "constant-power")).toEqual([0, 1]);
    expect(crossfadeGains(-1, "constant-power")).toEqual([1, 0]);
  });

  it("cut: the faded deck holds 1 below |p| = 0.65 and steps to 0 at and past it", () => {
    expect(crossfadeGains(0.5, "cut")).toEqual([1, 1]);
    expect(crossfadeGains(0.64, "cut")).toEqual([1, 1]);
    expect(crossfadeGains(0.65, "cut")).toEqual([0, 1]);
    expect(crossfadeGains(0.8, "cut")).toEqual([0, 1]);
    expect(crossfadeGains(-0.8, "cut")).toEqual([1, 0]);
    expect(crossfadeGains(1, "cut")).toEqual([0, 1]);
  });

  it("smooth keeps the cosine law", () => {
    const [a, b] = crossfadeGains(0.5, "smooth");
    expect(a).toBeCloseTo(Math.cos(Math.PI / 4), 6);
    expect(b).toBe(1);
  });
});

describe("mixer crossfader-curve state", () => {
  it("defaults to smooth; setCrossfaderCurve re-runs the manual stage under the new law", () => {
    const { mixer } = newMixer();
    const [trimA] = internals(mixer).trims;
    expect(mixer.crossfaderCurveName()).toBe("smooth");

    // Cut at a full lean: the faded deck's trim is driven to exactly 0.
    mixer.setCrossfaderCurve("cut");
    expect(mixer.crossfaderCurveName()).toBe("cut");
    mixer.setCrossfade(1);
    expect(lastTrimTarget(trimA)).toBe(0);

    // At a 0.8 lean the laws part ways: cut holds the faded deck at
    // 0, smooth leaves it partial (cos(0.8 × π/2) ≈ 0.309). Switching
    // the curve alone re-applies the stage at the standing lean.
    mixer.setCrossfade(0.8);
    expect(lastTrimTarget(trimA)).toBe(0);
    mixer.setCrossfaderCurve("smooth");
    expect(lastTrimTarget(trimA)).toBeCloseTo(Math.cos(0.8 * (Math.PI / 2)), 6);
  });
});

describe("manual FX stage", () => {
  it("setManualFxSend builds the network, opens the send, and assigns the side", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const deckA = asDeck(mixer.currentDeck);
    expect(mixer.manualFxAssign("reverb")).toBeNull();

    mixer.setManualFxSend("reverb", "A", 0.5);
    expect(ctx.convolvers).toHaveLength(1);
    expect(deckA.reverbSend.gain.value).toBe(0.5);
    expect(mixer.manualFxAssign("reverb")).toBe("A");
    // The manual return sits at unity; the send is the level control.
    expect(mixer.stageEffectReadings("reverb")).toEqual({
      built: true,
      wetLevel: 1,
      sendLevels: { A: 0.5, B: 0 },
    });
  });

  it("setManualFxAssign re-applies both sides from the stored levels", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const deckA = asDeck(mixer.currentDeck);
    const deckB = asDeck(mixer.nextDeck);
    mixer.setManualFxSend("reverb", "A", 0.5);

    mixer.setManualFxAssign("reverb", null);
    expect(mixer.manualFxAssign("reverb")).toBeNull();
    expect(deckA.reverbSend.gain.value).toBe(0);

    // B has no stored level yet, so assigning B opens it at 0 — and
    // A's send stays closed.
    mixer.setManualFxAssign("reverb", "B");
    expect(mixer.manualFxAssign("reverb")).toBe("B");
    expect(deckB.reverbSend.gain.value).toBe(0);
    expect(deckA.reverbSend.gain.value).toBe(0);

    // A's stored 0.5 survived the detour: reassigning A restores it
    // and closes B.
    mixer.setManualFxAssign("reverb", "A");
    expect(deckA.reverbSend.gain.value).toBe(0.5);
    expect(deckB.reverbSend.gain.value).toBe(0);
  });

  it("sending on the other side extends the assign to both; levels clamp to 0..1", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const deckA = asDeck(mixer.currentDeck);
    const deckB = asDeck(mixer.nextDeck);
    mixer.setManualFxSend("delay", "B", 0.4);
    expect(mixer.manualFxAssign("delay")).toBe("B");
    expect(deckB.delaySend.gain.value).toBe(0.4);
    mixer.setManualFxSend("delay", "A", 2);
    expect(mixer.manualFxAssign("delay")).toBe("both");
    expect(deckA.delaySend.gain.value).toBe(1);
    expect(deckB.delaySend.gain.value).toBe(0.4);
  });

  it("trans records state only — no network is built and nothing is written", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    mixer.setManualFxSend("trans", "A", 0.7);
    expect(mixer.manualFxAssign("trans")).toBe("A");
    expect(ctx.convolvers).toHaveLength(0);
    expect(ctx.oscillators).toHaveLength(0);
    expect(ctx.shapers).toHaveLength(0);
    expect(mixer.stageEffectReadings("trans")).toEqual({
      built: true,
      wetLevel: null,
      sendLevels: { A: null, B: null },
    });
  });
});
