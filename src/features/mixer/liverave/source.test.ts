// source.test.ts — the track→audio seam against injected fakes.
// No network, no real decoding: the context and the byte fetcher
// are the injected seams the module is built around.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import { linerDb } from "@/shared/storage";
import { resolvePlaybackStream } from "@/features/player/engine/streamResolver";
import { audioFingerprint } from "./analyse";
import { createTrackSource, fetchTrackBytes, samplesOfBuffer } from "./source";

vi.mock("@/shared/storage", () => ({
  linerDb: { getAudio: vi.fn(async () => null) },
}));

vi.mock("@/features/player/engine/streamResolver", () => ({
  RESOLVE_TIMEOUT_MS: 25_000,
  resolvePlaybackStream: vi.fn(),
}));

function track(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    artists: "Artist",
    coverUrl: "",
    durationMs: 120_000,
    playCount: 0,
  };
}

function fakeBuffer(
  channels: Float32Array[],
  sampleRate = 22_050,
): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    duration: (channels[0]?.length ?? 0) / sampleRate,
    getChannelData: (channel: number) => channels[channel],
  } as unknown as AudioBuffer;
}

function fakeContext(buffer: AudioBuffer) {
  return {
    decodeAudioData: vi.fn(async (_data: ArrayBuffer) => buffer),
  };
}

describe("createTrackSource.resolveTrackAudio", () => {
  it("decodes the fetched bytes and returns the mono mixdown", async () => {
    const left = new Float32Array([1, 0.5, -0.5, 0]);
    const right = new Float32Array([0, 0.5, 0.5, 1]);
    const buffer = fakeBuffer([left, right]);
    const context = fakeContext(buffer);
    const source = createTrackSource({
      getContext: () => context,
      fetchBytes: vi.fn(async () => new ArrayBuffer(8)),
    });
    const resolved = await source.resolveTrackAudio(track("t1"));
    expect(resolved).not.toBeNull();
    expect(resolved?.buffer).toBe(buffer);
    expect(resolved?.sampleRate).toBe(22_050);
    // (L + R) / 2, element by element.
    expect([...(resolved?.samples ?? [])]).toEqual([0.5, 0.5, 0, 0.5]);
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it("uses a single-channel buffer's channel as-is", async () => {
    const mono = new Float32Array([0.25, -0.25]);
    const source = createTrackSource({
      getContext: () => fakeContext(fakeBuffer([mono])),
      fetchBytes: vi.fn(async () => new ArrayBuffer(4)),
    });
    const resolved = await source.resolveTrackAudio(track("t2"));
    expect([...(resolved?.samples ?? [])]).toEqual([0.25, -0.25]);
  });

  it("returns null (never throws) when the fetch fails", async () => {
    const source = createTrackSource({
      getContext: () => fakeContext(fakeBuffer([new Float32Array(4)])),
      fetchBytes: vi.fn(async () => null),
    });
    await expect(source.resolveTrackAudio(track("t3"))).resolves.toBeNull();
  });

  it("returns null when the fetcher throws", async () => {
    const source = createTrackSource({
      getContext: () => fakeContext(fakeBuffer([new Float32Array(4)])),
      fetchBytes: vi.fn(async () => {
        throw new Error("network gone");
      }),
    });
    await expect(source.resolveTrackAudio(track("t4"))).resolves.toBeNull();
  });

  it("returns null when decoding throws", async () => {
    const source = createTrackSource({
      getContext: () => ({
        decodeAudioData: vi.fn(async () => {
          throw new Error("not audio");
        }),
      }),
      fetchBytes: vi.fn(async () => new ArrayBuffer(4)),
    });
    await expect(source.resolveTrackAudio(track("t5"))).resolves.toBeNull();
  });

  it("returns null when there is no context (performer not created yet)", async () => {
    const fetchBytes = vi.fn(async () => new ArrayBuffer(4));
    const source = createTrackSource({ getContext: () => null, fetchBytes });
    await expect(source.resolveTrackAudio(track("t6"))).resolves.toBeNull();
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it("returns null for empty bytes and for a track with no id", async () => {
    const source = createTrackSource({
      getContext: () => fakeContext(fakeBuffer([new Float32Array(4)])),
      fetchBytes: vi.fn(async () => new ArrayBuffer(0)),
    });
    await expect(source.resolveTrackAudio(track("t7"))).resolves.toBeNull();
    await expect(
      source.resolveTrackAudio({ ...track(""), id: "" }),
    ).resolves.toBeNull();
  });
});

describe("createTrackSource — the attribution bridge write", () => {
  it("records (trackId → audioHash) with the fingerprint of the exact samples resolved", async () => {
    const mono = new Float32Array([0.25, -0.25, 0.5, -0.5]);
    const recordAttribution = vi.fn(async () => {});
    const source = createTrackSource({
      getContext: () => fakeContext(fakeBuffer([mono])),
      fetchBytes: vi.fn(async () => new ArrayBuffer(4)),
      recordAttribution,
    });
    const resolved = await source.resolveTrackAudio(track("bridge-1"));
    const expectedHash = audioFingerprint(mono, 22_050);
    expect(resolved?.audioHash).toBe(expectedHash);
    expect(recordAttribution).toHaveBeenCalledTimes(1);
    expect(recordAttribution).toHaveBeenCalledWith("bridge-1", expectedHash);
  });

  it("a failing bridge write never costs the resolution its audio", async () => {
    const mono = new Float32Array([0.25, -0.25]);
    const source = createTrackSource({
      getContext: () => fakeContext(fakeBuffer([mono])),
      fetchBytes: vi.fn(async () => new ArrayBuffer(4)),
      recordAttribution: vi.fn(async () => {
        throw new Error("bridge store gone");
      }),
    });
    const resolved = await source.resolveTrackAudio(track("bridge-2"));
    expect(resolved).not.toBeNull();
    expect(resolved?.audioHash).toBe(audioFingerprint(mono, 22_050));
  });

  it("a bridge write that never settles never stalls the resolution (0.1.21)", async () => {
    const mono = new Float32Array([0.25, -0.25]);
    const source = createTrackSource({
      getContext: () => fakeContext(fakeBuffer([mono])),
      fetchBytes: vi.fn(async () => new ArrayBuffer(4)),
      recordAttribution: vi.fn(() => new Promise<void>(() => {})),
    });
    const outcome = await Promise.race([
      source
        .resolveTrackAudio(track("bridge-hang"))
        .then((resolved) => ({ settled: true as const, resolved })),
      new Promise<{ settled: false }>((resolveRace) =>
        setTimeout(() => resolveRace({ settled: false }), 500),
      ),
    ]);
    expect(outcome.settled).toBe(true);
    if (outcome.settled) {
      expect(outcome.resolved?.audioHash).toBe(audioFingerprint(mono, 22_050));
    }
  });

  it("records nothing when the track never resolves", async () => {
    const recordAttribution = vi.fn(async () => {});
    const source = createTrackSource({
      getContext: () => fakeContext(fakeBuffer([new Float32Array(4)])),
      fetchBytes: vi.fn(async () => null),
      recordAttribution,
    });
    await expect(
      source.resolveTrackAudio(track("bridge-3")),
    ).resolves.toBeNull();
    expect(recordAttribution).not.toHaveBeenCalled();
  });
});

describe("fetchTrackBytes — the streamed path mirrors the player (0.1.21)", () => {
  const getAudio = vi.mocked(linerDb.getAudio);
  const resolveStream = vi.mocked(resolvePlaybackStream);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    getAudio.mockResolvedValue(null);
  });

  it("serves a cached audio blob without touching the resolver", async () => {
    const bytes = new Uint8Array([7, 8, 9]).buffer;
    getAudio.mockResolvedValue({
      blob: {
        size: 3,
        type: "audio/mpeg",
        arrayBuffer: async () => bytes,
      },
    } as unknown as Awaited<ReturnType<typeof linerDb.getAudio>>);
    await expect(fetchTrackBytes(track("cached-1"))).resolves.toBe(bytes);
    expect(resolveStream).not.toHaveBeenCalled();
  });

  it("resolves progressively (the player's call) and fetches under an abort signal", async () => {
    getAudio.mockResolvedValue(null);
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    resolveStream.mockResolvedValue({
      url: "https://streams.invalid/track.audio",
    } as unknown as Awaited<ReturnType<typeof resolvePlaybackStream>>);
    const fetchStub = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => bytes,
    }));
    vi.stubGlobal("fetch", fetchStub);
    await expect(fetchTrackBytes(track("streamed-1"))).resolves.toBe(bytes);
    expect(resolveStream).toHaveBeenCalledWith(track("streamed-1"), undefined, {
      progressive: true,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchStub.mock.calls[0] as unknown as [
      string,
      { signal?: unknown },
    ];
    expect(calledUrl).toBe("https://streams.invalid/track.audio");
    expect(calledInit.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the stream blob directly when the resolver delivers one", async () => {
    getAudio.mockResolvedValue(null);
    const bytes = new Uint8Array([5, 6]).buffer;
    resolveStream.mockResolvedValue({
      blob: {
        size: 2,
        type: "audio/mpeg",
        arrayBuffer: async () => bytes,
      },
    } as unknown as Awaited<ReturnType<typeof resolvePlaybackStream>>);
    await expect(fetchTrackBytes(track("streamed-2"))).resolves.toBe(bytes);
  });

  it("settles null (never throws) when resolution is refused", async () => {
    getAudio.mockResolvedValue(null);
    resolveStream.mockRejectedValue(new Error("resolution refused"));
    await expect(fetchTrackBytes(track("streamed-3"))).resolves.toBeNull();
  });
});

describe("samplesOfBuffer", () => {
  it("averages the first two channels and ignores the rest", () => {
    const buffer = fakeBuffer([
      new Float32Array([1, 1]),
      new Float32Array([0, 0]),
      new Float32Array([9, 9]),
    ]);
    expect([...samplesOfBuffer(buffer)]).toEqual([0.5, 0.5]);
  });
});
