// performer.test.ts — LiveRavePerformer against a hand-written
// FakeAudioContext. No real audio, no real timers: the fake clock
// only moves when a test advances it, nodes record their
// connections, and params record every automation call with times.

import { describe, expect, it } from "vitest";
import { buildTrackFacts, type TrackRead } from "./facts";
import {
  LiveRavePerformer,
  SoundTouchRenditionProvider,
  type RenditionProvider,
} from "./performer";
import type { JoinRecipe } from "./recipe";

// ---------------------------------------------------------------------
// Fake Web Audio
// ---------------------------------------------------------------------

interface ParamEvent {
  type: string;
  value: number;
  time: number;
}

class FakeParam {
  value: number;
  events: ParamEvent[] = [];
  constructor(value = 0) {
    this.value = value;
  }
  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: "setValue", value, time });
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: "linearRamp", value, time });
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: "exponentialRamp", value, time });
    this.value = value;
    return this;
  }
  setValueCurveAtTime(
    values: Float32Array,
    time: number,
    duration: number,
  ): this {
    this.events.push({
      type: "setValueCurve",
      value: values[0] ?? 0,
      time,
    });
    void duration;
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ type: "cancel", value: 0, time });
    return this;
  }
  setTargetAtTime(value: number, time: number): this {
    this.events.push({ type: "setTarget", value, time });
    this.value = value;
    return this;
  }
}

class FakeNode {
  connections: unknown[] = [];
  disconnected = false;
  connect(dest: unknown): unknown {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}
class FakeBiquad extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam(350);
  gain = new FakeParam(0);
  Q = new FakeParam(1);
}
class FakeBufferSource extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  playbackRate = new FakeParam(1);
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  startCalls: { when: number; offset: number }[] = [];
  stopCalls: (number | undefined)[] = [];
  start(when = 0, offset = 0): void {
    this.startCalls.push({ when, offset });
  }
  stop(when?: number): void {
    this.stopCalls.push(when);
  }
}
class FakeConvolver extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
}
class FakeDelay extends FakeNode {
  delayTime = new FakeParam(0);
}
class FakeWaveShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample = "none";
}
class FakeOscillator extends FakeNode {
  type = "sine";
  frequency = new FakeParam(440);
  detune = new FakeParam(0);
  startCalls: number[] = [];
  stopCalls: (number | undefined)[] = [];
  start(when = 0): void {
    this.startCalls.push(when);
  }
  stop(when?: number): void {
    this.stopCalls.push(when);
  }
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
}

class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private readonly data: Float32Array[];
  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = Array.from(
      { length: channels },
      () => new Float32Array(length),
    );
  }
  getChannelData(channel: number): Float32Array {
    return this.data[channel];
  }
}

class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = "running";
  resumeCalls = 0;
  sampleRate = 48_000;
  destination = new FakeNode();
  gains: FakeGain[] = [];
  biquads: FakeBiquad[] = [];
  sources: FakeBufferSource[] = [];
  convolvers: FakeConvolver[] = [];
  delays: FakeDelay[] = [];
  shapers: FakeWaveShaper[] = [];
  oscillators: FakeOscillator[] = [];
  analysers: FakeAnalyser[] = [];

  advance(sec: number): void {
    this.currentTime += sec;
  }
  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = "running";
  }
  createGain(): GainNode {
    const node = new FakeGain();
    this.gains.push(node);
    return node as unknown as GainNode;
  }
  createBiquadFilter(): BiquadFilterNode {
    const node = new FakeBiquad();
    this.biquads.push(node);
    return node as unknown as BiquadFilterNode;
  }
  createBufferSource(): AudioBufferSourceNode {
    const node = new FakeBufferSource();
    this.sources.push(node);
    return node as unknown as AudioBufferSourceNode;
  }
  createConvolver(): ConvolverNode {
    const node = new FakeConvolver();
    this.convolvers.push(node);
    return node as unknown as ConvolverNode;
  }
  createDelay(): DelayNode {
    const node = new FakeDelay();
    this.delays.push(node);
    return node as unknown as DelayNode;
  }
  createWaveShaper(): WaveShaperNode {
    const node = new FakeWaveShaper();
    this.shapers.push(node);
    return node as unknown as WaveShaperNode;
  }
  createOscillator(): OscillatorNode {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node as unknown as OscillatorNode;
  }
  createAnalyser(): AnalyserNode {
    const node = new FakeAnalyser();
    this.analysers.push(node);
    return node as unknown as AnalyserNode;
  }
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): AudioBuffer {
    return new FakeAudioBuffer(
      channels,
      length,
      sampleRate,
    ) as unknown as AudioBuffer;
  }
}

function allParams(ctx: FakeAudioContext): FakeParam[] {
  const params: FakeParam[] = [];
  for (const g of ctx.gains) params.push(g.gain);
  for (const b of ctx.biquads) params.push(b.frequency, b.gain, b.Q);
  for (const s of ctx.sources) params.push(s.playbackRate);
  for (const d of ctx.delays) params.push(d.delayTime);
  for (const o of ctx.oscillators) params.push(o.frequency, o.detune);
  return params;
}

/** Walk a deck chain: input → scratchGate → preGain → eqLow → … */
function chainNode(source: FakeBufferSource, hops: number): FakeNode {
  let node = source.connections[0] as FakeNode;
  for (let i = 0; i < hops; i += 1) {
    node = node.connections[0] as FakeNode;
  }
  return node;
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

function factsFor(id: string) {
  const read: TrackRead = {
    audioHash: `hash-${id}`,
    analysisVersion: 1,
    depth: "deep",
    durationSec: 240,
    bpm: 120,
    tempoConfidence: 0.9,
    grid: {
      beatsMs: Array.from({ length: 481 }, (_, i) => i * 500),
      downbeatsMs: Array.from({ length: 121 }, (_, i) => i * 2000),
      beatsPerBar: 4,
      confidence: 0.9,
    },
    key: null,
    sections: [],
    energyCurvePerSec: [],
    energyContour: [],
    vocalActivity: [],
    drops: [],
    loudnessRms: 0.2,
  };
  return buildTrackFacts(id, read, 240_000);
}

function makeBuffer(ctx: FakeAudioContext, seconds = 10): AudioBuffer {
  const buffer = ctx.createBuffer(2, 48_000 * seconds, 48_000);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.sin(i / 50) * 0.4;
    }
  }
  return buffer;
}

function loadBoth(performer: LiveRavePerformer, ctx: FakeAudioContext): void {
  performer.loadDeck("A", {
    trackId: "a",
    buffer: makeBuffer(ctx),
    facts: factsFor("a"),
  });
  performer.loadDeck("B", {
    trackId: "b",
    buffer: makeBuffer(ctx),
    facts: factsFor("b"),
  });
}

function baseRecipe(overrides: Partial<JoinRecipe> = {}): JoinRecipe {
  return {
    id: "join-1",
    family: "blend",
    outgoing: {
      trackId: "a",
      audioHash: "hash-a",
      exitAnchorMs: 180_000,
      exitBeat: 360,
    },
    incoming: {
      trackId: "b",
      audioHash: "hash-b",
      entryAnchorMs: 8_000,
      entryBeat: 16,
    },
    overlapBeats: 32,
    rates: { rateA: 1, rateB: 1, beatmatched: false },
    curves: {
      gainA: [
        { atBeat: 0, value: 1 },
        { atBeat: 32, value: 0 },
      ],
      gainB: [
        { atBeat: 0, value: 0 },
        { atBeat: 32, value: 1 },
      ],
      eqA: {
        low: [
          { atBeat: 0, value: 1 },
          { atBeat: 16, value: 0.2 },
        ],
        mid: [{ atBeat: 0, value: 1 }],
        high: [{ atBeat: 0, value: 1 }],
      },
      eqB: {
        low: [
          { atBeat: 0, value: 0.2 },
          { atBeat: 16, value: 1 },
        ],
        mid: [{ atBeat: 0, value: 1 }],
        high: [{ atBeat: 0, value: 1 }],
      },
      filterA: [{ atBeat: 0, value: 20_000 }],
      filterB: [{ atBeat: 0, value: 20_000 }],
    },
    blocks: [],
    authored: { evidence: { tempoFit: 0.9 }, notes: [] },
    ...overrides,
  };
}

function newPerformer(ctx: FakeAudioContext): LiveRavePerformer {
  return new LiveRavePerformer(ctx as unknown as AudioContext);
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("LiveRavePerformer — blend recipe", () => {
  it("schedules gain curves on both decks, crosses the EQ swap, starts B at the entry anchor", async () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);

    await performer.performRecipe(baseRecipe(), { startInSec: 1 });

    // Sources: A started first, then B at t0 = 1 s, offset 8 s.
    expect(ctx.sources.length).toBeGreaterThanOrEqual(2);
    const bSource = ctx.sources[1];
    expect(bSource.startCalls).toHaveLength(1);
    expect(bSource.startCalls[0].when).toBeCloseTo(1);
    expect(bSource.startCalls[0].offset).toBeCloseTo(8);

    // Gain curves: A preGain (chain hop 2) falls 1 → 0 across the
    // 32-beat (16 s) overlap; B's rises 0 → 1. Dense sampling means
    // well over 100 scheduled points per curve.
    const aPreGain = chainNode(ctx.sources[0], 2) as FakeGain;
    const bPreGain = chainNode(bSource, 2) as FakeGain;
    expect(aPreGain.gain.events.length).toBeGreaterThan(100);
    expect(aPreGain.gain.events[0].value).toBeCloseTo(1);
    expect(aPreGain.gain.events.at(-1)?.value).toBeCloseTo(0);
    expect(bPreGain.gain.events[0].value).toBeCloseTo(0);
    expect(bPreGain.gain.events.at(-1)?.value).toBeCloseTo(1);

    // EQ swap crossing at the middle (beat 16 = t0 + 8 s): A's low
    // goes 0 dB → ≈ -14 dB (multiplier 0.2), B's low the reverse.
    const aEqLow = chainNode(ctx.sources[0], 3) as FakeBiquad;
    const bEqLow = chainNode(bSource, 3) as FakeBiquad;
    const aMid = aEqLow.gain.events.find((e) => Math.abs(e.time - 9) < 0.01);
    const bMid = bEqLow.gain.events.find((e) => Math.abs(e.time - 9) < 0.01);
    expect(aMid?.value).toBeCloseTo(-13.98, 1);
    expect(bMid?.value).toBeCloseTo(0);
    expect(aEqLow.gain.events[0].value).toBeCloseTo(0);
    expect(bEqLow.gain.events[0].value).toBeCloseTo(-13.98, 1);
  });
});

describe("LiveRavePerformer — scratch gate patterns", () => {
  async function gateEventsFor(
    technique: "baby" | "chirp" | "transformer" | "flare" | "crab",
  ): Promise<ParamEvent[]> {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    const recipe = baseRecipe({
      family: "scratch-in",
      blocks: [
        {
          type: "scratch",
          side: "B",
          technique,
          atBeat: 0,
          beats: 4,
          windowStartMs: 8_000,
          windowEndMs: 10_000,
        },
      ],
    });
    await performer.performRecipe(recipe, { startInSec: 0.5 });
    const scratchSource = ctx.sources.find(
      (s) => s.loop && Math.abs(s.loopStart - 8) < 1e-9,
    );
    expect(scratchSource).toBeDefined();
    expect(scratchSource?.loopEnd).toBeCloseTo(10);
    // input (hop 0) → scratchGate (hop 1).
    const gate = chainNode(scratchSource as FakeBufferSource, 1) as FakeGain;
    return gate.gain.events;
  }

  it("baby keeps the gate open; chirp/transformer/flare/crab pattern it", async () => {
    const baby = await gateEventsFor("baby");
    const chirp = await gateEventsFor("chirp");
    const transformer = await gateEventsFor("transformer");
    const flare = await gateEventsFor("flare");
    const crab = await gateEventsFor("crab");
    // Baby: open at start, still open at end — nothing else.
    expect(baby).toHaveLength(2);
    expect(baby.every((e) => e.value === 1)).toBe(true);
    // Chirp closes/opens per stroke pair: strictly more gate events.
    expect(chirp.length).toBeGreaterThan(baby.length);
    expect(chirp.some((e) => e.value === 0)).toBe(true);
    // Each technique's pattern is its own.
    expect(transformer.length).not.toBe(chirp.length);
    expect(flare.length).toBeGreaterThan(baby.length);
    expect(crab.length).toBeGreaterThan(chirp.length);
  });
});

describe("LiveRavePerformer — jog blocks", () => {
  it("brake ramps playbackRate linearly to ≤ 0.05 and stops the deck", async () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    performer.playDeck("A", 0);
    const aSource = ctx.sources[0];

    const recipe = baseRecipe({
      family: "stop-exit",
      blocks: [{ type: "jog", side: "A", kind: "brake", atBeat: 28, beats: 4 }],
    });
    await performer.performRecipe(recipe, { startInSec: 0 });

    const ramp = aSource.playbackRate.events.find(
      (e) => e.type === "linearRamp",
    );
    expect(ramp).toBeDefined();
    expect(ramp?.value).toBeLessThanOrEqual(0.05);
    // Beat 32 at 120 bpm = 16 s on the clock; deck stop scheduled.
    expect(ramp?.time).toBeCloseTo(16);
    expect(
      aSource.stopCalls.some(
        (t) => t !== undefined && Math.abs(t - 16.02) < 0.01,
      ),
    ).toBe(true);
  });

  it("spinback plays a reversed render of the window, then resumes rewound", async () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    performer.playDeck("A", 0);

    const recipe = baseRecipe({
      blocks: [
        { type: "jog", side: "A", kind: "spinback", atBeat: 4, beats: 2 },
      ],
    });
    await performer.performRecipe(recipe, { startInSec: 0 });

    // At beat 4 (t = 2 s) A is at 2000 ms; the 2-beat window behind
    // it is 1000 ms = 48000 frames of reversed audio.
    const reversed = ctx.sources.find(
      (s) => s.buffer && s.buffer.length === 48_000,
    );
    expect(reversed).toBeDefined();
    expect(reversed?.startCalls[0].when).toBeCloseTo(2);
  });
});

describe("LiveRavePerformer — fx blocks", () => {
  it("builds convolver/delay chains and schedules the sends", async () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    expect(ctx.convolvers).toHaveLength(0);
    expect(ctx.delays).toHaveLength(0);

    const recipe = baseRecipe({
      blocks: [
        {
          type: "fx",
          side: "tail",
          kind: "reverb",
          atBeat: 28,
          beats: 4,
          params: { wet: 0.6, decay: 1.8 },
        },
        {
          type: "fx",
          side: "B",
          kind: "delay",
          atBeat: 0,
          beats: 8,
          params: { wet: 0.4, timeSec: 0.375 },
        },
      ],
    });
    await performer.performRecipe(recipe, { startInSec: 0 });

    expect(ctx.convolvers.length).toBeGreaterThanOrEqual(1);
    expect(ctx.convolvers[0].buffer).not.toBeNull();
    expect(ctx.delays.length).toBeGreaterThanOrEqual(1);
    expect(ctx.delays[0].delayTime.value).toBeCloseTo(0.375);
    // A send ramps up to the reverb's wet level.
    const wetRamp = allParams(ctx).some((p) =>
      p.events.some(
        (e) => e.type === "linearRamp" && Math.abs(e.value - 0.6) < 1e-9,
      ),
    );
    expect(wetRamp).toBe(true);
  });

  it("gating chops the deck's fxGate with a scheduled pattern", async () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    const recipe = baseRecipe({
      blocks: [
        {
          type: "fx",
          side: "A",
          kind: "gating",
          atBeat: 0,
          beats: 2,
          params: { division: 4 },
        },
      ],
    });
    await performer.performRecipe(recipe, { startInSec: 0 });
    // fxGate is chain hop 8 from A's source.
    const fxGate = chainNode(ctx.sources[0], 8) as FakeGain;
    expect(fxGate.gain.events.length).toBeGreaterThanOrEqual(8);
    expect(fxGate.gain.events.some((e) => e.value === 0)).toBe(true);
  });
});

describe("LiveRavePerformer — stopAll (C4)", () => {
  it("cancels every param, silences gains and stops every source", async () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    await performer.performRecipe(baseRecipe(), { startInSec: 1 });
    expect(ctx.sources.length).toBeGreaterThanOrEqual(2);

    performer.stopAll();

    for (const param of allParams(ctx)) {
      expect(param.events.some((e) => e.type === "cancel")).toBe(true);
    }
    // Master (first gain created) is silenced.
    expect(ctx.gains[0].gain.value).toBe(0);
    for (const source of ctx.sources) {
      expect(source.stopCalls.length).toBeGreaterThanOrEqual(1);
    }
    expect(performer.snapshot("A").playing).toBe(false);
    expect(performer.snapshot("B").playing).toBe(false);
  });
});

describe("LiveRavePerformer — loadDeck after stopAll (realcheck S1)", () => {
  it("reopens every dry-path gain stage: stopAll → loadDeck → playDeck leaves no zeroed hop", () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    performer.playDeck("A", 0);

    // The takeover sequence, call for call: stopAll first, the
    // session restores the master, then each deck is loaded fresh.
    performer.stopAll();
    performer.setMasterGain(1);
    performer.loadDeck("A", {
      trackId: "a2",
      buffer: makeBuffer(ctx),
      facts: factsFor("a2"),
    });
    performer.loadDeck("B", {
      trackId: "b2",
      buffer: makeBuffer(ctx),
      facts: factsFor("b2"),
    });
    performer.playDeck("A", 0);
    performer.playDeck("B", 0);

    // A deck's dry chain is gains in series, so a single hop still
    // at 0 is digital silence no matter how truthfully positions
    // advance — exactly what realcheck S1 measured on the shipped
    // build (input and crossfaderGain stayed at 0 after every
    // takeover because loadDeck never restored them).
    const dryGainHops: Array<[number, number]> = [
      [0, 1], // input
      [1, 1], // scratchGate
      [2, 1], // preGain
      [7, 1], // channelGain
      [8, 1], // fxGate
      [9, Math.SQRT1_2], // crossfaderGain at the centred fader
    ];
    for (const source of ctx.sources.slice(-2)) {
      for (const [hop, expected] of dryGainHops) {
        const node = chainNode(source, hop) as FakeGain;
        expect(node.gain.value).toBeCloseTo(expected);
      }
    }
    expect(ctx.gains[0].gain.value).toBeCloseTo(1);
  });

  it("re-derives crossfaderGain from the current fader position, not a fixed value", () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    performer.setCrossfader(0.25);
    performer.stopAll();
    performer.loadDeck("A", {
      trackId: "a2",
      buffer: makeBuffer(ctx),
      facts: factsFor("a2"),
    });
    performer.playDeck("A", 0);
    const aSource = ctx.sources[ctx.sources.length - 1];
    const cross = chainNode(aSource, 9) as FakeGain;
    expect(cross.gain.value).toBeCloseTo(Math.cos(0.25 * (Math.PI / 2)));
    const input = chainNode(aSource, 0) as FakeGain;
    expect(input.gain.value).toBeCloseTo(1);
  });
});

describe("LiveRavePerformer — transport and manual seams", () => {
  it("position follows the fake clock; pause freezes; seek moves", () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    performer.playDeck("A", 0);
    ctx.advance(2);
    expect(performer.positionMs("A")).toBeCloseTo(2000);
    performer.pauseDeck("A");
    ctx.advance(3);
    expect(performer.positionMs("A")).toBeCloseTo(2000);
    performer.seekTo("A", 5000);
    expect(performer.snapshot("A").positionMs).toBeCloseTo(5000);
    performer.playDeck("A");
    ctx.advance(1);
    expect(performer.positionMs("A")).toBeCloseTo(6000);
    expect(performer.isPlaying("A")).toBe(true);
  });

  it("swapRoles makes the incoming deck side A", () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    performer.swapRoles();
    expect(performer.snapshot("A").trackId).toBe("b");
    expect(performer.snapshot("B").trackId).toBe("a");
  });

  it("manual seams move their params and build the manual rack lazily", () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    loadBoth(performer, ctx);
    performer.playDeck("A", 0);
    const aSource = ctx.sources[0];

    // Channel strip via the chain walk: filter is hop 6, channel
    // gain hop 7's predecessor — filter at 6, channelGain at 7? The
    // chain is input0 scratchGate1 preGain2 eqLow3 eqMid4 eqHigh5
    // filter6 channelGain7 fxGate8 crossfader9.
    const filter = chainNode(aSource, 6) as FakeBiquad;
    const channel = chainNode(aSource, 7) as FakeGain;
    const eqLow = chainNode(aSource, 3) as FakeBiquad;
    performer.setChannelGain("A", 0.3);
    expect(channel.gain.value).toBeCloseTo(0.3);
    performer.setEq("A", "low", -12);
    expect(eqLow.gain.value).toBeCloseTo(-12);
    performer.setFilter("A", 1234);
    expect(filter.frequency.value).toBeCloseTo(1234);

    performer.setCrossfader(0);
    const crossA = chainNode(aSource, 9) as FakeGain;
    expect(crossA.gain.value).toBeCloseTo(1);

    performer.setMasterGain(0.25);
    expect(ctx.gains[0].gain.value).toBeCloseTo(0.25);

    // Manual FX: nothing built until assigned; then the send opens
    // at the set level.
    expect(ctx.convolvers).toHaveLength(0);
    performer.setFxSendLevel("B", "reverb", 0.7);
    performer.setFxAssign("B", "reverb", true);
    expect(ctx.convolvers.length).toBeGreaterThanOrEqual(1);
    const sendOpen = ctx.gains.some((g) => Math.abs(g.gain.value - 0.7) < 1e-9);
    expect(sendOpen).toBe(true);

    // Manual loop + roll.
    performer.setManualLoop("A", { startMs: 0, endMs: 8000 });
    expect(aSource.loop).toBe(true);
    expect(aSource.loopEnd).toBeCloseTo(8);
    performer.setManualLoop("A", null);
    expect(aSource.loop).toBe(false);
    const delaysBefore = ctx.delays.length;
    performer.setManualRoll("B", true);
    expect(ctx.delays.length).toBeGreaterThan(delaysBefore);
    performer.setManualRoll("B", false);
  });
});

describe("renditions", () => {
  class FakeRenditions implements RenditionProvider {
    calls: number[] = [];
    async render(buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
      this.calls.push(rate);
      return buffer;
    }
  }

  it("beatmatched rates render once per (track, rounded rate) and cache", async () => {
    const ctx = new FakeAudioContext();
    const fake = new FakeRenditions();
    const performer = new LiveRavePerformer(ctx as unknown as AudioContext, {
      renditionProvider: fake,
    });
    loadBoth(performer, ctx);
    const recipe = baseRecipe({
      rates: { rateA: 1, rateB: 1.0612, beatmatched: true },
    });
    await performer.performRecipe(recipe, { startInSec: 0 });
    // Rounded to 0.001 before the provider sees it.
    expect(fake.calls).toEqual([1.061]);
    expect(performer.snapshot("B").rate).toBeCloseTo(1.061);
    await performer.performRecipe(recipe, { startInSec: 0 });
    expect(fake.calls).toEqual([1.061]);
  });

  it("the soundtouchjs provider really stretches: tempo 2 halves the audio", async () => {
    const ctx = new FakeAudioContext();
    const provider = new SoundTouchRenditionProvider(
      ctx as unknown as BaseAudioContext,
    );
    const buffer = makeBuffer(ctx, 1);
    const same = await provider.render(buffer, 1);
    expect(same).toBe(buffer);
    const stretched = await provider.render(buffer, 2);
    expect(stretched).not.toBe(buffer);
    // Roughly half the frames (the stretch pipeline primes/drains,
    // so assert a window, not an exact count).
    expect(stretched.length).toBeLessThan(buffer.length * 0.75);
    expect(stretched.length).toBeGreaterThan(buffer.length * 0.25);
  });
});

describe("LiveRavePerformer — context recovery (fix2-0119)", () => {
  it("a context that starts suspended is asked to resume", () => {
    const ctx = new FakeAudioContext();
    ctx.state = "suspended";
    const performer = newPerformer(ctx);
    performer.ensureContextRunning();
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe("running");
  });

  it("a running context is left alone", () => {
    const ctx = new FakeAudioContext();
    const performer = newPerformer(ctx);
    performer.ensureContextRunning();
    expect(ctx.resumeCalls).toBe(0);
  });
});

describe("LiveRavePerformer — authority surface (fix2-0119)", () => {
  it("contextState() reports the wrapped context's state, before and after recovery", () => {
    const ctx = new FakeAudioContext();
    ctx.state = "suspended";
    const performer = newPerformer(ctx);
    // The session's takeover verification reads exactly this.
    expect(performer.contextState()).toBe("suspended");
    performer.ensureContextRunning();
    expect(performer.contextState()).toBe("running");
  });

  it("unloadDeck resets the deck's rate — no stray 1.06× on an empty deck", async () => {
    const ctx = new FakeAudioContext();
    const fake = {
      calls: [] as number[],
      async render(buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
        this.calls.push(rate);
        return buffer;
      },
    };
    const performer = new LiveRavePerformer(ctx as unknown as AudioContext, {
      renditionProvider: fake,
    });
    loadBoth(performer, ctx);
    await performer.performRecipe(
      baseRecipe({ rates: { rateA: 1, rateB: 1.0612, beatmatched: true } }),
      { startInSec: 0 },
    );
    expect(performer.snapshot("B").rate).toBeCloseTo(1.061);
    performer.unloadDeck("B");
    // The photographed stray: an EMPTY deck still showing the
    // last join's rate. An unloaded deck is at rate 1, held.
    expect(performer.snapshot("B").trackId).toBeNull();
    expect(performer.snapshot("B").rate).toBe(1);
  });
});
