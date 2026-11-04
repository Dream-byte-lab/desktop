// The bounded walk: every stop carries its reason, and `complete`
// is true only at the history's actual end.

import { describe, it, expect } from "vitest";
import {
  applyWalkPage,
  emptyWalk,
  walkAllHistory,
  walkCutoffMs,
  type HistoryPageFetcher,
} from "./historyWalk";
import type {
  PlaybackHistoryItem,
  PlaybackHistoryResponse,
} from "@/shared/contracts/history";

const NOW = new Date(2026, 5, 15, 18, 0, 0).getTime();
const DAY = 24 * 3_600_000;

function item(atMs: number, id: string): PlaybackHistoryItem {
  return {
    id,
    playbackSessionId: `s-${id}`,
    listeningSessionId: "l",
    track: {
      id: `t-${id}`,
      title: `Song ${id}`,
      artists: [{ id: "a", name: "Ama" }],
      durationMs: 200_000,
    },
    playedDurationMs: 60_000,
    completionRate: 0.3,
    completed: false,
    skipped: false,
    loopCount: 0,
    hasSeekBackward: false,
    listenedAt: new Date(atMs).toISOString(),
  };
}

function page(
  items: PlaybackHistoryItem[],
  nextCursor: string | null,
): PlaybackHistoryResponse {
  return { items, nextCursor };
}

function batch(count: number, newestMs: number, prefix: string) {
  return Array.from({ length: count }, (_, i) =>
    item(newestMs - i * 60_000, `${prefix}-${i}`),
  );
}

describe("applyWalkPage", () => {
  it("is complete only when the cursor runs out", () => {
    const state = applyWalkPage(
      emptyWalk(),
      page(batch(3, NOW, "a"), null),
      NOW,
    );
    expect(state.complete).toBe(true);
    expect(state.truncatedBy).toBeNull();
    expect(state.items).toHaveLength(3);
    expect(state.nextCursor).toBeNull();
  });

  it("keeps the cursor while pages remain", () => {
    const state = applyWalkPage(
      emptyWalk(),
      page(batch(3, NOW, "a"), "c2"),
      NOW,
    );
    expect(state.complete).toBe(false);
    expect(state.nextCursor).toBe("c2");
  });

  it("drops items past the 13-month line and names the stop", () => {
    const old = item(walkCutoffMs(NOW) - DAY, "ancient");
    const fresh = item(NOW - DAY, "fresh");
    const state = applyWalkPage(emptyWalk(), page([fresh, old], "c2"), NOW);
    expect(state.items.map((i) => i.id)).toEqual(["fresh"]);
    expect(state.truncatedBy).toBe("months");
    expect(state.complete).toBe(false);
    expect(state.nextCursor).toBeNull();
  });

  it("changes nothing once the walk has stopped", () => {
    const stopped = applyWalkPage(
      emptyWalk(),
      page(batch(2, NOW, "a"), null),
      NOW,
    );
    const after = applyWalkPage(stopped, page(batch(2, NOW, "b"), "c9"), NOW);
    expect(after).toBe(stopped);
  });
});

describe("walkAllHistory", () => {
  it("walks to the end across pages", async () => {
    const fetchPage: HistoryPageFetcher = async (cursor) => {
      if (!cursor) return page(batch(100, NOW, "p1"), "c2");
      return page(batch(50, NOW - DAY, "p2"), null);
    };
    const state = await walkAllHistory(fetchPage, NOW);
    expect(state.complete).toBe(true);
    expect(state.items).toHaveLength(150);
    expect(state.pages).toBe(2);
  });

  it("stops at 20 pages and says so", async () => {
    let calls = 0;
    const fetchPage: HistoryPageFetcher = async () => {
      calls += 1;
      return page(batch(100, NOW, `p${calls}`), `c${calls + 1}`);
    };
    const state = await walkAllHistory(fetchPage, NOW);
    expect(calls).toBe(20);
    expect(state.pages).toBe(20);
    expect(state.items).toHaveLength(2000);
    expect(state.truncatedBy).toBe("pages");
    expect(state.complete).toBe(false);
  });

  it("stops at 2,000 events and says so", async () => {
    const fetchPage: HistoryPageFetcher = async (cursor) => {
      const n = cursor ? Number(cursor) : 0;
      return page(batch(600, NOW - n * DAY, `p${n}`), String(n + 1));
    };
    const state = await walkAllHistory(fetchPage, NOW);
    expect(state.items).toHaveLength(2000);
    expect(state.truncatedBy).toBe("events");
    expect(state.complete).toBe(false);
  });

  it("propagates a fetch failure instead of inventing an end", async () => {
    const fetchPage: HistoryPageFetcher = async () => {
      throw new Error("network down");
    };
    await expect(walkAllHistory(fetchPage, NOW)).rejects.toThrow(
      "network down",
    );
  });
});
