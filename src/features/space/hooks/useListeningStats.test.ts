// The stats hook's contract: guests never touch the server,
// failure is a state (not emptiness), and a signed-in read merges
// the device log with the walked history.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ownerHolder: { value: string } = { value: "user-1" };
const getHistorySpy = vi.fn();

vi.mock("@/shared/api", () => ({
  api: { getHistory: (...args: unknown[]) => getHistorySpy(...args) },
  toClientTrack: (source: any) => ({
    id: source.id,
    title: source.title,
    artists: Array.isArray(source.artists)
      ? source.artists.map((a: any) => a.name).join(", ")
      : source.artists,
    artistList: Array.isArray(source.artists) ? source.artists : undefined,
    coverUrl: source.cover?.url ?? "",
    durationMs: source.durationMs ?? 0,
    playCount: 0,
  }),
}));

vi.mock("@/features/home/hooks/sessionAwareLoad", () => ({
  useSessionOwner: () => ownerHolder.value,
  loadWithRetry: (load: () => Promise<unknown>) => load(),
}));

vi.mock("@/features/genres/trackGenres", () => ({
  labelsForTrack: () => ({ playlistGenres: [], genres: [] }),
}));

vi.mock("@/features/mixer/engine/tasteTracker", () => ({
  getTasteProfile: () => ({
    artists: { "Ama Artist": 3 },
    tracks: {},
    tags: {},
    updatedAtMs: Date.now(),
  }),
}));

import {
  loadListeningStats,
  useListeningStats,
  type ListeningStatsState,
} from "./useListeningStats";
import { linerDb } from "@/shared/storage/linerDb";
import type { PlaybackHistoryItem } from "@/shared/contracts/history";

const NOW = Date.now();
const HOUR = 3_600_000;

function serverItem(
  over: Partial<PlaybackHistoryItem> = {},
): PlaybackHistoryItem {
  return {
    id: "srv-1",
    playbackSessionId: "sess-1",
    listeningSessionId: "listen-1",
    track: {
      id: "t1",
      title: "Song t1",
      artists: [{ id: "a1", name: "Ama Artist" }],
      durationMs: 200_000,
    },
    playedDurationMs: 120_000,
    completionRate: 0.6,
    completed: false,
    skipped: false,
    loopCount: 0,
    hasSeekBackward: false,
    listenedAt: new Date(NOW - HOUR).toISOString(),
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
const holder: { state: ListeningStatsState | null } = { state: null };

function Probe() {
  holder.state = useListeningStats();
  return null;
}

async function renderProbe() {
  await act(async () => {
    root.render(React.createElement(Probe));
  });
}

beforeEach(async () => {
  ownerHolder.value = "user-1";
  getHistorySpy.mockReset();
  localStorage.clear();
  await linerDb.clearAll();
  holder.state = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("useListeningStats", () => {
  it("short-circuits for guests: the server is never called", async () => {
    ownerHolder.value = "";
    getHistorySpy.mockResolvedValue({ items: [], nextCursor: null });
    await renderProbe();
    await vi.waitFor(() => {
      expect(holder.state?.status).toBe("guest");
    });
    expect(getHistorySpy).not.toHaveBeenCalled();
    const state = holder.state;
    if (state?.status !== "guest") throw new Error("expected guest state");
    expect(state.summary.tasteTopArtists).toEqual([
      { artist: "Ama Artist", weight: 3 },
    ]);
    // No device log yet: the summary carries no numbers at all.
    expect(state.summary.device).toBeNull();
  });

  it("merges the walked history with the device log for a signed-in listener", async () => {
    getHistorySpy.mockResolvedValue({
      items: [serverItem()],
      nextCursor: null,
    });
    await linerDb.putPlayEvent({
      id: "dev-1",
      trackId: "dt1",
      track: {
        id: "dt1",
        title: "Device Song",
        artists: "Ama Artist",
        coverUrl: "",
        durationMs: 200_000,
        playCount: 0,
      },
      playedDurationMs: 90_000,
      completionRate: 0.45,
      completed: false,
      skipped: false,
      loopCount: 0,
      hasSeekBackward: false,
      playbackSessionId: "dev-sess-1",
      listenedAtMs: NOW - 30 * 60_000,
    });
    await renderProbe();
    await vi.waitFor(() => {
      expect(holder.state?.status).toBe("ready");
    });
    const state = holder.state;
    if (state?.status !== "ready") throw new Error("expected ready state");
    expect(state.stale).toBe(false);
    expect(state.stats.totalEvents).toBe(2);
    expect(state.stats.countedPlays).toBe(2);
    expect(state.stats.coverage.deviceEvents).toBe(1);
    expect(state.stats.coverage.serverEvents).toBe(1);
    expect(state.stats.coverage.complete).toBe(true);
  });

  it("surfaces a failed walk as failure, not as an empty space", async () => {
    getHistorySpy.mockRejectedValue(new Error("network down"));
    await renderProbe();
    await vi.waitFor(() => {
      expect(holder.state?.status).toBe("failed");
    });
  });

  it("renders the cached aggregate stale when the refresh fails over it", async () => {
    getHistorySpy.mockResolvedValueOnce({
      items: [serverItem()],
      nextCursor: null,
    });
    await renderProbe();
    await vi.waitFor(() => {
      expect(holder.state?.status).toBe("ready");
    });
    // Second mount: the cache from the first read renders at once,
    // and this time the walk fails over it.
    getHistorySpy.mockRejectedValue(new Error("offline now"));
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderProbe();
    await vi.waitFor(() => {
      const s = holder.state;
      expect(s?.status).toBe("ready");
      if (s?.status === "ready") expect(s.refreshFailed).toBe(true);
    });
    const state = holder.state;
    if (state?.status !== "ready") throw new Error("expected ready state");
    expect(state.stale).toBe(true);
    expect(state.stats.countedPlays).toBe(1);
  });
});

describe("loadListeningStats (the loader)", () => {
  it("rejects when the walk rejects", async () => {
    await expect(
      loadListeningStats({
        fetchPage: async () => {
          throw new Error("boom");
        },
        readDevice: async () => [],
        readJoins: async () => null,
        nowMs: NOW,
      }),
    ).rejects.toThrow("boom");
  });

  it("passes the walk's truncation into the coverage", async () => {
    const stats = await loadListeningStats({
      fetchPage: async (cursor) =>
        cursor
          ? { items: [], nextCursor: null }
          : {
              items: [serverItem()],
              nextCursor: "more",
            },
      readDevice: async () => [],
      readJoins: async () => ({ performed: 4, graded: 2, averageGrade: 0.8 }),
      nowMs: NOW,
    });
    // The second page ends the walk: complete, one event.
    expect(stats.coverage.complete).toBe(true);
    expect(stats.totalEvents).toBe(1);
    expect(stats.joins).toEqual({ performed: 4, graded: 2, averageGrade: 0.8 });
  });
});
