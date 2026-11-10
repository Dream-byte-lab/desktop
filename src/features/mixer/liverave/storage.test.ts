import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYSIS_VERSION } from "./analyse";
import type { TrackRead } from "./facts";
import {
  BEHAVIOUR_CAP,
  LIVERAVE_DB_OPEN_TIMEOUT_MS,
  MemoryEngineStorageBackend,
  createEngineStorage,
  pairStoreKey,
  readStoreKey,
  type BehaviourRecord,
} from "./storage";

function makeRead(overrides: Partial<TrackRead> = {}): TrackRead {
  return {
    audioHash: "hash-a",
    analysisVersion: ANALYSIS_VERSION,
    depth: "deep",
    durationSec: 120,
    bpm: 122,
    tempoConfidence: 0.7,
    grid: { beatsMs: [], downbeatsMs: [], beatsPerBar: 4, confidence: 0.6 },
    key: { tonic: 9, mode: "minor", camelot: "8A", confidence: 0.8 },
    sections: [],
    energyCurvePerSec: [],
    energyContour: [],
    vocalActivity: [],
    drops: [],
    loudnessRms: 0.2,
    ...overrides,
  };
}

function makeBehaviour(at: number): BehaviourRecord {
  return {
    at,
    family: "blend",
    fxKinds: [],
    pairTrackIds: ["track-a", "track-b"],
    suitability: 0.8,
    poolSize: 4,
    reason: "performed",
  };
}

describe("storage — reads store with version/fingerprint gates", () => {
  it("round-trips a read under (hash, version, depth)", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    await storage.putRead(makeRead());
    const got = await storage.getRead("hash-a", "deep");
    expect(got?.bpm).toBe(122);
    expect(got?.audioHash).toBe("hash-a");
  });

  it("a different depth or an unknown hash serves null", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    await storage.putRead(makeRead());
    expect(await storage.getRead("hash-a", "fast")).toBeNull();
    expect(await storage.getRead("other-hash", "deep")).toBeNull();
  });

  it("a stale-version envelope under the current key serves null", async () => {
    const backend = new MemoryEngineStorageBackend();
    const storage = createEngineStorage(backend);
    const key = readStoreKey("hash-a", "deep");
    await backend.put("reads", key, {
      key,
      audioHash: "hash-a",
      analysisVersion: 999,
      depth: "deep",
      read: makeRead({ analysisVersion: 999 }),
      storedAt: 0,
    });
    expect(await storage.getRead("hash-a", "deep")).toBeNull();
  });

  it("an envelope whose payload disagrees with its key serves null", async () => {
    const backend = new MemoryEngineStorageBackend();
    const storage = createEngineStorage(backend);
    const key = readStoreKey("hash-a", "deep");
    await backend.put("reads", key, {
      key,
      audioHash: "hash-a",
      analysisVersion: ANALYSIS_VERSION,
      depth: "deep",
      read: makeRead({ audioHash: "someone-else" }),
      storedAt: 0,
    });
    expect(await storage.getRead("hash-a", "deep")).toBeNull();
  });
});

describe("storage — listReads enumeration (the feed's seam)", () => {
  it("enumerates every gated read, keyed by nothing but its hash", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    await storage.putRead(makeRead({ audioHash: "hash-a" }));
    await storage.putRead(makeRead({ audioHash: "hash-b", bpm: 98 }));
    const reads = await storage.listReads();
    expect(reads.map((read) => read.audioHash).sort()).toEqual([
      "hash-a",
      "hash-b",
    ]);
    expect(reads.find((read) => read.audioHash === "hash-b")?.bpm).toBe(98);
  });

  it("prefers the deep read when both depths are stored for one hash", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    await storage.putRead(
      makeRead({ audioHash: "hash-a", depth: "fast", bpm: 100 }),
    );
    await storage.putRead(
      makeRead({ audioHash: "hash-a", depth: "deep", bpm: 122 }),
    );
    const reads = await storage.listReads();
    expect(reads).toHaveLength(1);
    expect(reads[0].depth).toBe("deep");
    expect(reads[0].bpm).toBe(122);
  });

  it("skips stale-version envelopes instead of serving them", async () => {
    const backend = new MemoryEngineStorageBackend();
    const storage = createEngineStorage(backend);
    await storage.putRead(makeRead({ audioHash: "hash-good" }));
    const key = readStoreKey("hash-stale", "deep", 999);
    await backend.put("reads", key, {
      key,
      audioHash: "hash-stale",
      analysisVersion: 999,
      depth: "deep",
      read: makeRead({ audioHash: "hash-stale", analysisVersion: 999 }),
      storedAt: 0,
    });
    const reads = await storage.listReads();
    expect(reads.map((read) => read.audioHash)).toEqual(["hash-good"]);
  });

  it("skips an envelope whose payload disagrees with its key", async () => {
    const backend = new MemoryEngineStorageBackend();
    const storage = createEngineStorage(backend);
    const key = readStoreKey("hash-a", "deep");
    await backend.put("reads", key, {
      key,
      audioHash: "hash-a",
      analysisVersion: ANALYSIS_VERSION,
      depth: "deep",
      read: makeRead({ audioHash: "someone-else" }),
      storedAt: 0,
    });
    expect(await storage.listReads()).toEqual([]);
  });

  it("is empty when nothing is stored", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    expect(await storage.listReads()).toEqual([]);
  });
});

describe("storage — pairSets store", () => {
  it("round-trips a pair document with both fingerprints returned", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    await storage.putPairSet("hash-a", "hash-b", { note: "doc-1" });
    const got = await storage.getPairSet<{ note: string }>("hash-a", "hash-b");
    expect(got?.pairSet.note).toBe("doc-1");
    expect(got?.aHash).toBe("hash-a");
    expect(got?.bHash).toBe("hash-b");
    expect(got?.analysisVersion).toBe(ANALYSIS_VERSION);
    // Order matters: the reversed pair is a different key.
    expect(await storage.getPairSet("hash-b", "hash-a")).toBeNull();
  });

  it("a pair envelope with a mismatched fingerprint serves null", async () => {
    const backend = new MemoryEngineStorageBackend();
    const storage = createEngineStorage(backend);
    const key = pairStoreKey("hash-a", "hash-b");
    await backend.put("pairSets", key, {
      key,
      aHash: "hash-a",
      bHash: "tampered",
      analysisVersion: ANALYSIS_VERSION,
      pairSet: { note: "bad" },
      storedAt: 0,
    });
    expect(await storage.getPairSet("hash-a", "hash-b")).toBeNull();
  });
});

describe("storage — the trackHashes attribution bridge", () => {
  it("round-trips a (trackId → audioHash) pair, per track and enumerated", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    await storage.recordTrackHash("track-a", "hash-a");
    await storage.recordTrackHash("track-b", "hash-b");
    expect(await storage.getTrackHash("track-a")).toBe("hash-a");
    expect(await storage.getTrackHash("track-b")).toBe("hash-b");
    expect(await storage.getTrackHash("track-never-resolved")).toBeNull();
    const all = await storage.listTrackHashes();
    expect(all.get("track-a")).toBe("hash-a");
    expect(all.get("track-b")).toBe("hash-b");
    expect(all.size).toBe(2);
  });

  it("latest write wins: a track re-resolved to new audio is bridged to the new hash", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    await storage.recordTrackHash("track-a", "hash-old");
    await storage.recordTrackHash("track-a", "hash-new");
    expect(await storage.getTrackHash("track-a")).toBe("hash-new");
    expect((await storage.listTrackHashes()).get("track-a")).toBe("hash-new");
  });

  it("ignores empty ids and hashes rather than storing a hollow pair", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    await storage.recordTrackHash("", "hash-a");
    await storage.recordTrackHash("track-a", "");
    expect(await storage.listTrackHashes()).toEqual(new Map());
    expect(await storage.getTrackHash("")).toBeNull();
  });

  it("an envelope whose payload disagrees with its key serves nothing", async () => {
    const backend = new MemoryEngineStorageBackend();
    const storage = createEngineStorage(backend);
    await backend.put("trackHashes", "track-a", {
      key: "track-a",
      trackId: "someone-else",
      audioHash: "hash-a",
      storedAt: 0,
    });
    await backend.put("trackHashes", "track-b", {
      key: "track-b",
      trackId: "track-b",
      audioHash: "",
      storedAt: 0,
    });
    expect(await storage.getTrackHash("track-a")).toBeNull();
    expect(await storage.listTrackHashes()).toEqual(new Map());
  });

  it("the bridge never touches the reads store: a bridged hash with no read stays a hash only", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    await storage.recordTrackHash("track-a", "hash-a");
    expect(await storage.getRead("hash-a", "deep")).toBeNull();
    expect(await storage.listReads()).toEqual([]);
  });
});

describe("storage — behaviour log", () => {
  it("appends in order and caps at 400, dropping the oldest", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    for (let i = 0; i < BEHAVIOUR_CAP + 5; i += 1) {
      await storage.appendBehaviour(makeBehaviour(i));
    }
    const log = await storage.listBehaviour();
    expect(log).toHaveLength(BEHAVIOUR_CAP);
    expect(log[0].at).toBe(5);
    expect(log[log.length - 1].at).toBe(BEHAVIOUR_CAP + 4);
  });

  it("clearAll empties all four stores", async () => {
    const storage = createEngineStorage(new MemoryEngineStorageBackend());
    await storage.putRead(makeRead());
    await storage.putPairSet("hash-a", "hash-b", { x: 1 });
    await storage.appendBehaviour(makeBehaviour(1));
    await storage.recordTrackHash("track-a", "hash-a");
    await storage.clearAll();
    expect(await storage.getRead("hash-a", "deep")).toBeNull();
    expect(await storage.getPairSet("hash-a", "hash-b")).toBeNull();
    expect(await storage.listBehaviour()).toEqual([]);
    expect(await storage.listTrackHashes()).toEqual(new Map());
  });
});

// ---------------------------------------------------------------------
// The IndexedDB open itself (0.1.21): a blocked or hung open must
// reject, named and bounded — never hang silently. Driven against a
// stubbed global indexedDB; jsdom provides none of its own.
// ---------------------------------------------------------------------

class FakeResultRequest {
  result: unknown = undefined;
  error: unknown = null;
  onerror: (() => void) | null = null;
  onblocked: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  private successHandler: (() => void) | null = null;
  set onsuccess(handler: (() => void) | null) {
    this.successHandler = handler;
    if (handler) queueMicrotask(() => handler());
  }
  get onsuccess(): (() => void) | null {
    return this.successHandler;
  }
}

class FakeOpenRequest {
  result: unknown = undefined;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onblocked: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

function makeFakeDb() {
  const store = {
    get: () => new FakeResultRequest(),
    put: () => new FakeResultRequest(),
    add: () => new FakeResultRequest(),
    delete: () => new FakeResultRequest(),
    clear: () => new FakeResultRequest(),
    getAllKeys: () => new FakeResultRequest(),
    getAll: () => new FakeResultRequest(),
  };
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    close: vi.fn(),
    onversionchange: null as (() => void) | null,
    transaction: () => ({
      objectStore: () => store,
      set oncomplete(handler: (() => void) | null) {
        if (handler) queueMicrotask(() => handler());
      },
      onerror: null,
      onabort: null,
    }),
  };
  return db;
}

describe("storage — the IndexedDB open is bounded and surfaces blocks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubIndexedDb(open: () => FakeOpenRequest) {
    vi.stubGlobal("indexedDB", { open });
  }

  it("rejects, named, when another connection blocks the open — and a later call retries", async () => {
    const requests: FakeOpenRequest[] = [];
    stubIndexedDb(() => {
      const request = new FakeOpenRequest();
      requests.push(request);
      return request;
    });
    const storage = createEngineStorage();
    const attempt = storage.getTrackHash("track-x");
    expect(requests).toHaveLength(1);
    requests[0].onblocked?.();
    await expect(attempt).rejects.toThrow(/blocked by another open connection/);
    // The failed open is not cached: the next call opens afresh.
    const retry = storage.getTrackHash("track-x");
    expect(requests).toHaveLength(2);
    requests[1].onblocked?.();
    await expect(retry).rejects.toThrow(/blocked/);
  });

  it("rejects, named, when the open never settles inside the bound", async () => {
    vi.useFakeTimers();
    stubIndexedDb(() => new FakeOpenRequest());
    const storage = createEngineStorage();
    const attempt = storage.getTrackHash("track-x");
    const expectation = expect(attempt).rejects.toThrow(
      new RegExp(`timed out after ${LIVERAVE_DB_OPEN_TIMEOUT_MS} ms`),
    );
    await vi.advanceTimersByTimeAsync(LIVERAVE_DB_OPEN_TIMEOUT_MS);
    await expectation;
  });

  it("an established connection closes itself on versionchange", async () => {
    const db = makeFakeDb();
    stubIndexedDb(() => {
      const request = new FakeOpenRequest();
      request.result = db;
      queueMicrotask(() => request.onsuccess?.());
      return request;
    });
    const storage = createEngineStorage();
    await expect(storage.getTrackHash("track-x")).resolves.toBeNull();
    expect(typeof db.onversionchange).toBe("function");
    db.onversionchange?.();
    expect(db.close).toHaveBeenCalledTimes(1);
  });
});
