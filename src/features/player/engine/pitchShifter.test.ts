import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PitchShifterController,
  pitchShifter,
  type AudioEffectsParams,
} from "./pitchShifter";
import { EQ_PRESETS } from "./equalizer";
import {
  visualizerTaps,
  PlayerGraphTap,
} from "../../greeting/lib/visualizerSource";

type Target = FakeNode | FakeParam;

class FakeParam {
  value: number;
  owner: FakeNode;

  constructor(owner: FakeNode, value: number) {
    this.owner = owner;
    this.value = value;
  }

  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }

  setTargetAtTime(value: number) {
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number) {
    this.value = value;
    return this;
  }

  cancelScheduledValues() {
    return this;
  }

  cancelAndHoldAtTime() {
    return this;
  }
}

class FakeNode {
  kind: string;
  ctx: FakeAudioContext;
  outputs = new Set<Target>();

  constructor(ctx: FakeAudioContext, kind: string) {
    this.ctx = ctx;
    this.kind = kind;
    ctx.nodes.push(this);
  }

  connect(target: Target) {
    this.outputs.add(target);
    return target;
  }

  disconnect(target?: Target) {
    if (target) this.outputs.delete(target);
    else this.outputs.clear();
  }
}

class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, "gain");
    this.gain = new FakeParam(this, 1);
  }
}

class FakeDelay extends FakeNode {
  delayTime: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, "delay");
    this.delayTime = new FakeParam(this, 0);
  }
}

class FakeBiquad extends FakeNode {
  type = "lowpass";
  frequency: FakeParam;
  Q: FakeParam;
  gain: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, "biquad");
    this.frequency = new FakeParam(this, 350);
    this.Q = new FakeParam(this, 1);
    this.gain = new FakeParam(this, 0);
  }
}

class FakeConvolver extends FakeNode {
  normalize = true;
  buffer: unknown = null;
  constructor(ctx: FakeAudioContext) {
    super(ctx, "convolver");
  }
}

class FakeDynamicsCompressor extends FakeNode {
  threshold: FakeParam;
  knee: FakeParam;
  ratio: FakeParam;
  attack: FakeParam;
  release: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, "dynamicsCompressor");
    this.threshold = new FakeParam(this, -24);
    this.knee = new FakeParam(this, 30);
    this.ratio = new FakeParam(this, 12);
    this.attack = new FakeParam(this, 0.003);
    this.release = new FakeParam(this, 0.25);
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  constructor(ctx: FakeAudioContext) {
    super(ctx, "analyser");
  }
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getByteFrequencyData(array: Uint8Array) {
    array.fill(0);
  }
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  started = false;
  stopped = false;
  constructor(ctx: FakeAudioContext) {
    super(ctx, "bufferSource");
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  nodes: FakeNode[] = [];
  state: "running" | "suspended" | "closed" = "suspended";
  currentTime = 0;
  sampleRate = 8000;
  destination: FakeNode;

  constructor() {
    this.destination = new FakeNode(this, "destination");
    FakeAudioContext.instances.push(this);
  }

  resume() {
    this.state = "running";
    return Promise.resolve();
  }

  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }

  createGain() {
    return new FakeGain(this);
  }

  createDelay() {
    return new FakeDelay(this);
  }

  createBiquadFilter() {
    return new FakeBiquad(this);
  }

  createConvolver() {
    return new FakeConvolver(this);
  }

  createBufferSource() {
    return new FakeBufferSource(this);
  }

  createDynamicsCompressor() {
    return new FakeDynamicsCompressor(this);
  }

  createAnalyser() {
    return new FakeAnalyser(this);
  }

  createMediaElementSource(mediaElement: HTMLMediaElement) {
    const node = new FakeNode(this, "mediaSource");
    (node as any).mediaElement = mediaElement;
    return node;
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from(
      { length: channels },
      () => new Float32Array(length),
    );
    return {
      length,
      sampleRate,
      numberOfChannels: channels,
      getChannelData: (i: number) => data[i],
    };
  }
}

function reachesDestination(ctx: FakeAudioContext): Set<FakeNode> {
  const live = new Set<FakeNode>([ctx.destination]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of ctx.nodes) {
      if (live.has(node)) continue;
      for (const target of node.outputs) {
        const owner = target instanceof FakeParam ? target.owner : target;
        if (live.has(owner)) {
          live.add(node);
          changed = true;
          break;
        }
      }
    }
  }
  return live;
}

function measure() {
  const ctx = FakeAudioContext.instances[0];
  const live = reachesDestination(ctx);
  const inPath = (kind: string) =>
    ctx.nodes.filter((node) => node.kind === kind && live.has(node)).length;
  return {
    convolvers: inPath("convolver"),
    runningSources: ctx.nodes.filter(
      (node) =>
        node instanceof FakeBufferSource && node.started && !node.stopped,
    ).length,
    delays: inPath("delay"),
    biquads: inPath("biquad"),
    nodesInPath: live.size,
    suspended: ctx.state === "suspended",
  };
}

describe("audio effects graph idle cost", () => {
  let audio: HTMLAudioElement;
  let paused: boolean;
  let controller: PitchShifterController;

  const play = () => {
    paused = false;
    audio.dispatchEvent(new Event("play"));
    audio.dispatchEvent(new Event("playing"));
  };

  const pause = () => {
    paused = true;
    audio.dispatchEvent(new Event("pause"));
  };

  const settle = async () => {
    await vi.advanceTimersByTimeAsync(5000);
  };

  const start = async (params: AudioEffectsParams = {}) => {
    controller.attach(audio);
    play();
    controller.update(params);
    await settle();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudioContext.instances = [];
    const win = window as any;
    delete win.__liner_audio_context;
    delete win.__liner_media_source_node;
    delete win.__liner_pitch_graph;
    win.AudioContext = FakeAudioContext;
    audio = document.createElement("audio");
    paused = true;
    Object.defineProperty(audio, "paused", { get: () => paused });
    controller = new PitchShifterController();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).AudioContext;
  });

  it("neutral playing keeps only the dry path running", async () => {
    await start();
    expect(measure()).toMatchObject({
      convolvers: 0,
      runningSources: 0,
      delays: 0,
      biquads: 0,
      suspended: false,
    });
  });

  it("neutral paused suspends the context after the fade", async () => {
    await start();
    pause();
    await settle();
    expect(measure()).toMatchObject({
      convolvers: 0,
      runningSources: 0,
      biquads: 0,
      suspended: true,
    });
  });

  it("resumes the context as soon as playback starts again", async () => {
    await start();
    pause();
    await settle();
    play();
    expect(FakeAudioContext.instances[0].state).toBe("running");
  });

  it("reverb on connects only the convolver branch", async () => {
    await start({ isReverbEnabled: true, reverbLevel: 0.35 });
    expect(measure()).toMatchObject({
      convolvers: 1,
      runningSources: 0,
      biquads: 1,
      suspended: false,
    });
  });

  it("pitch on starts the shifter only while needed", async () => {
    await start({ isPitchLinked: false, pitchSemitones: 3 });
    expect(measure()).toMatchObject({
      convolvers: 0,
      runningSources: 12,
      delays: 4,
      biquads: 0,
      suspended: false,
    });
  });

  it("eq on inserts the biquad chain", async () => {
    const bass = EQ_PRESETS.find((preset) => preset.id === "bass")!;
    await start({ isEqEnabled: true, eqGains: bass.gains });
    expect(measure()).toMatchObject({
      convolvers: 0,
      runningSources: 0,
      biquads: 10,
      suspended: false,
    });
  });

  it("tears effects down again when they go back to neutral", async () => {
    const bass = EQ_PRESETS.find((preset) => preset.id === "bass")!;
    await start({
      isReverbEnabled: true,
      reverbLevel: 0.5,
      isPitchLinked: false,
      pitchSemitones: -4,
      isEqEnabled: true,
      eqGains: bass.gains,
    });
    expect(measure()).toMatchObject({
      convolvers: 1,
      runningSources: 12,
      biquads: 11,
    });
    controller.update({});
    await settle();
    expect(measure()).toMatchObject({
      convolvers: 0,
      runningSources: 0,
      delays: 0,
      biquads: 0,
    });
    controller.update({ isPitchLinked: false, pitchSemitones: 2 });
    await settle();
    expect(measure()).toMatchObject({ runningSources: 12, delays: 4 });
  });

  it("keeps a re-enabled effect when toggled back before teardown", async () => {
    await start({ isReverbEnabled: true, reverbLevel: 0.4 });
    controller.update({});
    controller.update({ isReverbEnabled: true, reverbLevel: 0.4 });
    await settle();
    expect(measure().convolvers).toBe(1);
  });

  it("drives the same gains as before when effects are on", async () => {
    const bass = EQ_PRESETS.find((preset) => preset.id === "bass")!;
    await start({
      isReverbEnabled: true,
      reverbLevel: 0.35,
      isPitchLinked: false,
      pitchSemitones: 3,
      isEqEnabled: true,
      eqGains: bass.gains,
    });
    const graph = (window as any).__liner_pitch_graph;
    expect(graph.pitchDryGain.gain.value).toBe(0);
    expect(graph.pitchWetGain.gain.value).toBe(1);
    expect(graph.reverbSendGain.gain.value).toBe(1);
    expect(graph.reverbWetGain.gain.value).toBeCloseTo(0.35);
    expect(graph.convolver.buffer).not.toBeNull();
    expect(
      graph.eqFilters.map((filter: FakeBiquad) => filter.gain.value),
    ).toEqual(bass.gains);
    expect(graph.eqChainGain.gain.value).toBe(1);
    expect(graph.eqBypassGain.gain.value).toBe(0);
  });

  it("lets the reverb tail ring out before suspending", async () => {
    await start({ isReverbEnabled: true, reverbLevel: 0.35 });
    pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(measure().suspended).toBe(false);
    await settle();
    expect(measure().suspended).toBe(true);
  });

  it("goes back to sleep when effects change while paused", async () => {
    await start();
    pause();
    await settle();
    controller.resumeContext();
    expect(measure().suspended).toBe(false);
    await settle();
    expect(measure().suspended).toBe(true);
  });

  it("volume boost routes masterOut through boost and limiter", async () => {
    await start();
    controller.setUserVolume(2.5);
    const ctx = FakeAudioContext.instances[0];
    const graph = (window as any).__liner_pitch_graph;
    expect(graph.boostConnected).toBe(true);
    expect(graph.boostGain.gain.value).toBe(2.5);
    expect(graph.masterOut.outputs.has(ctx.destination)).toBe(false);
    expect(graph.masterOut.outputs.has(graph.boostGain)).toBe(true);
    expect(graph.boostGain.outputs.has(graph.limiter)).toBe(true);
    expect(graph.limiter.outputs.has(ctx.destination)).toBe(true);
    expect(graph.limiter.threshold.value).toBe(-1);
    expect(graph.limiter.knee.value).toBe(0);
    expect(graph.limiter.ratio.value).toBe(20);
    expect(graph.limiter.attack.value).toBe(0.002);
    expect(graph.limiter.release.value).toBe(0.2);
  });

  it("volume at or below 1 never attaches and keeps the direct path", async () => {
    const fresh = new PitchShifterController();
    fresh.setUserVolume(0.5);
    expect(fresh.isAttached()).toBe(false);

    await start();
    controller.setUserVolume(0.5);
    const ctx = FakeAudioContext.instances[0];
    const graph = (window as any).__liner_pitch_graph;
    expect(graph.boostConnected).toBe(false);
    expect(graph.boostGain.outputs.size).toBe(0);
    expect(graph.masterOut.outputs.has(ctx.destination)).toBe(true);
    expect(graph.masterOut.outputs.has(graph.boostGain)).toBe(false);
  });

  it("volume boost attaches on demand when above 1", () => {
    const fresh = new PitchShifterController();
    fresh.setUserVolume(2, audio);
    expect(fresh.isAttached()).toBe(true);
    const graph = (window as any).__liner_pitch_graph;
    expect(graph.boostConnected).toBe(true);
    expect(graph.boostGain.gain.value).toBe(2);
  });

  it("boost deactivation restores the direct wiring after teardown", async () => {
    await start();
    controller.setUserVolume(3);
    controller.setUserVolume(0.8);
    await vi.advanceTimersByTimeAsync(500);
    const ctx = FakeAudioContext.instances[0];
    const graph = (window as any).__liner_pitch_graph;
    expect(graph.boostConnected).toBe(false);
    expect(graph.masterOut.outputs.has(ctx.destination)).toBe(true);
    expect(graph.masterOut.outputs.has(graph.boostGain)).toBe(false);
    expect(graph.boostGain.outputs.size).toBe(0);
    expect(graph.limiter.outputs.size).toBe(0);
  });

  it("keeps the boost when reactivated before teardown", async () => {
    await start();
    controller.setUserVolume(3);
    controller.setUserVolume(0.8);
    controller.setUserVolume(2);
    await vi.advanceTimersByTimeAsync(500);
    const graph = (window as any).__liner_pitch_graph;
    expect(graph.boostConnected).toBe(true);
    expect(graph.boostGain.gain.value).toBe(2);
    expect(graph.masterOut.outputs.has(graph.boostGain)).toBe(true);
  });

  it("masterAnalyser is null before attach and cached per graph", async () => {
    const fresh = new PitchShifterController();
    expect(fresh.masterAnalyser()).toBeNull();

    await start();
    const graph = (window as any).__liner_pitch_graph;
    const analyser = controller.masterAnalyser() as unknown as FakeAnalyser;
    expect(analyser).not.toBeNull();
    expect(graph.masterOutputGain.outputs.has(analyser)).toBe(true);
    expect(analyser.fftSize).toBe(256);
    expect(analyser.smoothingTimeConstant).toBe(0.5);
    expect(controller.masterAnalyser()).toBe(analyser);

    graph.version = 2;
    controller.attach(audio);
    const rebuiltGraph = (window as any).__liner_pitch_graph;
    expect(rebuiltGraph).not.toBe(graph);
    const rebuilt = controller.masterAnalyser() as unknown as FakeAnalyser;
    expect(rebuilt).not.toBe(analyser);
    expect(rebuiltGraph.masterOutputGain.outputs.has(rebuilt)).toBe(true);
  });

  it("attach registers the analyser tap on the exported singleton", () => {
    pitchShifter.attach(audio);
    expect(pitchShifter.isAttached()).toBe(true);
    const entries = (visualizerTaps as any).entries as Array<{
      tap: unknown;
    }>;
    const entry = entries.find(
      (candidate) => (candidate.tap as { id?: string }).id === "player-graph",
    );
    expect(entry).toBeDefined();
    expect(entry!.tap).not.toBeInstanceOf(PlayerGraphTap);
    const tap = entry!.tap as {
      analyser(): unknown;
      isLive(): boolean;
    };
    expect(tap.isLive()).toBe(true);
    expect(tap.analyser()).toBe(pitchShifter.masterAnalyser());
  });
});
