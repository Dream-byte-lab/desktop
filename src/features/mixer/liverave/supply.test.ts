import { describe, expect, it, vi } from "vitest";
import { ANALYSIS_VERSION, audioFingerprint } from "./analyse";
import type { TrackFacts, TrackRead } from "./facts";
import type { JoinRecipe } from "./recipe";
import { NEUTRAL_SHAPING } from "./shaping";
import { pairStoreKey, readStoreKey, type StoredPairSet } from "./storage";
import {
  buildPairCandidatesEnvelope,
  buildTrackReadEnvelope,
  createServerClient,
  createSupply,
  type AuthorCandidatesFn,
  type ContributionOutcome,
  type PairDocument,
  type ServerClient,
  type SupplyStorage,
} from "./supply";

const SAMPLE_RATE = 22050;

function samples(): Float32Array {
  const out = new Float32Array(4096);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = 0.4 * Math.sin((2 * Math.PI * i) / 32);
  }
  return out;
}

function hashOf(data: Float32Array): string {
  return audioFingerprint(data, SAMPLE_RATE);
}

function makeRead(
  audioHash: string,
  depth: "fast" | "deep" = "deep",
): TrackRead {
  return {
    audioHash,
    analysisVersion: ANALYSIS_VERSION,
    depth,
    durationSec: 120,
    bpm: 124,
    tempoConfidence: 0.8,
    grid: { beatsMs: [], downbeatsMs: [], beatsPerBar: 4, confidence: 0.8 },
    key: null,
    sections: [],
    energyCurvePerSec: [],
    energyContour: [],
    vocalActivity: [],
    drops: [],
    loudnessRms: 0.2,
  };
}

function fakeStorage(overrides: Record<string, unknown> = {}): SupplyStorage & {
  getRead: ReturnType<typeof vi.fn>;
  putRead: ReturnType<typeof vi.fn>;
  getPairSet: ReturnType<typeof vi.fn>;
  putPairSet: ReturnType<typeof vi.fn>;
} {
  return {
    getRead: vi.fn(async () => null),
    putRead: vi.fn(async () => {}),
    getPairSet: vi.fn(async () => null),
    putPairSet: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

function fakeFacts(trackId: string, audioHash: string | null): TrackFacts {
  return { trackId, audioHash } as unknown as TrackFacts;
}

/**
 * Fresh upload stubs for ServerClient literals whose tests are
 * about the fetch side: contribution simply never lands there.
 */
function uploadStubs(): Pick<
  ServerClient,
  "uploadTrackRead" | "uploadPairCandidates"
> & {
  uploadTrackRead: ReturnType<typeof vi.fn>;
  uploadPairCandidates: ReturnType<typeof vi.fn>;
} {
  return {
    uploadTrackRead: vi.fn(async () => "failed" as const),
    uploadPairCandidates: vi.fn(async () => "failed" as const),
  };
}

const FAKE_RECIPE = { id: "join-1" } as unknown as JoinRecipe;

function fetchReturning(body: unknown, ok = true) {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("createServerClient — track reads", () => {
  it("returns a validated read and hits the track endpoint", async () => {
    const read = makeRead("hash-a");
    const fetchImpl = fetchReturning({
      kind: "linerave.track-read",
      version: 1,
      audioHash: "hash-a",
      analysisVersion: ANALYSIS_VERSION,
      depth: "deep",
      read,
    });
    const client = createServerClient("https://mix.example/", fetchImpl);
    await expect(client.fetchTrackRead("hash-a")).resolves.toEqual(read);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mix.example/v1/tracks/hash-a",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("treats wrong kind, wrong version and fingerprint mismatch as misses", async () => {
    const read = makeRead("hash-a");
    for (const body of [
      {
        kind: "other",
        version: 1,
        audioHash: "hash-a",
        analysisVersion: ANALYSIS_VERSION,
        read,
      },
      {
        kind: "linerave.track-read",
        version: 2,
        audioHash: "hash-a",
        analysisVersion: ANALYSIS_VERSION,
        read,
      },
      {
        kind: "linerave.track-read",
        version: 1,
        audioHash: "hash-a",
        analysisVersion: 999,
        read,
      },
      {
        kind: "linerave.track-read",
        version: 1,
        audioHash: "hash-b",
        analysisVersion: ANALYSIS_VERSION,
        read,
      },
      {
        kind: "linerave.track-read",
        version: 1,
        audioHash: "hash-a",
        analysisVersion: ANALYSIS_VERSION,
        read: { ...read, audioHash: "hash-b" },
      },
      null,
      "garbage",
    ]) {
      const client = createServerClient(
        "https://mix.example",
        fetchReturning(body),
      );
      await expect(client.fetchTrackRead("hash-a")).resolves.toBeNull();
    }
  });

  it("treats HTTP errors and network throws as misses, never throws", async () => {
    const httpClient = createServerClient(
      "https://mix.example",
      fetchReturning({}, false),
    );
    await expect(httpClient.fetchTrackRead("hash-a")).resolves.toBeNull();
    const throwing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const netClient = createServerClient("https://mix.example", throwing);
    await expect(netClient.fetchTrackRead("hash-a")).resolves.toBeNull();
  });
});

describe("createServerClient — pair candidates", () => {
  const envelope = {
    kind: "linerave.pair-candidates",
    version: 1,
    pair: {
      aAudioHash: "hash-a",
      bAudioHash: "hash-b",
      analysisVersion: ANALYSIS_VERSION,
    },
    arcPosition: 0.4,
    candidates: [FAKE_RECIPE],
    rejected: [{ family: "blend", reason: "no" }],
  };

  it("posts {a, b, arcPosition} and returns validated candidates", async () => {
    const fetchImpl = fetchReturning(envelope);
    const client = createServerClient("https://mix.example", fetchImpl);
    const got = await client.fetchPairCandidates("hash-a", "hash-b", 0.4);
    expect(got?.candidates).toEqual([FAKE_RECIPE]);
    expect(got?.rejected).toEqual([{ family: "blend", reason: "no" }]);
    expect(got?.arcPosition).toBe(0.4);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      a: "hash-a",
      b: "hash-b",
      arcPosition: 0.4,
    });
  });

  it("treats fingerprint or version garbage as a miss", async () => {
    for (const body of [
      { ...envelope, kind: "nope" },
      { ...envelope, pair: { ...envelope.pair, bAudioHash: "hash-c" } },
      { ...envelope, pair: { ...envelope.pair, analysisVersion: 42 } },
      { ...envelope, candidates: "not-an-array" },
    ]) {
      const client = createServerClient(
        "https://mix.example",
        fetchReturning(body),
      );
      await expect(
        client.fetchPairCandidates("hash-a", "hash-b", 0.4),
      ).resolves.toBeNull();
    }
  });
});

describe("supply — reads: precedence cache > server > local", () => {
  it("a cache hit never calls the server or the runner", async () => {
    const data = samples();
    const read = makeRead(hashOf(data));
    const storage = fakeStorage({
      getRead: vi.fn(async () => read),
    });
    const server: ServerClient = {
      ...uploadStubs(),
      fetchTrackRead: vi.fn(async () => makeRead(hashOf(data))),
      fetchPairCandidates: vi.fn(async () => null),
    };
    const runner = { analyse: vi.fn(async () => makeRead(hashOf(data))) };
    const supply = createSupply({
      storage,
      server,
      runner,
      isServerEnabled: () => true,
    });
    const got = await supply.supplyRead({
      samples: data,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    expect(got).toEqual({ read, source: "cache" });
    expect(server.fetchTrackRead).not.toHaveBeenCalled();
    expect(runner.analyse).not.toHaveBeenCalled();
  });

  it("a server hit writes through to storage and skips the runner", async () => {
    const data = samples();
    const read = makeRead(hashOf(data));
    const storage = fakeStorage();
    const server: ServerClient = {
      ...uploadStubs(),
      fetchTrackRead: vi.fn(async () => read),
      fetchPairCandidates: vi.fn(async () => null),
    };
    const runner = { analyse: vi.fn(async () => makeRead(hashOf(data))) };
    const supply = createSupply({
      storage,
      server,
      runner,
      isServerEnabled: () => true,
    });
    const got = await supply.supplyRead({
      samples: data,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    expect(got).toEqual({ read, source: "server" });
    expect(storage.putRead).toHaveBeenCalledWith(read);
    expect(runner.analyse).not.toHaveBeenCalled();
  });

  it("the disabled switch never calls the server; local analysis stores its read", async () => {
    const data = samples();
    const read = makeRead(hashOf(data));
    const storage = fakeStorage();
    const server: ServerClient = {
      ...uploadStubs(),
      fetchTrackRead: vi.fn(async () => read),
      fetchPairCandidates: vi.fn(async () => null),
    };
    const runner = { analyse: vi.fn(async () => read) };
    const supply = createSupply({
      storage,
      server,
      runner,
      isServerEnabled: () => false,
    });
    const got = await supply.supplyRead({
      samples: data,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    expect(got).toEqual({ read, source: "local" });
    expect(server.fetchTrackRead).not.toHaveBeenCalled();
    expect(runner.analyse).toHaveBeenCalledWith({
      key: hashOf(data),
      samples: data,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    expect(storage.putRead).toHaveBeenCalledWith(read);
  });

  it("server garbage (a client miss) falls back to local analysis", async () => {
    const data = samples();
    const read = makeRead(hashOf(data));
    const garbageClient = createServerClient(
      "https://mix.example",
      fetchReturning({ kind: "linerave.track-read", version: 99 }),
    );
    const runner = { analyse: vi.fn(async () => read) };
    const supply = createSupply({
      storage: fakeStorage(),
      server: garbageClient,
      runner,
      isServerEnabled: () => true,
    });
    const got = await supply.supplyRead({
      samples: data,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    expect(got).toEqual({ read, source: "local" });
  });

  it("total failure — cache, server and runner all empty — is null", async () => {
    const supply = createSupply({
      storage: fakeStorage(),
      runner: { analyse: vi.fn(async () => null) },
    });
    await expect(
      supply.supplyRead({
        samples: samples(),
        sampleRate: SAMPLE_RATE,
        depth: "fast",
      }),
    ).resolves.toBeNull();
  });

  it("a storage failure degrades to the next source instead of throwing", async () => {
    const data = samples();
    const read = makeRead(hashOf(data));
    const storage = fakeStorage({
      getRead: vi.fn(async () => {
        throw new Error("idb gone");
      }),
    });
    const supply = createSupply({
      storage,
      runner: { analyse: vi.fn(async () => read) },
    });
    await expect(
      supply.supplyRead({
        samples: data,
        sampleRate: SAMPLE_RATE,
        depth: "deep",
      }),
    ).resolves.toEqual({ read, source: "local" });
  });
});

describe("supply — pairs: precedence, documents, identity authoring", () => {
  it("a cache hit returns the document's recorded arcPosition and calls nobody", async () => {
    const doc: PairDocument = {
      aHash: "hash-a",
      bHash: "hash-b",
      arcPosition: 0.25,
      candidates: [FAKE_RECIPE],
      rejected: [],
    };
    const stored: StoredPairSet<PairDocument> = {
      aHash: "hash-a",
      bHash: "hash-b",
      analysisVersion: ANALYSIS_VERSION,
      pairSet: doc,
      storedAt: 1,
    };
    const storage = fakeStorage({
      getPairSet: vi.fn(async () => stored),
    });
    const server: ServerClient = {
      ...uploadStubs(),
      fetchTrackRead: vi.fn(async () => null),
      fetchPairCandidates: vi.fn(async () => ({
        candidates: [],
        rejected: [],
        arcPosition: 0.9,
      })),
    };
    const author = vi.fn(() => ({ candidates: [], rejected: [] }));
    const supply = createSupply({
      storage,
      server,
      author: author as unknown as AuthorCandidatesFn,
      isServerEnabled: () => true,
    });
    const got = await supply.supplyPair(
      fakeFacts("a", "hash-a"),
      fakeFacts("b", "hash-b"),
      { arcPosition: 0.9 },
    );
    expect(got).toEqual({
      candidates: [FAKE_RECIPE],
      rejected: [],
      source: "cache",
      arcPosition: 0.25,
    });
    expect(server.fetchPairCandidates).not.toHaveBeenCalled();
    expect(author).not.toHaveBeenCalled();
  });

  it("a server hit is stored locally as a PairDocument before returning", async () => {
    const storage = fakeStorage();
    const server: ServerClient = {
      ...uploadStubs(),
      fetchTrackRead: vi.fn(async () => null),
      fetchPairCandidates: vi.fn(async () => ({
        candidates: [FAKE_RECIPE],
        rejected: [{ family: "blend", reason: "no" }],
        arcPosition: 0.4,
      })),
    };
    const supply = createSupply({
      storage,
      server,
      author: vi.fn(() => ({ candidates: [], rejected: [] })) as never,
      isServerEnabled: () => true,
    });
    const got = await supply.supplyPair(
      fakeFacts("a", "hash-a"),
      fakeFacts("b", "hash-b"),
      { arcPosition: 0.4 },
    );
    expect(got?.source).toBe("server");
    expect(got?.arcPosition).toBe(0.4);
    expect(storage.putPairSet).toHaveBeenCalledWith("hash-a", "hash-b", {
      aHash: "hash-a",
      bHash: "hash-b",
      arcPosition: 0.4,
      candidates: [FAKE_RECIPE],
      rejected: [{ family: "blend", reason: "no" }],
    } satisfies PairDocument);
  });

  it("local authoring uses NEUTRAL shaping, records the caller's arcPosition, and stores the document", async () => {
    const storage = fakeStorage();
    const author = vi.fn(
      (
        _factsA: TrackFacts,
        _factsB: TrackFacts,
        _ctx: { arcPosition: number; shaping: typeof NEUTRAL_SHAPING },
      ) => ({
        candidates: [FAKE_RECIPE],
        rejected: [] as { family: string; reason: string }[],
      }),
    );
    const supply = createSupply({
      storage,
      author,
    });
    const got = await supply.supplyPair(
      fakeFacts("a", "hash-a"),
      fakeFacts("b", "hash-b"),
      { arcPosition: 0.6 },
    );
    expect(got).toEqual({
      candidates: [FAKE_RECIPE],
      rejected: [],
      source: "local",
      arcPosition: 0.6,
    });
    const ctx = author.mock.calls[0][2];
    expect(ctx.arcPosition).toBe(0.6);
    expect(ctx.shaping.affinities).toEqual(NEUTRAL_SHAPING.affinities);
    expect(ctx.shaping.bends).toEqual(NEUTRAL_SHAPING.bends);
    expect(storage.putPairSet).toHaveBeenCalledWith("hash-a", "hash-b", {
      aHash: "hash-a",
      bHash: "hash-b",
      arcPosition: 0.6,
      candidates: [FAKE_RECIPE],
      rejected: [],
    } satisfies PairDocument);
  });

  it("null hashes skip caching and the server entirely — straight to the local author", async () => {
    const storage = fakeStorage();
    const server: ServerClient = {
      ...uploadStubs(),
      fetchTrackRead: vi.fn(async () => null),
      fetchPairCandidates: vi.fn(async () => ({
        candidates: [],
        rejected: [],
        arcPosition: 0,
      })),
    };
    const author = vi.fn(() => ({ candidates: [FAKE_RECIPE], rejected: [] }));
    const supply = createSupply({
      storage,
      server,
      author: author as unknown as AuthorCandidatesFn,
      isServerEnabled: () => true,
    });
    const got = await supply.supplyPair(
      fakeFacts("a", null),
      fakeFacts("b", "hash-b"),
      { arcPosition: 0.5 },
    );
    expect(got?.source).toBe("local");
    expect(storage.getPairSet).not.toHaveBeenCalled();
    expect(storage.putPairSet).not.toHaveBeenCalled();
    expect(server.fetchPairCandidates).not.toHaveBeenCalled();
    expect(author).toHaveBeenCalledTimes(1);
  });

  it("an author failure is null, never a throw", async () => {
    const supply = createSupply({
      storage: fakeStorage(),
      author: (() => {
        throw new Error("no geometry");
      }) as unknown as AuthorCandidatesFn,
    });
    await expect(
      supply.supplyPair(fakeFacts("a", "hash-a"), fakeFacts("b", "hash-b"), {
        arcPosition: 0,
      }),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------
// Uploads — the seam's return path
// ---------------------------------------------------------------------

function fetchWithStatus(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("createServerClient — uploads", () => {
  it("PUTs the read envelope to the track address and reads 201 as stored", async () => {
    const read = makeRead("hash-a");
    const fetchImpl = fetchWithStatus(201, { stored: true, existed: false });
    const client = createServerClient("https://mix.example/", fetchImpl);
    await expect(client.uploadTrackRead(read)).resolves.toBe("stored");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mix.example/v1/tracks/hash-a");
    expect(init.method).toBe("PUT");
    expect(String(init.body)).toBe(
      JSON.stringify(buildTrackReadEnvelope(read)),
    );
  });

  it("carries the bearer token on uploads, exactly as on fetches", async () => {
    const read = makeRead("hash-a");
    const fetchImpl = fetchWithStatus(201, { stored: true, existed: false });
    const client = createServerClient("https://mix.example", fetchImpl, {
      token: "sekret",
    });
    await client.uploadTrackRead(read);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer sekret",
    );
  });

  it("reads an identical re-PUT (200, existed) as already-shelved, not stored", async () => {
    const read = makeRead("hash-a");
    const client = createServerClient(
      "https://mix.example",
      fetchWithStatus(200, { stored: true, existed: true }),
    );
    await expect(client.uploadTrackRead(read)).resolves.toBe("already-shelved");
    const fresh = createServerClient(
      "https://mix.example",
      fetchWithStatus(200, { stored: true, existed: false }),
    );
    await expect(fresh.uploadTrackRead(read)).resolves.toBe("stored");
  });

  it("surfaces the write-once 409 as a conflict", async () => {
    const read = makeRead("hash-a");
    const client = createServerClient(
      "https://mix.example",
      fetchWithStatus(409, { error: "different document" }),
    );
    await expect(client.uploadTrackRead(read)).resolves.toBe("conflict");
  });

  it("maps refusals and network failures to failed, never throws", async () => {
    const read = makeRead("hash-a");
    const refused = createServerClient(
      "https://mix.example",
      fetchWithStatus(503, { error: "supply token not configured" }),
    );
    await expect(refused.uploadTrackRead(read)).resolves.toBe("failed");
    const throwing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const netClient = createServerClient("https://mix.example", throwing);
    await expect(netClient.uploadTrackRead(read)).resolves.toBe("failed");
  });

  it("validates before sending: a read the fetch side would refuse is never offered", async () => {
    const fetchImpl = fetchWithStatus(201, { stored: true, existed: false });
    const client = createServerClient("https://mix.example", fetchImpl);
    const wrongVersion = { ...makeRead("hash-a"), analysisVersion: 999 };
    await expect(client.uploadTrackRead(wrongVersion)).resolves.toBe("failed");
    const wrongDepth = {
      ...makeRead("hash-a"),
      depth: "wide" as TrackRead["depth"],
    };
    await expect(client.uploadTrackRead(wrongDepth)).resolves.toBe("failed");
    await expect(client.uploadTrackRead(makeRead(""))).resolves.toBe("failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("PUTs the pair envelope to the ordered pair address", async () => {
    const doc: PairDocument = {
      aHash: "hash-a",
      bHash: "hash-b",
      arcPosition: 0.4,
      candidates: [FAKE_RECIPE],
      rejected: [{ family: "blend", reason: "no" }],
    };
    const fetchImpl = fetchWithStatus(201, { stored: true, existed: false });
    const client = createServerClient("https://mix.example/", fetchImpl);
    await expect(client.uploadPairCandidates(doc)).resolves.toBe("stored");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mix.example/v1/pairs/hash-a/hash-b");
    expect(init.method).toBe("PUT");
    expect(String(init.body)).toBe(
      JSON.stringify(buildPairCandidatesEnvelope(doc)),
    );
  });

  it("pair conflicts surface as conflict; unaddressable documents are never sent", async () => {
    const doc: PairDocument = {
      aHash: "hash-a",
      bHash: "hash-b",
      arcPosition: 0,
      candidates: [],
      rejected: [],
    };
    const conflicted = createServerClient(
      "https://mix.example",
      fetchWithStatus(409, { error: "different document" }),
    );
    await expect(conflicted.uploadPairCandidates(doc)).resolves.toBe(
      "conflict",
    );

    const fetchImpl = fetchWithStatus(201, { stored: true, existed: false });
    const client = createServerClient("https://mix.example", fetchImpl);
    await expect(
      client.uploadPairCandidates({ ...doc, aHash: null }),
    ).resolves.toBe("failed");
    await expect(
      client.uploadPairCandidates({
        ...doc,
        candidates: "nope" as unknown as JoinRecipe[],
      }),
    ).resolves.toBe("failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("supply — contribution of locally computed documents", () => {
  async function flushContributions(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  function contributingServer(overrides: Record<string, unknown> = {}) {
    return {
      fetchTrackRead: vi.fn(async () => null),
      fetchPairCandidates: vi.fn(async () => null),
      uploadTrackRead: vi.fn(async () => "stored" as const),
      uploadPairCandidates: vi.fn(async () => "stored" as const),
      ...overrides,
    } as unknown as ServerClient & {
      uploadTrackRead: ReturnType<typeof vi.fn>;
      uploadPairCandidates: ReturnType<typeof vi.fn>;
    };
  }

  it("a locally analysed read is contributed in the background, outcome reported", async () => {
    const data = samples();
    const read = makeRead(hashOf(data));
    const server = contributingServer();
    const outcomes: ContributionOutcome[] = [];
    const supply = createSupply({
      storage: fakeStorage(),
      server,
      runner: { analyse: vi.fn(async () => read) },
      isServerEnabled: () => true,
      onContribution: (outcome) => outcomes.push(outcome),
    });
    const got = await supply.supplyRead({
      samples: data,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    expect(got).toEqual({ read, source: "local" });
    await flushContributions();
    expect(server.uploadTrackRead).toHaveBeenCalledTimes(1);
    expect(server.uploadTrackRead).toHaveBeenCalledWith(read);
    expect(outcomes).toEqual([
      {
        kind: "read",
        status: "stored",
        audioHash: read.audioHash,
        address: readStoreKey(read.audioHash, "deep"),
      },
    ]);
  });

  it("contribution never blocks: a hung upload does not delay the result", async () => {
    const data = samples();
    const read = makeRead(hashOf(data));
    const server = contributingServer({
      uploadTrackRead: vi.fn(() => new Promise<string>(() => {})),
    });
    const supply = createSupply({
      storage: fakeStorage(),
      server,
      runner: { analyse: vi.fn(async () => read) },
      isServerEnabled: () => true,
    });
    // If the supply awaited the upload, this await would never
    // resolve and the test would time out instead of passing.
    await expect(
      supply.supplyRead({
        samples: data,
        sampleRate: SAMPLE_RATE,
        depth: "deep",
      }),
    ).resolves.toEqual({ read, source: "local" });
  });

  it("switch off: nothing is uploaded and no outcome is reported", async () => {
    const data = samples();
    const read = makeRead(hashOf(data));
    const server = contributingServer();
    const outcomes: ContributionOutcome[] = [];
    const supply = createSupply({
      storage: fakeStorage(),
      server,
      runner: { analyse: vi.fn(async () => read) },
      isServerEnabled: () => false,
      onContribution: (outcome) => outcomes.push(outcome),
    });
    const got = await supply.supplyRead({
      samples: data,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    expect(got?.source).toBe("local");
    await flushContributions();
    expect(server.uploadTrackRead).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it("cache and server hits contribute nothing — only local compute is new", async () => {
    const data = samples();
    const read = makeRead(hashOf(data));
    const server = contributingServer({
      fetchTrackRead: vi.fn(async () => read),
    });
    const outcomes: ContributionOutcome[] = [];
    const fromCache = createSupply({
      storage: fakeStorage({ getRead: vi.fn(async () => read) }),
      server,
      runner: { analyse: vi.fn(async () => read) },
      isServerEnabled: () => true,
      onContribution: (outcome) => outcomes.push(outcome),
    });
    await fromCache.supplyRead({
      samples: data,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    const fromServer = createSupply({
      storage: fakeStorage(),
      server,
      runner: { analyse: vi.fn(async () => read) },
      isServerEnabled: () => true,
      onContribution: (outcome) => outcomes.push(outcome),
    });
    const got = await fromServer.supplyRead({
      samples: data,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    expect(got?.source).toBe("server");
    await flushContributions();
    expect(server.uploadTrackRead).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it("a locally authored pair document is contributed under its ordered address", async () => {
    const server = contributingServer({
      uploadPairCandidates: vi.fn(async () => "already-shelved" as const),
    });
    const outcomes: ContributionOutcome[] = [];
    const author = vi.fn(() => ({
      candidates: [FAKE_RECIPE],
      rejected: [] as { family: string; reason: string }[],
    }));
    const supply = createSupply({
      storage: fakeStorage(),
      server,
      author: author as unknown as AuthorCandidatesFn,
      isServerEnabled: () => true,
      onContribution: (outcome) => outcomes.push(outcome),
    });
    const got = await supply.supplyPair(
      fakeFacts("a", "hash-a"),
      fakeFacts("b", "hash-b"),
      { arcPosition: 0.6 },
    );
    expect(got?.source).toBe("local");
    await flushContributions();
    expect(server.uploadPairCandidates).toHaveBeenCalledTimes(1);
    expect(server.uploadPairCandidates).toHaveBeenCalledWith({
      aHash: "hash-a",
      bHash: "hash-b",
      arcPosition: 0.6,
      candidates: [FAKE_RECIPE],
      rejected: [],
    } satisfies PairDocument);
    expect(outcomes).toEqual([
      {
        kind: "pair",
        status: "already-shelved",
        aHash: "hash-a",
        bHash: "hash-b",
        address: pairStoreKey("hash-a", "hash-b"),
      },
    ]);
  });

  it("a 409 is surfaced once as a conflict outcome — never retried, never overwritten", async () => {
    const server = contributingServer({
      uploadPairCandidates: vi.fn(async () => "conflict" as const),
    });
    const outcomes: ContributionOutcome[] = [];
    const author = vi.fn(() => ({
      candidates: [FAKE_RECIPE],
      rejected: [] as { family: string; reason: string }[],
    }));
    const supply = createSupply({
      storage: fakeStorage(),
      server,
      author: author as unknown as AuthorCandidatesFn,
      isServerEnabled: () => true,
      onContribution: (outcome) => outcomes.push(outcome),
    });
    const got = await supply.supplyPair(
      fakeFacts("a", "hash-a"),
      fakeFacts("b", "hash-b"),
      { arcPosition: 0 },
    );
    // The local document stands exactly as authored.
    expect(got).toEqual({
      candidates: [FAKE_RECIPE],
      rejected: [],
      source: "local",
      arcPosition: 0,
    });
    await flushContributions();
    expect(server.uploadPairCandidates).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "pair", status: "conflict" }),
    ]);
  });

  it("an upload that throws settles as a failed outcome; the result is unaffected", async () => {
    const data = samples();
    const read = makeRead(hashOf(data));
    const server = contributingServer({
      uploadTrackRead: vi.fn(async () => {
        throw new Error("socket gone");
      }),
    });
    const outcomes: ContributionOutcome[] = [];
    const supply = createSupply({
      storage: fakeStorage(),
      server,
      runner: { analyse: vi.fn(async () => read) },
      isServerEnabled: () => true,
      onContribution: (outcome) => outcomes.push(outcome),
    });
    const got = await supply.supplyRead({
      samples: data,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    expect(got).toEqual({ read, source: "local" });
    await flushContributions();
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "read", status: "failed" }),
    ]);
  });

  it("an unkeyable pair (null hash) is never contributed", async () => {
    const server = contributingServer();
    const author = vi.fn(() => ({ candidates: [FAKE_RECIPE], rejected: [] }));
    const supply = createSupply({
      storage: fakeStorage(),
      server,
      author: author as unknown as AuthorCandidatesFn,
      isServerEnabled: () => true,
    });
    const got = await supply.supplyPair(
      fakeFacts("a", null),
      fakeFacts("b", "hash-b"),
      { arcPosition: 0.5 },
    );
    expect(got?.source).toBe("local");
    await flushContributions();
    expect(server.uploadPairCandidates).not.toHaveBeenCalled();
  });
});
