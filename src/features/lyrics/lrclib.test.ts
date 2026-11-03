import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterEach,
  vi,
} from "vitest";
import {
  fetchLrclibCandidate,
  shouldAttemptLrclibFallback,
  hasAttemptedLrclibFallback,
  markLrclibFallbackAttempted,
  resetLrclibFallbackAttempts,
} from "./services/lrclib";
import { lyricsCache } from "./store/lyricsCache";

const HINT = {
  title: "Blue Skies",
  artist: "Ella Fitzgerald",
  durationMs: 180000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const SYNCED_RECORD = {
  trackName: "Blue Skies",
  artistName: "Ella Fitzgerald",
  duration: 180,
  instrumental: false,
  plainLyrics: "Blue skies smiling at me",
  syncedLyrics: "[00:01.00]Blue skies smiling at me",
};

describe("fetchLrclibCandidate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a /api/get hit to an LRCLIB line_level lrc candidate", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SYNCED_RECORD));

    const candidate = await fetchLrclibCandidate(HINT);

    expect(candidate).not.toBeNull();
    expect(candidate?.provider).toBe("LRCLIB");
    expect(candidate?.syncLevel).toBe("line_level");
    expect(candidate?.contentKind).toBe("line_synced");
    expect(candidate?.lyrics.format).toBe("lrc");
    expect(candidate?.lyrics.content).toContain("Blue skies");
    expect(candidate?.quality.total).toBeLessThan(65);
    expect(candidate?.quality.reasons.join(" ")).toMatch(/fallback/i);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("https://lrclib.net/api/get?");
    expect(String(url)).toContain("track_name=Blue+Skies");
    expect(String(url)).toContain("duration=180");
    expect((init as RequestInit).headers).toMatchObject({
      "Lrclib-Client": expect.stringContaining("Linerave"),
    });
  });

  it("falls back to plain lyrics when no synced lyrics exist", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...SYNCED_RECORD, syncedLyrics: null }),
    );
    const candidate = await fetchLrclibCandidate(HINT);
    expect(candidate?.syncLevel).toBe("plain");
    expect(candidate?.lyrics.format).toBe("plain");
    expect(candidate?.lyrics.content).toBe("Blue skies smiling at me");
  });

  it("on 404 searches and accepts only a strict title/artist/duration match", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(
        jsonResponse([
          { ...SYNCED_RECORD, trackName: "Blue Skies (Live)", duration: 181 },
          {
            ...SYNCED_RECORD,
            duration: 179,
            syncedLyrics: "[00:02.00]matched",
          },
        ]),
      );

    const candidate = await fetchLrclibCandidate(HINT);
    expect(candidate?.lyrics.content).toContain("matched");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/search?");
  });

  it("rejects loose search matches (wrong duration or different title)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(
        jsonResponse([
          { ...SYNCED_RECORD, duration: 200 },
          { ...SYNCED_RECORD, trackName: "Blue Sky", duration: 180 },
          { ...SYNCED_RECORD, artistName: "Someone Else", duration: 180 },
        ]),
      );

    expect(await fetchLrclibCandidate(HINT)).toBeNull();
  });

  it("returns null for instrumental records", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...SYNCED_RECORD,
        instrumental: true,
        plainLyrics: null,
        syncedLyrics: null,
      }),
    );
    expect(await fetchLrclibCandidate(HINT)).toBeNull();
    // an instrumental /api/get answer is definitive: no search attempt
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null on malformed JSON payloads instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    expect(await fetchLrclibCandidate(HINT)).toBeNull();
  });

  it("returns null on network errors and timeouts instead of throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await fetchLrclibCandidate(HINT)).toBeNull();

    fetchMock.mockRejectedValueOnce(
      new DOMException("The operation was aborted", "AbortError"),
    );
    expect(await fetchLrclibCandidate(HINT)).toBeNull();
  });

  it("returns null without a usable hint", async () => {
    expect(
      await fetchLrclibCandidate({ title: "", artist: "X", durationMs: 1000 }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("shouldAttemptLrclibFallback", () => {
  const base = {
    streamCompleted: true,
    candidateCount: 0,
    instrumental: false,
    enabled: true,
    alreadyAttempted: false,
    hasCachedFallback: false,
  };

  it("allows the one clean case: completed stream, zero candidates", () => {
    expect(shouldAttemptLrclibFallback(base)).toBe(true);
  });

  it("never triggers on a stream exception (streamCompleted false)", () => {
    expect(
      shouldAttemptLrclibFallback({ ...base, streamCompleted: false }),
    ).toBe(false);
  });

  it("never triggers when the server found candidates or said instrumental", () => {
    expect(shouldAttemptLrclibFallback({ ...base, candidateCount: 1 })).toBe(
      false,
    );
    expect(shouldAttemptLrclibFallback({ ...base, instrumental: true })).toBe(
      false,
    );
  });

  it("respects the off switch, the once-per-session rule and a cached fallback", () => {
    expect(shouldAttemptLrclibFallback({ ...base, enabled: false })).toBe(
      false,
    );
    expect(
      shouldAttemptLrclibFallback({ ...base, alreadyAttempted: true }),
    ).toBe(false);
    expect(
      shouldAttemptLrclibFallback({ ...base, hasCachedFallback: true }),
    ).toBe(false);
  });

  it("tracks attempts per track for the session", () => {
    resetLrclibFallbackAttempts();
    expect(hasAttemptedLrclibFallback("t1")).toBe(false);
    markLrclibFallbackAttempted("t1");
    expect(hasAttemptedLrclibFallback("t1")).toBe(true);
    expect(hasAttemptedLrclibFallback("t2")).toBe(false);
  });
});

describe("lrclib candidate persistence through lyricsCache", () => {
  const store = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };

  beforeAll(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });
  });

  beforeEach(() => {
    localStorageMock.clear();
    lyricsCache.clear();
  });

  it("round-trips an LRCLIB candidate through the per-provider cache and storage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SYNCED_RECORD));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const candidate = await fetchLrclibCandidate(HINT);
      expect(candidate).not.toBeNull();

      lyricsCache.setProvider("track-lrclib", candidate!);
      lyricsCache.set("track-lrclib", candidate!);

      // readable back under the normalized server-style key: this is the
      // dedupe the provider-keyed map gives us for free
      const back = lyricsCache.getProvider("track-lrclib", "lrclib");
      expect(back?.provider).toBe("LRCLIB");
      expect(back?.lyrics.content).toContain("Blue skies");
      expect(lyricsCache.has("track-lrclib", "lrclib")).toBe(true);

      // and it actually landed in localStorage, not only in memory
      const raw = store.get("liner_lyrics_v2_item_track-lrclib");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!).providers.lrclib.provider).toBe("LRCLIB");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
