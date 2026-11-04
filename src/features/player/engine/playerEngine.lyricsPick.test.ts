import { describe, it, expect, beforeEach, vi } from "vitest";

// Wave 4 (wrong-lyrics remedy): fetchLyricsForTrack must honour the
// per-track provider pick and wrong-source mark persisted in the
// lyrics cache — at its existing decision points only (cache read,
// post-prefetch read, and the provider-stream assembly). The stream
// is mocked; ranking and cache writes are the engine's real ones.

vi.mock("@/shared/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...original,
    api: { ...original.api, streamLyrics: vi.fn() },
  };
});

import { api } from "@/shared/api";
import { playerEngine } from "./playerEngine";
import { lyricsCache } from "@/features/lyrics/store/lyricsCache";
import { useLyricsStore } from "@/features/lyrics/store/lyricsStore";
import { resetLrclibFallbackAttempts } from "@/features/lyrics/services/lrclib";
import type {
  LyricsCandidate,
  LyricsStreamEvent,
  LyricsSyncLevel,
} from "@/shared/contracts/lyrics";
import type { Track } from "@/shared/types";

function makeCandidate(
  provider: string,
  syncLevel: LyricsSyncLevel,
  qualityTotal: number,
  marker: string,
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
    lyrics: { format: "lrc", content: `[00:01.00] ${marker}` },
  };
}

function opt(candidate: LyricsCandidate) {
  return {
    provider: candidate.provider,
    syncLevel: candidate.syncLevel,
    quality: candidate.quality.total,
    candidate,
  };
}

function track(id: string): Track {
  return {
    id,
    title: `Song ${id}`,
    artists: "Some Artist",
    durationMs: 180000,
    coverUrl: "",
    playCount: 0,
  };
}

const found = (candidate: LyricsCandidate): LyricsStreamEvent => ({
  type: "provider",
  provider: candidate.provider,
  status: "found",
  syncLevel: candidate.syncLevel,
  candidate,
});
const done: LyricsStreamEvent = { type: "done", cached: false };

function stubStream(events: LyricsStreamEvent[]) {
  vi.mocked(api.streamLyrics).mockImplementation(async function* () {
    for (const event of events) yield event;
  });
}

async function fetchLyrics(t: Track) {
  await (
    playerEngine as unknown as {
      fetchLyricsForTrack: (track: Track | null) => Promise<void>;
    }
  ).fetchLyricsForTrack(t);
}

const alpha = makeCandidate("Alpha", "word_level", 90, "alpha words");
const beta = makeCandidate("Beta", "line_level", 70, "beta words");
// a non-word-level "polaris" candidate is provisional, which forces
// the fetch past the cache read and into the stream — the standard
// way these tests reach the stream decision points
const polaris = makeCandidate("Polaris", "line_level", 60, "polaris words");

describe("fetchLyricsForTrack — Wave 4 pick and wrong-mark", () => {
  beforeEach(() => {
    localStorage.clear();
    lyricsCache.clear();
    resetLrclibFallbackAttempts();
    useLyricsStore.getState().reset();
    (
      playerEngine as unknown as { currentLyricsTrackId: string | null }
    ).currentLyricsTrackId = null;
    vi.mocked(api.streamLyrics).mockReset();
  });

  it("cache read: the persisted pick is shown instead of the stored best", async () => {
    const id = "pick-cache";
    lyricsCache.set(id, alpha, [opt(alpha), opt(beta)]);
    lyricsCache.rememberUserProvider(id, "Beta");
    stubStream([]);

    await fetchLyrics(track(id));

    expect(api.streamLyrics).not.toHaveBeenCalled();
    const state = useLyricsStore.getState();
    expect(state.activeProvider).toBe("Beta");
    expect(state.rawLyrics).toContain("beta words");
  });

  it("cache read: a marked stored best is passed over for the alternative", async () => {
    const id = "mark-cache";
    lyricsCache.set(id, alpha, [opt(alpha), opt(beta)]);
    lyricsCache.markWrongProvider(id, "Alpha");
    stubStream([]);

    await fetchLyrics(track(id));

    expect(api.streamLyrics).not.toHaveBeenCalled();
    expect(useLyricsStore.getState().activeProvider).toBe("Beta");
  });

  it("cache read: a marked sole source is still shown", async () => {
    const id = "mark-sole";
    lyricsCache.set(id, alpha, [opt(alpha)]);
    lyricsCache.markWrongProvider(id, "Alpha");
    stubStream([]);

    await fetchLyrics(track(id));

    const state = useLyricsStore.getState();
    expect(state.activeProvider).toBe("Alpha");
    expect(state.rawLyrics).toContain("alpha words");
  });

  it("stream: the pick is re-asserted over a better streamed candidate", async () => {
    const id = "pick-stream";
    lyricsCache.set(id, polaris, [opt(polaris), opt(beta)]);
    lyricsCache.rememberUserProvider(id, "Beta");
    stubStream([found(alpha), done]);

    await fetchLyrics(track(id));

    const state = useLyricsStore.getState();
    expect(state.activeProvider).toBe("Beta");
    expect(state.rawLyrics).toContain("beta words");
    // the pick rides through the stream's own cache writes
    expect(lyricsCache.get(id)?.userProvider).toBe("beta");
  });

  it("stream: a marked source is passed over once an alternative arrives", async () => {
    const id = "mark-stream";
    lyricsCache.set(id, polaris, [opt(polaris), opt(alpha)]);
    lyricsCache.markWrongProvider(id, "Alpha");
    const alphaFresh = makeCandidate(
      "Alpha",
      "word_level",
      90,
      "alpha fresh words",
    );
    stubStream([found(alphaFresh), found(beta), done]);

    await fetchLyrics(track(id));

    const state = useLyricsStore.getState();
    expect(state.activeProvider).toBe("Beta");
    expect(state.rawLyrics).toContain("beta words");
  });

  it("stream: an explicit pick of the marked source still wins", async () => {
    const id = "pick-marked-stream";
    lyricsCache.set(id, polaris, [opt(polaris), opt(alpha)]);
    lyricsCache.rememberUserProvider(id, "Alpha");
    lyricsCache.markWrongProvider(id, "Alpha");
    const betaBest = makeCandidate("Beta", "word_level", 95, "beta best");
    stubStream([found(betaBest), done]);

    await fetchLyrics(track(id));

    expect(useLyricsStore.getState().activeProvider).toBe("Alpha");
  });

  it("stream: a pick whose provider never arrives is inert", async () => {
    const id = "pick-inert";
    lyricsCache.set(id, polaris, [opt(polaris)]);
    lyricsCache.rememberUserProvider(id, "Beta");
    stubStream([found(alpha), done]);

    await fetchLyrics(track(id));

    expect(useLyricsStore.getState().activeProvider).toBe("Alpha");
  });

  it("stream: a marked sole source stays on screen after a refresh", async () => {
    const id = "mark-sole-stream";
    lyricsCache.set(id, alpha, [opt(alpha)]);
    lyricsCache.markWrongProvider(id, "Alpha");
    // age the stored entry past the seven-day freshness window so the
    // fetch proceeds into the stream instead of returning at the read
    const raw = localStorage.getItem(`liner_lyrics_v2_item_${id}`);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw as string) as { timestamp: number };
    stored.timestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    lyricsCache.clear();
    localStorage.setItem(`liner_lyrics_v2_item_${id}`, JSON.stringify(stored));
    stubStream([done]);

    await fetchLyrics(track(id));

    expect(api.streamLyrics).toHaveBeenCalled();
    const state = useLyricsStore.getState();
    expect(state.activeProvider).toBe("Alpha");
    expect(state.rawLyrics).toContain("alpha words");
  });
});
