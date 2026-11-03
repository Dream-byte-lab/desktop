import { describe, expect, it } from "vitest";
import { flatCurve, OPEN_FILTER_HZ, type TransitionRecipe } from "./recipe";
import { TwoDeckMixer } from "./twoDeckMixer";

// The mixer's half of the DJ stage engine seams, against the
// stage suite's recording fake:
//   · the cue tap — lazy like every tap, built once, per deck,
//     distinct from the post-fader deck tap, and silent until read;
//   · per-deck loop regions — the same deck loop a recipe arms,
//     addressed by deck;
//   · the manual roll — the ONE roll network, tuned and opened
//     by hand, released with its tail ramped home;
//   · the assisted level's holds — a held EQ band / filter / FX
//     send is skipped by a performance's automation and by
//     playNow's neutralisations; everything unheld performs
//     exactly as before.

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
  analysers: FakeAnalyser[] = [];
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
    return new FakeConvolver();
  }
  createWaveShaper(): FakeWaveShaper {
    return new FakeWaveShaper();
  }
  createOscillator(): FakeOscillator {
    return new FakeOscillator();
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
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
}

const buffer = (duration = 240): AudioBuffer =>
  ({ duration }) as unknown as AudioBuffer;

function flatEq() {
  return flatCurve("eq-gain", "decibels", 0);
}

function eqCurve(toDb: number) {
  return {
    kind: "eq-gain" as const,
    unit: "decibels" as const,
    points: [
      { atMs: 0, value: 0, easing: "linear" as const },
      { atMs: 8000, value: toDb },
    ],
  };
}

/** A plain recipe whose outgoing EQ/filter curves actually move. */
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
      eqOut: { low: eqCurve(-12), mid: eqCurve(-6), high: flatEq() },
      eqIn: { low: flatEq(), mid: flatEq(), high: flatEq() },
      filterOut: {
        kind: "filter-cutoff" as const,
        unit: "hertz" as const,
        points: [
          { atMs: 0, value: OPEN_FILTER_HZ, easing: "linear" as const },
          { atMs: 8000, value: 400 },
        ],
      },
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

/** The plain recipe dressed with one A-side reverb block. */
function reverbBlockRecipe(): TransitionRecipe {
  const recipe = plainRecipe();
  recipe.fx = { reverb: { decaySec: 2, wet: 0.5 } };
  recipe.effects = [
    {
      kind: "reverb",
      side: "A",
      startMs: 120_000,
      endMs: 128_000,
      beats: 16,
      level: 0.6,
    },
  ];
  return recipe;
}

function newMixer(): { ctx: FakeContext; mixer: TwoDeckMixer } {
  const ctx = new FakeContext();
  const mixer = new TwoDeckMixer(ctx as unknown as AudioContext);
  return { ctx, mixer };
}

interface FakeDeck {
  bass: { gain: FakeParam };
  mid: { gain: FakeParam };
  high: { gain: FakeParam };
  filter: { frequency: FakeParam };
  reverbSend: { gain: FakeParam };
  rollSend: { gain: FakeParam };
}
interface MixerInternals {
  decks: [FakeDeck, FakeDeck];
  rollNet: { feedback: { gain: FakeParam }; wet: { gain: FakeParam } } | null;
}
const internals = (mixer: TwoDeckMixer): MixerInternals =>
  mixer as unknown as MixerInternals;

/** Automation events a performance scheduled at or after a time. */
function eventsFrom(param: FakeParam, time: number): ParamEvent[] {
  return param.events.filter((e) => e.time >= time);
}

describe("cue tap", () => {
  it("is lazy, built once per deck, and distinct from the deck tap", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    expect(ctx.analysers).toHaveLength(0);
    const cue = mixer.cueAnalyser(1);
    expect(cue).not.toBeNull();
    expect(ctx.analysers).toHaveLength(1);
    expect(mixer.cueAnalyser(1)).toBe(cue);
    expect(ctx.analysers).toHaveLength(1);
    // The post-fader deck tap is a separate node on the same deck.
    const deckTap = mixer.deckAnalyser(1);
    expect(deckTap).not.toBe(cue);
    expect(ctx.analysers).toHaveLength(2);
  });

  it("cueMeterSummary reads the cue tap's data at call time", () => {
    const { ctx, mixer } = newMixer();
    ctx.analyserScript = new Float32Array([0.5]);
    expect(mixer.cueMeterSummary(0)).toEqual({ peak: 0.5, rms: 0.5 });
  });
});

describe("per-deck loop regions", () => {
  it("setDeckLoopRegion arms the addressed deck's live source; clearDeckLoop disarms it", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const live = ctx.sources[ctx.sources.length - 1];
    mixer.setDeckLoopRegion(0, 10, 14);
    expect(live.loop).toBe(true);
    expect(live.loopStart).toBe(10);
    expect(live.loopEnd).toBe(14);
    mixer.clearDeckLoop(0);
    expect(live.loop).toBe(false);
  });
});

describe("manual roll", () => {
  it("opens the one roll network on the deck's send, at the authors' tuning", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const delaysBefore = ctx.delays.length;
    mixer.openDeckRoll(0, 0.5);
    // The roll network was built lazily for the hand (one delay).
    expect(ctx.delays.length).toBe(delaysBefore + 1);
    const deck = internals(mixer).decks[0];
    expect(deck.rollSend.gain.value).toBe(TwoDeckMixer.MANUAL_ROLL_LEVEL);
    expect(mixer.stageEffectReadings("roll").wetLevel).toBe(1);
    const net = internals(mixer).rollNet;
    expect(net?.feedback.gain.value).toBe(TwoDeckMixer.MANUAL_ROLL_FEEDBACK);
  });

  it("closeDeckRoll closes the send and ramps the tail home", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    mixer.openDeckRoll(0, 0.5);
    mixer.closeDeckRoll(0);
    const deck = internals(mixer).decks[0];
    expect(deck.rollSend.gain.value).toBe(0);
    const net = internals(mixer).rollNet;
    const feedbackRamps = net?.feedback.gain.events.filter(
      (e) => e.type === "ramp" && e.value === 0,
    );
    expect(feedbackRamps?.length).toBeGreaterThan(0);
  });
});

describe("assisted holds at the executor", () => {
  it("a held EQ band is not automated by a performance; its neighbours are", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    mixer.holdManualParam(0, { kind: "eq", band: "bass" });
    mixer.performRecipe(buffer(), plainRecipe(), {});
    const deck = internals(mixer).decks[0];
    // blendStart = 1000 (ctx) + 4 (leadIn) = 1004.
    expect(eventsFrom(deck.bass.gain, 1004)).toHaveLength(0);
    expect(eventsFrom(deck.mid.gain, 1004).length).toBeGreaterThan(0);
  });

  it("a held filter is not automated; unheld, the same performance sweeps it", () => {
    const heldRun = newMixer();
    heldRun.mixer.playNow(buffer());
    heldRun.mixer.holdManualParam(0, { kind: "filter" });
    heldRun.mixer.performRecipe(buffer(), plainRecipe(), {});
    expect(
      eventsFrom(internals(heldRun.mixer).decks[0].filter.frequency, 1004),
    ).toHaveLength(0);

    const freeRun = newMixer();
    freeRun.mixer.playNow(buffer());
    freeRun.mixer.performRecipe(buffer(), plainRecipe(), {});
    expect(
      eventsFrom(internals(freeRun.mixer).decks[0].filter.frequency, 1004)
        .length,
    ).toBeGreaterThan(0);
  });

  it("a held FX send skips its effect block; unheld, the block performs", () => {
    const heldRun = newMixer();
    heldRun.mixer.playNow(buffer());
    heldRun.mixer.holdManualParam(0, { kind: "send", effect: "reverb" });
    heldRun.mixer.performRecipe(buffer(), reverbBlockRecipe(), {});
    expect(
      eventsFrom(internals(heldRun.mixer).decks[0].reverbSend.gain, 1004),
    ).toHaveLength(0);

    const freeRun = newMixer();
    freeRun.mixer.playNow(buffer());
    freeRun.mixer.performRecipe(buffer(), reverbBlockRecipe(), {});
    expect(
      eventsFrom(internals(freeRun.mixer).decks[0].reverbSend.gain, 1004)
        .length,
    ).toBeGreaterThan(0);
  });

  it("playNow does not neutralise a held band or send; it neutralises the rest", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    mixer.setDeckEq(0, "bass", -9);
    mixer.setManualFxSend("reverb", "A", 0.7);
    mixer.holdManualParam(0, { kind: "eq", band: "bass" });
    mixer.holdManualParam(0, { kind: "send", effect: "reverb" });
    mixer.playNow(buffer());
    const deck = internals(mixer).decks[0];
    expect(deck.bass.gain.value).toBe(-9);
    expect(deck.reverbSend.gain.value).toBe(0.7);
    // The unheld mid band was flattened as always.
    expect(deck.mid.gain.value).toBe(0);
  });

  it("clearManualHolds restores full automation", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    mixer.holdManualParam(0, { kind: "eq", band: "bass" });
    expect(mixer.manualParamHeld(0, { kind: "eq", band: "bass" })).toBe(true);
    mixer.clearManualHolds();
    expect(mixer.manualParamHeld(0, { kind: "eq", band: "bass" })).toBe(false);
    mixer.performRecipe(buffer(), plainRecipe(), {});
    expect(
      eventsFrom(internals(mixer).decks[0].bass.gain, 1004).length,
    ).toBeGreaterThan(0);
  });
});
