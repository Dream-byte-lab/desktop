import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import {
  ANALYSIS_VERSION,
  audioFingerprint,
  type TrackAnalysis,
} from "./analyseTrack";

// trackSource's Step 5 behaviour — cache-first preparation,
// fast-then-deep progressive analysis, bounded decoded-buffer
// cache — is tested with its three collaborators replaced:
// the worker runner counts its calls, storage is an in-memory
// fake, and decoding is a stub returning constant samples. The
// fingerprinting and cache-validation code under test is real.

const harness = vi.hoisted(() => {
  const analyses = new Map<string, unknown>();
  const calls: { depth: string }[] = [];
  return { analyses, calls, failFast: false };
});

vi.mock("@/shared/storage", () => ({
  linerDb: {
    getAudio: async () => null,
    getAnalysis: async (trackId: string) =>
      harness.analyses.get(trackId) ?? null,
    putAnalysis: async (record: { trackId: string }) => {
      harness.analyses.set(record.trackId, record);
    },
    deleteAnalysis: async (trackId: string) => {
      harness.analyses.delete(trackId);
    },
  },
}));

vi.mock("../../player/engine/streamResolver", () => ({
  resolvePlaybackStream: async () => ({
    blob: new Blob([new Uint8Array([1, 2, 3])]),
  }),
}));

vi.mock("./analyseTrackRunner", () => ({
  analyseSamplesOffThread: async (
    samples: Float32Array,
    sampleRate: number,
    options: { depth?: string } = {},
  ): Promise<TrackAnalysis | null> => {
    const depth = options.depth ?? "deep";
    harness.calls.push({ depth });
    // A scripted fast-pass failure (Note 20's shell case): the deep
    // pass behind it still answers, as the real worker's would.
    if (depth === "fast" && harness.failFast) return null;
    // The real deep pass runs in a worker and takes real time; the
    // fast answer must observably come first, so the mock's deep
    // pass waits a tick of the clock rather than resolving in the
    // same microtask burst as the fast one.
    if (depth === "deep") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      beatMap: {
        bpm: 120,
        firstBeatSec: 0,
        beatsPerBar: 4,
        durationSec: 10,
        grid: { anchors: [], sections: [], confidence: 0.5 },
      },
      tempoConfidence: 0.9,
      energyCurve: [],
      drops: [],
      key: null,
      vocalRanges: [],
      loudness: 0.2,
      analysisVersion: ANALYSIS_VERSION,
      audioHash: audioFingerprint(samples, sampleRate),
      depth: depth === "fast" ? "fast" : "deep",
      sections: [],
      intro: null,
      outro: null,
    };
  },
  analyseBufferOffThread: async () => null,
}));

import { loadTrackForMixing, preparedTrack } from "./trackSource";

const SAMPLE_RATE = 44100;

class FakeOfflineAudioContext {
  async decodeAudioData(): Promise<AudioBuffer> {
    const samples = new Float32Array(SAMPLE_RATE * 10);
    for (let i = 0; i < samples.length; i += 1000) samples[i] = 0.4;
    return {
      length: samples.length,
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 1,
      duration: 10,
      getChannelData: () => samples,
    } as unknown as AudioBuffer;
  }
}

function track(id: string): Track {
  return { id } as unknown as Track;
}

beforeEach(() => {
  harness.analyses.clear();
  harness.calls.length = 0;
  harness.failFast = false;
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
});

describe("trackSource preparation (Step 5)", () => {
  it("answers fast, then deepens the same prepared entry in place", async () => {
    const prepared = await loadTrackForMixing(track("ts-a"));
    expect(prepared).not.toBeNull();
    // The answer in hand is the FAST analysis; the deep pass has
    // been started but its result has not landed yet.
    expect(prepared!.analysis.depth).toBe("fast");
    expect(harness.calls[0].depth).toBe("fast");

    await vi.waitFor(() => {
      expect(preparedTrack("ts-a")?.analysis.depth).toBe("deep");
    });
    // The object the caller already holds IS the deepened one.
    expect(prepared!.analysis.depth).toBe("deep");
    expect(harness.calls.map((c) => c.depth)).toEqual(["fast", "deep"]);
  });

  it("serves a re-preparation after eviction from the cache, analysing nothing", async () => {
    await loadTrackForMixing(track("ts-b"));
    await vi.waitFor(() => {
      expect(preparedTrack("ts-b")?.analysis.depth).toBe("deep");
    });
    // Push ts-b out of the bounded prepared cache (holds 5 since
    // Note 20 deepened the preparation horizon to two tracks).
    for (const id of ["ts-b2", "ts-b3", "ts-b4", "ts-b5", "ts-b6"]) {
      await loadTrackForMixing(track(id));
    }
    expect(preparedTrack("ts-b")).toBeUndefined();

    const callsBefore = harness.calls.length;
    const again = await loadTrackForMixing(track("ts-b"));
    expect(again).not.toBeNull();
    expect(again!.analysis.depth).toBe("deep");
    // Not one new analysis ran — the stored deep record was served.
    expect(harness.calls.length).toBe(callsBefore);
  });

  it("keeps at most five decoded tracks warm", async () => {
    for (const id of ["ts-c1", "ts-c2", "ts-c3", "ts-c4", "ts-c5", "ts-c6"]) {
      await loadTrackForMixing(track(id));
    }
    expect(preparedTrack("ts-c1")).toBeUndefined();
    expect(preparedTrack("ts-c6")).toBeDefined();
  });

  it("answers a playable shell when the decode succeeds but the analysis fails", async () => {
    harness.failFast = true;
    const prepared = await loadTrackForMixing(track("ts-shell"));
    expect(prepared).not.toBeNull();
    // Playable: the decoded buffer is right there. Not mixable: no
    // real analysis backs it, only the shell's measured facts.
    expect(prepared!.mixable).toBe(false);
    expect(prepared!.buffer.duration).toBe(10);
    expect(prepared!.analysis.loudness).toBeGreaterThan(0);
    expect(prepared!.analysis.energyCurve.length).toBeGreaterThan(0);
    expect(prepared!.analysis.beatMap.bpm).toBe(0);
    // The shell is never written to the analysis cache.
    expect(harness.analyses.has("ts-shell")).toBe(false);
  });

  it("upgrades a shell in place when the background analysis lands", async () => {
    harness.failFast = true;
    const prepared = await loadTrackForMixing(track("ts-upgrade"));
    expect(prepared).not.toBeNull();
    expect(prepared!.mixable).toBe(false);

    // The deep pass behind the failed fast pass lands and flips the
    // very object the caller already holds to a mixable entry.
    await vi.waitFor(() => {
      expect(preparedTrack("ts-upgrade")?.mixable).toBe(true);
    });
    expect(prepared!.mixable).toBe(true);
    expect(prepared!.analysis.depth).toBe("deep");
  });
});
