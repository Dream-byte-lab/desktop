import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyseAudioBuffer, type TrackAnalysis } from "./analyseTrack";

// The analysis runner, tested against a scripted stand-in for the
// worker module: in "work" mode the stand-in answers with a marked
// analysis (proving the answer really came from the worker side and
// was dispatched to the right requester); in "throw" mode its
// constructor fails, and the runner must quietly produce the real
// inline analysis instead — the fallback is part of the contract.

interface FakeWorkerHandle {
  posted: { id: number; depth: string }[];
  answer(id: number): void;
  fail(): void;
}

const workerScript = vi.hoisted(() => ({
  behaviour: "work" as "work" | "throw",
  // "auto" answers every post a microtask later (the original
  // tests' world); "manual" only records posts — the Note 29 pins
  // drive answers and failures by hand.
  mode: "auto" as "auto" | "manual",
  markerLoudness: 0.123456,
  instances: [] as FakeWorkerHandle[],
}));

/** Counts every run of the real inline DSP (the Note 29 pins prove it never runs on failure paths). */
const inlineSpy = vi.hoisted(() => ({ count: 0 }));

vi.mock("./analyseTrack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./analyseTrack")>();
  return {
    ...actual,
    analyseTrack: (
      samples: Float32Array,
      sampleRate: number,
      options: Parameters<typeof actual.analyseTrack>[2],
    ) => {
      inlineSpy.count += 1;
      return actual.analyseTrack(samples, sampleRate, options);
    },
  };
});

vi.mock("./analyseTrack.worker?worker&inline", () => ({
  default: class FakeAnalyseWorker implements FakeWorkerHandle {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    posted: { id: number; depth: string }[] = [];

    constructor() {
      if (workerScript.behaviour === "throw") {
        throw new Error("workers unavailable in this environment");
      }
      workerScript.instances.push(this);
    }

    postMessage(request: { id: number; options?: { depth?: string } }): void {
      this.posted.push({
        id: request.id,
        depth: request.options?.depth ?? "deep",
      });
      if (workerScript.mode === "manual") return;
      queueMicrotask(() => this.answer(request.id));
    }

    answer(id: number): void {
      const analysis: TrackAnalysis = {
        beatMap: {
          bpm: 120,
          firstBeatSec: 0,
          beatsPerBar: 4,
          durationSec: 20,
        },
        tempoConfidence: 1,
        energyCurve: [],
        drops: [],
        key: null,
        vocalRanges: [],
        loudness: workerScript.markerLoudness,
      };
      this.onmessage?.({ data: { id, analysis } });
    }

    fail(): void {
      this.onerror?.({ message: "worker died" });
    }

    terminate(): void {}
  },
}));

const SAMPLE_RATE = 44100;

/** A short click song at 120 bpm — enough for the real analyser. */
function syntheticBuffer(seconds = 20): AudioBuffer {
  const samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  const spb = 60 / 120;
  for (let beat = 0; ; beat += 1) {
    const t = 0.25 + beat * spb;
    if (t >= seconds) break;
    const start = Math.floor(t * SAMPLE_RATE);
    for (let n = 0; n < 512 && start + n < samples.length; n += 1) {
      samples[start + n] +=
        0.8 *
        Math.exp(-n / 60) *
        Math.sin((2 * Math.PI * 180 * n) / SAMPLE_RATE);
    }
  }
  return {
    length: samples.length,
    numberOfChannels: 1,
    sampleRate: SAMPLE_RATE,
    duration: seconds,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

async function freshRunner() {
  vi.resetModules();
  return import("./analyseTrackRunner");
}

describe("analyseBufferOffThread", () => {
  beforeEach(() => {
    // The runner probes the global Worker constructor for support;
    // the module under test supplies its own (mocked) worker class.
    vi.stubGlobal(
      "Worker",
      class {
        postMessage(): void {}
        terminate(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the worker's analysis when the worker answers", async () => {
    workerScript.behaviour = "work";
    const { analyseBufferOffThread } = await freshRunner();
    const result = await analyseBufferOffThread(syntheticBuffer());
    expect(result).not.toBeNull();
    expect(result!.loudness).toBe(workerScript.markerLoudness);
  });

  it("dispatches overlapping requests to their own answers", async () => {
    workerScript.behaviour = "work";
    const { analyseBufferOffThread } = await freshRunner();
    const [first, second] = await Promise.all([
      analyseBufferOffThread(syntheticBuffer()),
      analyseBufferOffThread(syntheticBuffer()),
    ]);
    expect(first?.loudness).toBe(workerScript.markerLoudness);
    expect(second?.loudness).toBe(workerScript.markerLoudness);
  });

  it(
    "falls back to the identical inline analysis when the worker cannot be built",
    { timeout: 30000 },
    async () => {
      workerScript.behaviour = "throw";
      const { analyseBufferOffThread } = await freshRunner();
      const buffer = syntheticBuffer();
      const expected = analyseAudioBuffer(buffer);
      const result = await analyseBufferOffThread(buffer);
      expect(expected).not.toBeNull();
      expect(result).not.toBeNull();
      expect(result!.loudness).not.toBe(workerScript.markerLoudness);
      expect(result!.beatMap.bpm).toBeCloseTo(expected!.beatMap.bpm, 5);
      expect(result!.loudness).toBeCloseTo(expected!.loudness, 10);
    },
  );
});

// Note 29 Fixes A + B: requests are held and dispatched one at a
// time, fast before deep; the wedge timeout runs from dispatch;
// a worker failure settles everything null, runs no DSP inline,
// and does not poison the run — the next request rebuilds.
describe("analyseTrackRunner Note 29 — priority dispatch and failure discipline", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "Worker",
      class {
        postMessage(): void {}
        terminate(): void {}
      },
    );
    workerScript.behaviour = "work";
    workerScript.mode = "manual";
    workerScript.instances.length = 0;
    inlineSpy.count = 0;
  });

  afterEach(() => {
    workerScript.mode = "auto";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const samples = () => new Float32Array(4410);

  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  function worker(): FakeWorkerHandle {
    return workerScript.instances[workerScript.instances.length - 1];
  }

  it("dispatches a synchronous burst fast-first, FIFO within a class, one at a time", async () => {
    const { analyseSamplesOffThread } = await freshRunner();
    // Ids are assigned at enqueue: deep-A = 1, deep-B = 2, fast-C = 3.
    const pA = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
      depth: "deep",
    });
    const pB = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
      depth: "deep",
    });
    const pC = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
      depth: "fast",
    });
    await flush();
    // Only the fast pass has been dispatched, and only it.
    expect(worker().posted.map((p) => p.id)).toEqual([3]);
    worker().answer(3);
    expect(worker().posted.map((p) => p.id)).toEqual([3, 1]);
    worker().answer(1);
    expect(worker().posted.map((p) => p.id)).toEqual([3, 1, 2]);
    worker().answer(2);
    const results = await Promise.all([pA, pB, pC]);
    expect(
      results.every((r) => r?.loudness === workerScript.markerLoudness),
    ).toBe(true);
    expect(inlineSpy.count).toBe(0);
  });

  it("dispatches a fast that arrives during a deep ahead of queued deeps", async () => {
    const { analyseSamplesOffThread } = await freshRunner();
    const pX = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
      depth: "deep",
    });
    await flush();
    expect(worker().posted.map((p) => p.id)).toEqual([1]);
    const pY = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
      depth: "deep",
    });
    const pZ = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
      depth: "fast",
    });
    await flush();
    // Still only the executing deep has been posted.
    expect(worker().posted.map((p) => p.id)).toEqual([1]);
    worker().answer(1);
    // The fast jumped the queued deep.
    expect(worker().posted.map((p) => p.id)).toEqual([1, 3]);
    worker().answer(3);
    expect(worker().posted.map((p) => p.id)).toEqual([1, 3, 2]);
    worker().answer(2);
    await Promise.all([pX, pY, pZ]);
    expect(inlineSpy.count).toBe(0);
  });

  it("measures the wedge timeout from dispatch, not from enqueue", async () => {
    vi.useFakeTimers();
    try {
      const { analyseSamplesOffThread } = await freshRunner();
      const pDeep = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
        depth: "deep",
      });
      await flush();
      let fastSettled = false;
      const pFast = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
        depth: "fast",
      });
      void pFast.then(() => {
        fastSettled = true;
      });
      await flush();
      expect(worker().posted.map((p) => p.id)).toEqual([1]);
      // The fast pass waits a full minute in the queue behind the
      // executing deep — queue time must not count as a wedge.
      vi.advanceTimersByTime(60_000);
      worker().answer(1);
      expect(worker().posted.map((p) => p.id)).toEqual([1, 2]);
      // 160 s since enqueue, 100 s since dispatch: still running,
      // not wedged. (Armed at enqueue, its 120 s would have fired.)
      vi.advanceTimersByTime(100_000);
      await flush();
      expect(fastSettled).toBe(false);
      worker().answer(2);
      await expect(pFast).resolves.toMatchObject({
        loudness: workerScript.markerLoudness,
      });
      await expect(pDeep).resolves.toMatchObject({
        loudness: workerScript.markerLoudness,
      });
      expect(inlineSpy.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles pending requests null on worker error, never runs inline DSP, and rebuilds for the next request", async () => {
    const { analyseSamplesOffThread } = await freshRunner();
    const pA = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
      depth: "deep",
    });
    const pB = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
      depth: "fast",
    });
    await flush();
    expect(workerScript.instances).toHaveLength(1);
    worker().fail();
    await expect(pA).resolves.toBeNull();
    await expect(pB).resolves.toBeNull();
    expect(inlineSpy.count).toBe(0);
    // The retirement did not poison the run: the next request
    // constructs a fresh worker before anything else.
    const pC = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
      depth: "fast",
    });
    await flush();
    expect(workerScript.instances).toHaveLength(2);
    worker().answer(3);
    await expect(pC).resolves.toMatchObject({
      loudness: workerScript.markerLoudness,
    });
  });

  it("settles a wedged request null without inline DSP, and the next request rebuilds the worker", async () => {
    vi.useFakeTimers();
    try {
      const { analyseSamplesOffThread } = await freshRunner();
      const pA = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
        depth: "deep",
      });
      await flush();
      vi.advanceTimersByTime(120_000);
      await expect(pA).resolves.toBeNull();
      expect(inlineSpy.count).toBe(0);
      const pB = analyseSamplesOffThread(samples(), SAMPLE_RATE, {
        depth: "fast",
      });
      await flush();
      expect(workerScript.instances).toHaveLength(2);
      worker().answer(2);
      await expect(pB).resolves.toMatchObject({
        loudness: workerScript.markerLoudness,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
