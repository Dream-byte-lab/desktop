import { describe, expect, it } from "vitest";
import { TwoDeckMixer } from "./twoDeckMixer";

// The master bus limiter (the bass fix): the constructor wires
// master → limiter → destination with the plain path's own
// compressor settings, so the level-match × user-volume product
// is capped exactly the way plain playback caps its excess. The
// literal values asserted below are the plain path's —
// pitchShifter.ts's buildGraph hardcodes them for its limiter
// (threshold −1 dB, knee 0, ratio 20, attack 0.002 s, release
// 0.2 s) rather than exporting them; if that file's values ever
// change, this pin is the reminder to move the mixer's with them.

class FakeParam {
  value = 0;
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
  setValueCurveAtTime(): void {}
  cancelScheduledValues(): void {}
  setTargetAtTime(): void {}
}

class FakeNode {
  outputs: unknown[] = [];
  connect(destination: unknown): void {
    this.outputs.push(destination);
  }
  disconnect(): void {
    this.outputs = [];
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  type = "";
  frequency = new FakeParam();
  gain = new FakeParam();
  Q = new FakeParam();
}

class FakeDelay extends FakeNode {
  delayTime = new FakeParam();
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

type CompressorMode = "working" | "missing" | "throwing";

class FakeContext {
  currentTime = 1000;
  sampleRate = 48000;
  destination = { kind: "destination" };
  compressors: FakeCompressor[] = [];
  createDynamicsCompressor?: () => FakeCompressor;
  constructor(mode: CompressorMode = "working") {
    if (mode === "working") {
      this.createDynamicsCompressor = () => {
        const node = new FakeCompressor();
        this.compressors.push(node);
        return node;
      };
    } else if (mode === "throwing") {
      this.createDynamicsCompressor = () => {
        throw new Error("compressor unavailable");
      };
    }
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }
  createDelay(): FakeDelay {
    return new FakeDelay();
  }
  createBufferSource(): never {
    throw new Error("not needed at construction");
  }
}

function newMixer(mode: CompressorMode = "working") {
  const ctx = new FakeContext(mode);
  const mixer = new TwoDeckMixer(ctx as unknown as AudioContext);
  const master = mixer.master as unknown as FakeGain;
  return { ctx, mixer, master };
}

describe("TwoDeckMixer — the master bus limiter", () => {
  it("wires master → limiter → destination, exactly one compressor", () => {
    const { ctx, master } = newMixer();
    expect(ctx.compressors).toHaveLength(1);
    const limiter = ctx.compressors[0];
    // Signal flows master → compressor → destination, and the
    // master no longer reaches the destination directly.
    expect(master.outputs).toEqual([limiter]);
    expect(limiter.outputs).toEqual([ctx.destination]);
    expect(master.outputs).not.toContain(ctx.destination);
  });

  it("carries the plain path's exact limiter settings", () => {
    const { ctx } = newMixer();
    const limiter = ctx.compressors[0];
    expect(limiter.threshold.value).toBe(-1.0);
    expect(limiter.knee.value).toBe(0);
    expect(limiter.ratio.value).toBe(20);
    expect(limiter.attack.value).toBe(0.002);
    expect(limiter.release.value).toBe(0.2);
  });

  it("leaves the master resting at unity, as before", () => {
    const { master } = newMixer();
    expect(master.gain.value).toBe(1);
  });

  it("keeps the old direct wiring when the context has no compressor factory", () => {
    const { ctx, master } = newMixer("missing");
    expect(ctx.compressors).toHaveLength(0);
    expect(master.outputs).toEqual([ctx.destination]);
  });

  it("keeps the old direct wiring when the compressor factory throws", () => {
    const { ctx, master } = newMixer("throwing");
    expect(ctx.compressors).toHaveLength(0);
    expect(master.outputs).toEqual([ctx.destination]);
  });
});
