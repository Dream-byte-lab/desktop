import { describe, expect, it } from "vitest";
import { linerDb } from "@/shared/storage";
import { ANALYSIS_VERSION, type TrackAnalysis } from "./analyseTrack";
import {
  deleteCachedAnalysis,
  getCachedAnalysis,
  putCachedAnalysis,
} from "./analysisCache";

// The cache's trust rule is the whole point: a stored analysis is
// served only when its version AND its audio fingerprint match the
// audio in hand. These tests run against linerDb's in-memory
// fallback (the test environment has no IndexedDB) — the rule lives
// in this module, not in the storage layer.

function fakeAnalysis(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    beatMap: {
      bpm: 120,
      firstBeatSec: 0,
      beatsPerBar: 4,
      durationSec: 60,
      grid: { anchors: [], sections: [], confidence: 0.5 },
    },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: null,
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: ANALYSIS_VERSION,
    audioHash: "hash-a",
    depth: "deep",
    sections: [],
    intro: null,
    outro: null,
    ...overrides,
  };
}

describe("analysisCache", () => {
  it("serves back what was stored, with its depth", async () => {
    await putCachedAnalysis("cache-t1", fakeAnalysis());
    const hit = await getCachedAnalysis("cache-t1", "hash-a");
    expect(hit).not.toBeNull();
    expect(hit!.depth).toBe("deep");
    expect(hit!.analysis.beatMap.bpm).toBe(120);
  });

  it("refuses an analysis whose fingerprint is not this audio", async () => {
    await putCachedAnalysis("cache-t2", fakeAnalysis());
    expect(await getCachedAnalysis("cache-t2", "hash-other")).toBeNull();
  });

  it("refuses a record from an older analysis version", async () => {
    await linerDb.putAnalysis({
      trackId: "cache-t3",
      audioHash: "hash-a",
      analysisVersion: ANALYSIS_VERSION - 1,
      depth: "deep",
      analysis: fakeAnalysis({ analysisVersion: ANALYSIS_VERSION - 1 }),
      savedAt: Date.now(),
    });
    expect(await getCachedAnalysis("cache-t3", "hash-a")).toBeNull();
  });

  it("refuses a record whose embedded analysis disagrees with its key", async () => {
    await linerDb.putAnalysis({
      trackId: "cache-t4",
      audioHash: "hash-a",
      analysisVersion: ANALYSIS_VERSION,
      depth: "deep",
      analysis: fakeAnalysis({ audioHash: "hash-different" }),
      savedAt: Date.now(),
    });
    expect(await getCachedAnalysis("cache-t4", "hash-a")).toBeNull();
  });

  it("keeps fast and deep records distinct", async () => {
    await putCachedAnalysis(
      "cache-t5",
      fakeAnalysis({ depth: "fast", audioHash: "hash-f" }),
    );
    const hit = await getCachedAnalysis("cache-t5", "hash-f");
    expect(hit!.depth).toBe("fast");
  });

  it("deletes on request and misses cleanly when absent", async () => {
    await putCachedAnalysis("cache-t6", fakeAnalysis());
    await deleteCachedAnalysis("cache-t6");
    expect(await getCachedAnalysis("cache-t6", "hash-a")).toBeNull();
    expect(await getCachedAnalysis("cache-never", "hash-a")).toBeNull();
  });

  it("never stores an analysis that cannot prove its audio", async () => {
    await putCachedAnalysis("cache-t7", fakeAnalysis({ audioHash: undefined }));
    expect(await getCachedAnalysis("cache-t7", "hash-a")).toBeNull();
  });
});
