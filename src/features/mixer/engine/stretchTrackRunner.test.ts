import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stretchChannelsOffThread } from "./stretchTrackRunner";

// Note 29 Fix B pins need a controllable worker the inline-path
// tests above never meet: a registry of constructed stand-ins that
// record posts and answer or fail only when the test says so, plus
// a counting passthrough on the inline DSP proving it never runs
// on a failure path. The passthrough calls the real render, so the
// inline-path contract above is exercised unchanged.

interface FakeStretchWorkerHandle {
  posted: number[];
  answer(id: number): void;
  fail(): void;
}

const stretchScript = vi.hoisted(() => ({
  instances: [] as FakeStretchWorkerHandle[],
}));

const stretchInlineSpy = vi.hoisted(() => ({ count: 0 }));

vi.mock("./timeStretch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./timeStretch")>();
  return {
    ...actual,
    stretchWithSoundTouch: (
      ...args: Parameters<typeof actual.stretchWithSoundTouch>
    ) => {
      stretchInlineSpy.count += 1;
      return actual.stretchWithSoundTouch(...args);
    },
  };
});

vi.mock("./stretchTrack.worker?worker&inline", () => ({
  default: class FakeStretchWorker implements FakeStretchWorkerHandle {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    posted: number[] = [];

    constructor() {
      stretchScript.instances.push(this);
    }

    postMessage(request: { id: number }): void {
      this.posted.push(request.id);
    }

    answer(id: number): void {
      this.onmessage?.({ data: { id, channels: [new Float32Array(8)] } });
    }

    fail(): void {
      this.onerror?.({ message: "worker died" });
    }

    terminate(): void {}
  },
}));

// The stretch runner, in an environment with no Worker global: the
// analysis runner's discipline says the caller never knows the
// difference — the render runs inline and the result is identical.
// These tests pin that contract (shape, exact length, failure as
// null) on the inline path the test environment exercises.

const SAMPLE_RATE = 44100;

function tone(seconds: number, freq = 220): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  }
  return out;
}

describe("stretchChannelsOffThread (inline fallback path)", () => {
  it("renders stereo channels to exactly round(length / factor) frames", async () => {
    const left = tone(2);
    const right = tone(2, 330);
    const rendered = await stretchChannelsOffThread(
      [left, right],
      SAMPLE_RATE,
      1.1,
    );
    expect(rendered).not.toBeNull();
    expect(rendered).toHaveLength(2);
    expect(rendered![0].length).toBe(Math.round(left.length / 1.1));
    expect(rendered![1].length).toBe(Math.round(left.length / 1.1));
    // The caller's arrays survive untouched (the fallback contract).
    expect(left.length).toBe(2 * SAMPLE_RATE);
  });

  it("slowing down lengthens by the same exact rule", async () => {
    const mono = tone(1.5);
    const rendered = await stretchChannelsOffThread([mono], SAMPLE_RATE, 0.94);
    expect(rendered).not.toBeNull();
    expect(rendered).toHaveLength(1);
    expect(rendered![0].length).toBe(Math.round(mono.length / 0.94));
  });

  it("answers null, never a throw, when the render cannot run", async () => {
    const rendered = await stretchChannelsOffThread([], SAMPLE_RATE, 1.1);
    expect(rendered).toBeNull();
  });
});

// Note 29 Fix B: a worker failure settles outstanding renders
// null — never by rendering inline on the UI thread — and does
// not poison the run: the next request constructs a fresh worker.
describe("stretchChannelsOffThread Note 29 — failure discipline", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "Worker",
      class {
        postMessage(): void {}
        terminate(): void {}
      },
    );
    stretchScript.instances.length = 0;
    stretchInlineSpy.count = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function freshStretchRunner() {
    vi.resetModules();
    return import("./stretchTrackRunner");
  }

  it("settles pending renders null on worker error, never renders inline, and rebuilds for the next request", async () => {
    const { stretchChannelsOffThread: stretch } = await freshStretchRunner();
    const pA = stretch([tone(0.1)], SAMPLE_RATE, 1.1);
    const pB = stretch([tone(0.1)], SAMPLE_RATE, 0.9);
    // Both renders reached the worker and are outstanding.
    expect(stretchScript.instances).toHaveLength(1);
    const first = stretchScript.instances[0];
    expect(first.posted).toEqual([1, 2]);
    first.fail();
    await expect(pA).resolves.toBeNull();
    await expect(pB).resolves.toBeNull();
    expect(stretchInlineSpy.count).toBe(0);
    // The retirement did not poison the run: the next request
    // constructs a fresh worker before anything else.
    const pC = stretch([tone(0.1)], SAMPLE_RATE, 1.1);
    expect(stretchScript.instances).toHaveLength(2);
    const second = stretchScript.instances[1];
    expect(second.posted).toEqual([3]);
    second.answer(3);
    const rendered = await pC;
    expect(rendered).not.toBeNull();
    expect(rendered![0].length).toBe(8);
  });
});
