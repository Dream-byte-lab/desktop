import { describe, expect, it } from "vitest";
import {
  createAnalyserTap,
  registerVisualizerTap,
  restProfileAt,
  VISUALIZER_TAP_ID,
  VISUALIZER_TAP_PRIORITY,
  VisualizerTap,
  VisualizerTapRegistry,
  visualizerTaps,
} from "./visualizerSource";

// The tap registry, pinned with fake taps: priority decides,
// silence falls through instead of freezing, a tap that arrives
// late lights the next sample, and with no signal anywhere the
// field is exactly the resting profile — the honesty the shipped
// greeting promised, now carried by the registry the unlock
// will register into.

// The DJ fake is all bass: its sample reads bass ≈ 1.
const DJ_FILL = (bin: number) => (bin >= 1 && bin < 9 ? 255 : 0);
// The player fake is all treble: its sample reads bass = 0 with
// the field's top bars lit. The two signatures cannot be confused.
const PLAYER_FILL = (bin: number) => (bin >= 60 && bin < 110 ? 255 : 0);

class FakeAnalyser {
  readonly frequencyBinCount = 128;
  readonly context = { state: "running" };
  private script: Uint8Array;

  constructor(fill: (bin: number) => number) {
    this.script = Uint8Array.from({ length: 128 }, (_, i) => fill(i));
  }

  setFill(fill: (bin: number) => number): void {
    this.script = Uint8Array.from({ length: 128 }, (_, i) => fill(i));
  }

  getByteFrequencyData(target: Uint8Array): void {
    target.set(this.script.subarray(0, target.length));
  }

  asNode(): AnalyserNode {
    return this as unknown as AnalyserNode;
  }
}

class FakeTap implements VisualizerTap {
  live = true;
  nodeAvailable = true;
  disposed = 0;
  private readonly node: FakeAnalyser;

  constructor(
    readonly id: string,
    fill: (bin: number) => number,
  ) {
    this.node = new FakeAnalyser(fill);
  }

  isLive(): boolean {
    return this.live;
  }

  analyser(): AnalyserNode | null {
    return this.live && this.nodeAvailable ? this.node.asNode() : null;
  }

  dispose(): void {
    this.disposed += 1;
  }

  setFill(fill: (bin: number) => number): void {
    this.node.setFill(fill);
  }

  silence(): void {
    this.node.setFill(() => 0);
  }

  suspend(): void {
    this.node.context.state = "suspended";
  }
}

function expectRest(registry: VisualizerTapRegistry): void {
  const sample = registry.sample(36);
  expect(sample.live).toBe(false);
  expect(sample.bass).toBeNull();
  for (let i = 0; i < 36; i += 1) {
    // Bars live in a Float32Array, so the stored ridge is the
    // profile's float32 rounding — exactly, not approximately.
    expect(sample.bars[i]).toBe(Math.fround(restProfileAt(i)));
  }
}

describe("VisualizerTapRegistry priority", () => {
  it("samples the higher-priority tap when both carry signal", () => {
    const registry = new VisualizerTapRegistry();
    registry.register(
      new FakeTap(VISUALIZER_TAP_ID.PLAYER_GRAPH, PLAYER_FILL),
      VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH,
    );
    registry.register(
      new FakeTap(VISUALIZER_TAP_ID.DJ_MASTER, DJ_FILL),
      VISUALIZER_TAP_PRIORITY.DJ_MASTER,
    );
    const sample = registry.sample(36);
    expect(sample.live).toBe(true);
    expect(sample.bass).toBeGreaterThan(0.9);
  });

  it("priority beats registration order", () => {
    const registry = new VisualizerTapRegistry();
    registry.register(
      new FakeTap(VISUALIZER_TAP_ID.DJ_MASTER, DJ_FILL),
      VISUALIZER_TAP_PRIORITY.DJ_MASTER,
    );
    registry.register(
      new FakeTap(VISUALIZER_TAP_ID.PLAYER_GRAPH, PLAYER_FILL),
      VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH,
    );
    const sample = registry.sample(36);
    expect(sample.live).toBe(true);
    expect(sample.bass).toBeGreaterThan(0.9);
  });
});

describe("VisualizerTapRegistry fall-through", () => {
  it("falls to the next tap, then to rest, when the leading tap goes silent mid-session", () => {
    const registry = new VisualizerTapRegistry();
    const player = new FakeTap(VISUALIZER_TAP_ID.PLAYER_GRAPH, PLAYER_FILL);
    const dj = new FakeTap(VISUALIZER_TAP_ID.DJ_MASTER, DJ_FILL);
    registry.register(player, VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH);
    registry.register(dj, VISUALIZER_TAP_PRIORITY.DJ_MASTER);

    // The set is playing: the DJ tap speaks.
    expect(registry.sample(36).bass).toBeGreaterThan(0.9);

    // A silent passage on the decks: the player tap's signal is
    // what is real now — never the DJ tap's frozen last frame.
    dj.silence();
    const fromPlayer = registry.sample(36);
    expect(fromPlayer.live).toBe(true);
    expect(fromPlayer.bass).toBe(0);
    expect(fromPlayer.bars[35]).toBeGreaterThan(0.9);

    // Silence everywhere: rest, exactly the resting profile.
    player.silence();
    expectRest(registry);
  });

  it("falls through when the leading tap's path ends", () => {
    const registry = new VisualizerTapRegistry();
    const player = new FakeTap(VISUALIZER_TAP_ID.PLAYER_GRAPH, PLAYER_FILL);
    const dj = new FakeTap(VISUALIZER_TAP_ID.DJ_MASTER, DJ_FILL);
    registry.register(player, VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH);
    registry.register(dj, VISUALIZER_TAP_PRIORITY.DJ_MASTER);
    dj.live = false;
    const sample = registry.sample(36);
    expect(sample.live).toBe(true);
    expect(sample.bass).toBe(0);
  });

  it("skips a tap whose context is not running", () => {
    const registry = new VisualizerTapRegistry();
    const player = new FakeTap(VISUALIZER_TAP_ID.PLAYER_GRAPH, PLAYER_FILL);
    const dj = new FakeTap(VISUALIZER_TAP_ID.DJ_MASTER, DJ_FILL);
    registry.register(player, VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH);
    registry.register(dj, VISUALIZER_TAP_PRIORITY.DJ_MASTER);
    dj.suspend();
    const sample = registry.sample(36);
    expect(sample.live).toBe(true);
    expect(sample.bass).toBe(0);
  });

  it("skips a live tap that has no analyser yet", () => {
    const registry = new VisualizerTapRegistry();
    const player = new FakeTap(VISUALIZER_TAP_ID.PLAYER_GRAPH, PLAYER_FILL);
    const dj = new FakeTap(VISUALIZER_TAP_ID.DJ_MASTER, DJ_FILL);
    registry.register(player, VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH);
    registry.register(dj, VISUALIZER_TAP_PRIORITY.DJ_MASTER);
    dj.nodeAvailable = false;
    const sample = registry.sample(36);
    expect(sample.live).toBe(true);
    expect(sample.bass).toBe(0);
  });

  it("skips a tap whose truth function throws, rather than freezing", () => {
    const registry = new VisualizerTapRegistry();
    registry.register(
      new FakeTap(VISUALIZER_TAP_ID.PLAYER_GRAPH, PLAYER_FILL),
      VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH,
    );
    registry.register(
      {
        id: VISUALIZER_TAP_ID.DJ_MASTER,
        isLive: () => {
          throw new Error("tap exploded");
        },
        analyser: () => null,
      },
      VISUALIZER_TAP_PRIORITY.DJ_MASTER,
    );
    const sample = registry.sample(36);
    expect(sample.live).toBe(true);
    expect(sample.bass).toBe(0);
  });
});

describe("VisualizerTapRegistry late registration", () => {
  it("a tap registered after the source is already in use lights the next sample", () => {
    const registry = new VisualizerTapRegistry();
    // Already in use, nothing registered: rest.
    expectRest(registry);

    const player = new FakeTap(VISUALIZER_TAP_ID.PLAYER_GRAPH, () => 0);
    const removePlayer = registry.register(
      player,
      VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH,
    );
    // Registered but silent: still rest.
    expectRest(registry);

    // Sound arrives on it: live from that tap.
    player.setFill(PLAYER_FILL);
    expect(registry.sample(36).live).toBe(true);

    // A higher-priority tap arrives silent: the player still speaks.
    const dj = new FakeTap(VISUALIZER_TAP_ID.DJ_MASTER, () => 0);
    const removeDj = registry.register(dj, VISUALIZER_TAP_PRIORITY.DJ_MASTER);
    expect(registry.sample(36).bass).toBe(0);

    // It starts carrying the set: it takes over.
    dj.setFill(DJ_FILL);
    expect(registry.sample(36).bass).toBeGreaterThan(0.9);

    // Unregistering unwinds in order, back to rest.
    removeDj();
    expect(registry.sample(36).bass).toBe(0);
    removePlayer();
    expectRest(registry);
  });

  it("registering under an existing id replaces and disposes the old tap", () => {
    const registry = new VisualizerTapRegistry();
    const first = new FakeTap("custom", DJ_FILL);
    const second = new FakeTap("custom", PLAYER_FILL);
    registry.register(first, VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH);
    registry.register(second, VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH);
    expect(first.disposed).toBe(1);
    expect(registry.registrations()).toEqual([
      { id: "custom", priority: VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH },
    ]);
    const sample = registry.sample(36);
    expect(sample.live).toBe(true);
    expect(sample.bass).toBe(0);
  });
});

describe("createAnalyserTap", () => {
  it("delegates the provider and the truth function", () => {
    const node = new FakeAnalyser(DJ_FILL);
    let live = false;
    const tap = createAnalyserTap(
      "delegated",
      () => (live ? node.asNode() : null),
      () => live,
    );
    const registry = new VisualizerTapRegistry();
    registry.register(tap, VISUALIZER_TAP_PRIORITY.DJ_MASTER);
    expectRest(registry);
    live = true;
    const sample = registry.sample(36);
    expect(sample.live).toBe(true);
    expect(sample.bass).toBeGreaterThan(0.9);
  });
});

describe("the app registry", () => {
  it("carries the player-graph tap as its first registration", () => {
    expect(visualizerTaps.registrations()).toContainEqual({
      id: VISUALIZER_TAP_ID.PLAYER_GRAPH,
      priority: VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH,
    });
  });

  it("registerVisualizerTap registers into it and unregisters cleanly", () => {
    const remove = registerVisualizerTap(
      new FakeTap("contract-probe", DJ_FILL),
      VISUALIZER_TAP_PRIORITY.DJ_MASTER,
    );
    try {
      expect(visualizerTaps.registrations()).toContainEqual({
        id: "contract-probe",
        priority: VISUALIZER_TAP_PRIORITY.DJ_MASTER,
      });
    } finally {
      remove();
    }
    expect(visualizerTaps.registrations()).not.toContainEqual({
      id: "contract-probe",
      priority: VISUALIZER_TAP_PRIORITY.DJ_MASTER,
    });
  });
});
