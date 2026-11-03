import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyseAudioBuffer, type TrackAnalysis } from "./analyseTrack";

// The analysis runner, tested against a scripted stand-in for the
// worker module: in "work" mode the stand-in answers with a marked
// analysis (proving the answer really came from the worker side and
// was dispatched to the right requester); in "throw" mode its
// constructor fails, and the runner must quietly produce the real
// inline analysis instead — the fallback is part of the contract.

const workerScript = vi.hoisted(() => ({
  behaviour: "work" as "work" | "throw",
  markerLoudness: 0.123456,
}));

vi.mock("./analyseTrack.worker?worker&inline", () => ({
  default: class FakeAnalyseWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;

    constructor() {
      if (workerScript.behaviour === "throw") {
        throw new Error("workers unavailable in this environment");
      }
    }

    postMessage(request: { id: number }): void {
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
      queueMicrotask(() => {
        this.onmessage?.({ data: { id: request.id, analysis } });
      });
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
