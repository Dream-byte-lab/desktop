// The history feed: paged walking over the merged stream, the
// guest's device-only feed, and failure kept distinct from empty.

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

import {
  useListeningHistory,
  type ListeningHistoryState,
} from "./useListeningHistory";
import { linerDb } from "@/shared/storage/linerDb";
import type { PlaybackHistoryItem } from "@/shared/contracts/history";

const NOW = Date.now();
const HOUR = 3_600_000;

function serverItem(id: string, atMs: number): PlaybackHistoryItem {
  return {
    id,
    playbackSessionId: `sess-${id}`,
    listeningSessionId: "listen-1",
    track: {
      id: `t-${id}`,
      title: `Song ${id}`,
      artists: [{ id: "a1", name: "Ama Artist" }],
      durationMs: 200_000,
    },
    playedDurationMs: 120_000,
    completionRate: 0.6,
    completed: false,
    skipped: false,
    loopCount: 0,
    hasSeekBackward: false,
    listenedAt: new Date(atMs).toISOString(),
  };
}

let container: HTMLDivElement;
let root: Root;
const holder: { state: ListeningHistoryState | null } = { state: null };

function Probe() {
  holder.state = useListeningHistory();
  return null;
}

async function renderProbe() {
  await act(async () => {
    root.render(React.createElement(Probe));
  });
}

function readyState(): Extract<ListeningHistoryState, { status: "ready" }> {
  const s = holder.state;
  if (s?.status !== "ready")
    throw new Error(`expected ready, got ${s?.status}`);
  return s;
}

beforeEach(async () => {
  ownerHolder.value = "user-1";
  getHistorySpy.mockReset();
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

describe("useListeningHistory", () => {
  it("pages the merged stream until the cursor runs out", async () => {
    getHistorySpy
      .mockResolvedValueOnce({
        items: [serverItem("1", NOW - HOUR), serverItem("2", NOW - 2 * HOUR)],
        nextCursor: "c2",
      })
      .mockResolvedValueOnce({
        items: [serverItem("3", NOW - 3 * HOUR)],
        nextCursor: null,
      });
    await renderProbe();
    await vi.waitFor(() => {
      expect(holder.state?.status).toBe("ready");
    });
    expect(readyState().totalEvents).toBe(2);
    expect(readyState().hasMore).toBe(true);

    await act(async () => {
      readyState().loadMore();
    });
    await vi.waitFor(() => {
      expect(readyState().totalEvents).toBe(3);
    });
    expect(readyState().hasMore).toBe(false);
    expect(readyState().boundReached).toBe(false);
    const titles = readyState().groups.flatMap((g) =>
      g.events.map((e) => e.track.title),
    );
    expect(titles).toEqual(["Song 1", "Song 2", "Song 3"]);
  });

  it("gives a guest the device log alone and never calls the server", async () => {
    ownerHolder.value = "";
    getHistorySpy.mockResolvedValue({ items: [], nextCursor: null });
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
      listenedAtMs: NOW - HOUR,
    });
    await renderProbe();
    await vi.waitFor(() => {
      expect(holder.state?.status).toBe("ready");
    });
    expect(getHistorySpy).not.toHaveBeenCalled();
    expect(readyState().totalEvents).toBe(1);
    expect(readyState().hasMore).toBe(false);
  });

  it("keeps a failed load-more from eating the rows on screen", async () => {
    getHistorySpy
      .mockResolvedValueOnce({
        items: [serverItem("1", NOW - HOUR)],
        nextCursor: "c2",
      })
      .mockRejectedValueOnce(new Error("flaky network"));
    await renderProbe();
    await vi.waitFor(() => {
      expect(holder.state?.status).toBe("ready");
    });
    await act(async () => {
      readyState().loadMore();
    });
    await vi.waitFor(() => {
      expect(readyState().loadMoreFailed).toBe(true);
    });
    expect(readyState().totalEvents).toBe(1);
  });

  it("surfaces an initial failure as its own state", async () => {
    getHistorySpy.mockRejectedValue(new Error("network down"));
    await renderProbe();
    await vi.waitFor(() => {
      expect(holder.state?.status).toBe("failed");
    });
  });
});
