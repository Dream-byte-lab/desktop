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
  return {
    analyses,
    calls,
    failFast: false,
    // Note 29 Fix C: a fast pass that hangs until the test
    // releases it, so a preparation can sit in the timed-out
    // shell state while the prepared map churns around it.
    hangFast: false,
    fastResolvers: [] as Array<() => void>,
  };
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

vi.mock("./analyseTrackRunner", () => {
  const buildAnalysis = (
    samples: Float32Array,
    sampleRate: number,
    depth: string,
  ): TrackAnalysis => ({
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
  });
  return {
    analyseSamplesOffThread: async (
      samples: Float32Array,
      sampleRate: number,
      options: { depth?: string } = {},
    ): Promise<TrackAnalysis | null> => {
      const depth = options.depth ?? "deep";
      harness.calls.push({ depth });
      // A scripted fast pass that hangs until the test releases
      // it (Note 29 Fix C's eviction window).
      if (depth === "fast" && harness.hangFast) {
        return new Promise<TrackAnalysis | null>((resolve) => {
          harness.fastResolvers.push(() => {
            resolve(buildAnalysis(samples, sampleRate, "fast"));
          });
        });
      }
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
      return buildAnalysis(samples, sampleRate, depth);
    },
    analyseBufferOffThread: async () => null,
  };
});

import {
  ANALYSIS_WAIT_MS,
  loadTrackForMixing,
  preparedTrack,
} from "./trackSource";

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
  harness.hangFast = false;
  harness.fastResolvers.length = 0;
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

// Note 29 Fix C: deepen() re-checks that the prepared entry is
// still held BEFORE spending the deep pass, not only when the
// pass lands — an entry evicted during heavy preparation must
// not consume worker time nobody will read.
describe("trackSource deepen start check (Note 29 Fix C)", () => {
  it("starts exactly one deep pass for an entry that is still held", async () => {
    await loadTrackForMixing(track("ts-held"));
    await vi.waitFor(() => {
      expect(preparedTrack("ts-held")?.analysis.depth).toBe("deep");
    });
    expect(harness.calls.filter((call) => call.depth === "deep")).toHaveLength(
      1,
    );
  });

  it("sends no deep request for an entry evicted before its deepen could start", async () => {
    vi.useFakeTimers();
    try {
      harness.hangFast = true;
      // A preparation whose fast pass outlasts the wait: it
      // answers with the timed-out shell, and the deepen behind
      // it can only begin when the fast pass finally lands.
      const first = loadTrackForMixing(track("ts-evicted"));
      await vi.advanceTimersByTimeAsync(ANALYSIS_WAIT_MS + 1);
      const shell = await first;
      expect(shell?.mixable).toBe(false);

      // Churn the bounded prepared map (holds five) until the
      // shell is evicted — the heavy-preparation case.
      for (const id of ["ts-x1", "ts-x2", "ts-x3", "ts-x4", "ts-x5"]) {
        const pendingLoad = loadTrackForMixing(track(id));
        await vi.advanceTimersByTimeAsync(ANALYSIS_WAIT_MS + 1);
        await pendingLoad;
      }
      expect(preparedTrack("ts-evicted")).toBeUndefined();
      expect(
        harness.calls.filter((call) => call.depth === "deep"),
      ).toHaveLength(0);

      // The evicted track's fast pass finally lands. Its
      // continuation reaches deepen() — and the start check
      // refuses: no deep request ever reaches the runner.
      harness.fastResolvers[0]();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(
        harness.calls.filter((call) => call.depth === "deep"),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
