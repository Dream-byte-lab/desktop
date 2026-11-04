import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import {
  lyricsCache,
  resolveDisplayedCachedCandidate,
  type CachedLyricsItem,
} from "./store/lyricsCache";
import type { LyricsProviderOption } from "./store/lyricsStore";
import type {
  LyricsCandidate,
  LyricsSyncLevel,
} from "@/shared/contracts/lyrics";

// Wave 4 (wrong-lyrics remedy): the per-track provider pick and
// wrong-source mark that ride CachedLyricsItem, and the pure resolver
// the fetch uses to decide what to display.

function makeCandidate(
  provider: string,
  syncLevel: LyricsSyncLevel,
  qualityTotal = 80,
  content = "[00:01.00] test lyrics",
): LyricsCandidate {
  return {
    provider,
    contentKind:
      syncLevel === "word_level" || syncLevel === "syllable_level"
        ? "word_synced"
        : syncLevel === "line_level"
          ? "line_synced"
          : "plain",
    syncLevel,
    quality: {
      total: qualityTotal,
      match: 20,
      content: 30,
      sync: 30,
      source: 0,
      reasons: [],
    },
    lyrics: {
      format: "lrc",
      content,
    },
  };
}

function opt(candidate: LyricsCandidate): LyricsProviderOption {
  return {
    provider: candidate.provider,
    syncLevel: candidate.syncLevel,
    quality: candidate.quality.total,
    candidate,
  };
}

const alpha = makeCandidate("Alpha", "word_level", 90, "[00:01.00] alpha");
const beta = makeCandidate("Beta", "line_level", 70, "[00:01.00] beta");

describe("lyricsCache pick / wrong-mark fields", () => {
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
    if (typeof window !== "undefined") {
      Object.defineProperty(window, "localStorage", {
        value: localStorageMock,
        writable: true,
        configurable: true,
      });
    }
  });

  beforeEach(() => {
    localStorageMock.clear();
    lyricsCache.clear();
  });

  it("rememberUserProvider stores the normalized key on the item", () => {
    lyricsCache.set("pick-1", alpha, [opt(alpha), opt(beta)]);
    lyricsCache.rememberUserProvider("pick-1", " Beta ");
    expect(lyricsCache.get("pick-1")?.userProvider).toBe("beta");
  });

  it("rememberUserProvider is a no-op without a cached item", () => {
    expect(() =>
      lyricsCache.rememberUserProvider("missing", "Beta"),
    ).not.toThrow();
    expect(lyricsCache.get("missing")).toBeNull();
  });

  it("the pick survives a later set() with a new best candidate", () => {
    lyricsCache.set("pick-2", alpha, [opt(alpha), opt(beta)]);
    lyricsCache.rememberUserProvider("pick-2", "Beta");
    const fresher = makeCandidate(
      "Alpha",
      "word_level",
      95,
      "[00:01.00] alpha v2",
    );
    lyricsCache.set("pick-2", fresher, [opt(fresher), opt(beta)]);
    expect(lyricsCache.get("pick-2")?.userProvider).toBe("beta");
  });

  it("the pick and the mark survive a later setProvider()", () => {
    lyricsCache.set("pick-3", alpha, [opt(alpha), opt(beta)]);
    lyricsCache.rememberUserProvider("pick-3", "Beta");
    lyricsCache.markWrongProvider("pick-3", "Alpha");
    lyricsCache.setProvider(
      "pick-3",
      makeCandidate("Gamma", "line_level", 60, "[00:01.00] gamma"),
    );
    const item = lyricsCache.get("pick-3");
    expect(item?.userProvider).toBe("beta");
    expect(item?.wrongProvider?.provider).toBe("alpha");
  });

  it("markWrongProvider records provider + time; a later mark replaces it", () => {
    lyricsCache.set("mark-1", alpha, [opt(alpha), opt(beta)]);
    lyricsCache.markWrongProvider("mark-1", "Alpha");
    const first = lyricsCache.get("mark-1")?.wrongProvider;
    expect(first?.provider).toBe("alpha");
    expect(typeof first?.markedAt).toBe("number");

    lyricsCache.markWrongProvider("mark-1", "Beta");
    expect(lyricsCache.get("mark-1")?.wrongProvider?.provider).toBe("beta");
  });

  it("clearWrongProvider removes the mark and is safe to repeat", () => {
    lyricsCache.set("mark-2", alpha, [opt(alpha), opt(beta)]);
    lyricsCache.markWrongProvider("mark-2", "Alpha");
    lyricsCache.clearWrongProvider("mark-2");
    expect(lyricsCache.get("mark-2")?.wrongProvider).toBeUndefined();
    expect(() => lyricsCache.clearWrongProvider("mark-2")).not.toThrow();
  });

  it("both fields survive a storage round-trip through normalizeItem", () => {
    // a stored item the singleton has never held in memory: get() must
    // load it from storage without dropping the Wave 4 fields
    const item: CachedLyricsItem = {
      trackId: "stored-1",
      candidate: alpha,
      providers: { alpha, beta },
      availableProviders: [opt(alpha), opt(beta)],
      timestamp: Date.now(),
      userProvider: "beta",
      wrongProvider: { provider: "alpha", markedAt: 123 },
    };
    store.set("liner_lyrics_v2_item_stored-1", JSON.stringify(item));
    const loaded = lyricsCache.get("stored-1");
    expect(loaded?.userProvider).toBe("beta");
    expect(loaded?.wrongProvider).toEqual({
      provider: "alpha",
      markedAt: 123,
    });
  });
});

describe("resolveDisplayedCachedCandidate", () => {
  const options = [opt(alpha), opt(beta)];

  it("returns the stored candidate when neither field is set", () => {
    expect(
      resolveDisplayedCachedCandidate({
        candidate: alpha,
        availableProviders: options,
      }),
    ).toBe(alpha);
  });

  it("honours the pick over the stored best", () => {
    expect(
      resolveDisplayedCachedCandidate({
        candidate: alpha,
        availableProviders: options,
        userProvider: "beta",
      }),
    ).toBe(beta);
  });

  it("an explicit pick of the marked source still wins", () => {
    expect(
      resolveDisplayedCachedCandidate({
        candidate: alpha,
        availableProviders: options,
        userProvider: "alpha",
        wrongProvider: { provider: "alpha", markedAt: 1 },
      }),
    ).toBe(alpha);
  });

  it("a pick whose provider is absent from the assembly is inert", () => {
    expect(
      resolveDisplayedCachedCandidate({
        candidate: alpha,
        availableProviders: options,
        userProvider: "gamma",
      }),
    ).toBe(alpha);
  });

  it("passes over a marked stored candidate for the best unmarked option", () => {
    expect(
      resolveDisplayedCachedCandidate({
        candidate: alpha,
        availableProviders: options,
        wrongProvider: { provider: "alpha", markedAt: 1 },
      }),
    ).toBe(beta);
  });

  it("still returns the marked candidate when it is the sole source", () => {
    expect(
      resolveDisplayedCachedCandidate({
        candidate: alpha,
        availableProviders: [opt(alpha)],
        wrongProvider: { provider: "alpha", markedAt: 1 },
      }),
    ).toBe(alpha);
    expect(
      resolveDisplayedCachedCandidate({
        candidate: alpha,
        wrongProvider: { provider: "alpha", markedAt: 1 },
      }),
    ).toBe(alpha);
  });

  it("leaves an unmarked stored candidate alone even with a mark elsewhere", () => {
    expect(
      resolveDisplayedCachedCandidate({
        candidate: beta,
        availableProviders: options,
        wrongProvider: { provider: "alpha", markedAt: 1 },
      }),
    ).toBe(beta);
  });
});
