import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis } from "./analyseTrack";
import type { PreparedTrack } from "./trackSource";

// trackSource's rendition cache (the stretch integration): a
// recipe's stretchB is served by a pre-rendered, pitch-preserved
// copy of the incoming track, rendered off-thread and cached under
// its own bound. Tested with the stretch runner replaced by a
// counting fake that scales channel lengths by the factor, and a
// fake buffer/context pair that records what was built.

const harness = vi.hoisted(() => {
  const calls: { factor: number; channels: number }[] = [];
  let failNext = false;
  return {
    calls,
    failNext: () => {
      failNext = true;
    },
    reset: () => {
      calls.length = 0;
      failNext = false;
    },
    shouldFail: () => {
      const fail = failNext;
      failNext = false;
      return fail;
    },
  };
});

vi.mock("@/shared/storage", () => ({
  linerDb: {
    getAudio: async () => null,
    getAnalysis: async () => null,
    putAnalysis: async () => {},
    deleteAnalysis: async () => {},
  },
}));

vi.mock("../../player/engine/streamResolver", () => ({
  resolvePlaybackStream: async () => ({
    blob: new Blob([new Uint8Array([1, 2, 3])]),
  }),
}));

vi.mock("./analyseTrackRunner", () => ({
  analyseSamplesOffThread: async () => null,
  analyseBufferOffThread: async () => null,
}));

vi.mock("./stretchTrackRunner", () => ({
  stretchChannelsOffThread: async (
    channels: Float32Array[],
    _sampleRate: number,
    factor: number,
  ): Promise<Float32Array[] | null> => {
    harness.calls.push({ factor, channels: channels.length });
    if (harness.shouldFail()) return null;
    return channels.map(
      (channel) => new Float32Array(Math.round(channel.length / factor)),
    );
  },
}));

import { loadStretchRendition, stretchRendition } from "./trackSource";

const SAMPLE_RATE = 44100;

class FakeBuffer {
  readonly numberOfChannels: number;
  readonly sampleRate = SAMPLE_RATE;
  readonly length: number;
  private readonly data: Float32Array[];

  constructor(channels: Float32Array[]) {
    this.data = channels;
    this.numberOfChannels = channels.length;
    this.length = channels[0]?.length ?? 0;
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(index: number): Float32Array {
    return this.data[index];
  }

  copyToChannel(source: Float32Array, index: number): void {
    this.data[index] = source;
  }
}

class FakeOfflineAudioContext {
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): FakeBuffer {
    void sampleRate;
    const data = Array.from(
      { length: channels },
      () => new Float32Array(length),
    );
    return new FakeBuffer(data);
  }
}

function prepared(id: string, seconds = 10): PreparedTrack {
  const frames = seconds * SAMPLE_RATE;
  const buffer = new FakeBuffer([
    new Float32Array(frames),
    new Float32Array(frames),
  ]);
  return {
    track: { id } as unknown as Track,
    buffer: buffer as unknown as AudioBuffer,
    analysis: {} as unknown as TrackAnalysis,
  };
}

beforeEach(() => {
  harness.reset();
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
});

describe("trackSource renditions (stretch integration)", () => {
  it("renders a rendition at the factor and caches it by track and factor", async () => {
    const source = prepared("rend-a");
    const rendition = await loadStretchRendition(source, 1.1);
    expect(rendition).not.toBeNull();
    // 10 s at 1.1× → 10/1.1 s of audio.
    expect(rendition!.duration).toBeCloseTo(10 / 1.1, 3);
    expect(harness.calls).toEqual([{ factor: 1.1, channels: 2 }]);

    // A second ask is the cache's answer — no new render.
    const again = await loadStretchRendition(source, 1.1);
    expect(again).toBe(rendition);
    expect(harness.calls).toHaveLength(1);
    expect(stretchRendition("rend-a", 1.1)).toBe(rendition);

    // A different factor is a different rendition.
    const other = await loadStretchRendition(source, 0.94);
    expect(other).not.toBe(rendition);
    expect(other!.duration).toBeCloseTo(10 / 0.94, 3);
    expect(harness.calls).toHaveLength(2);
  });

  it("keeps at most two renditions warm — the eldest is evicted", async () => {
    const a = prepared("rend-b1");
    const b = prepared("rend-b2");
    const c = prepared("rend-b3");
    await loadStretchRendition(a, 1.1);
    await loadStretchRendition(b, 1.1);
    await loadStretchRendition(c, 1.1);
    expect(stretchRendition("rend-b1", 1.1)).toBeUndefined();
    expect(stretchRendition("rend-b2", 1.1)).toBeDefined();
    expect(stretchRendition("rend-b3", 1.1)).toBeDefined();
  });

  it("refuses non-rendition factors without rendering", async () => {
    const source = prepared("rend-c");
    expect(await loadStretchRendition(source, 1)).toBeNull();
    expect(await loadStretchRendition(source, 2.5)).toBeNull();
    expect(await loadStretchRendition(source, Number.NaN)).toBeNull();
    expect(harness.calls).toHaveLength(0);
  });

  it("a failed render answers null and caches nothing", async () => {
    const source = prepared("rend-d");
    harness.failNext();
    expect(await loadStretchRendition(source, 1.1)).toBeNull();
    expect(stretchRendition("rend-d", 1.1)).toBeUndefined();
    // And a later ask may retry the render honestly.
    const retry = await loadStretchRendition(source, 1.1);
    expect(retry).not.toBeNull();
    expect(harness.calls).toHaveLength(2);
  });
});
