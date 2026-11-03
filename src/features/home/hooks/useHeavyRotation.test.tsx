import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";
import {
  rankHeavyRotation,
  useHeavyRotation,
  type HeardTrack,
} from "./useHeavyRotation";
import { api } from "@/shared/api";

const tasteHolder: { tracks: Record<string, number> } = { tracks: {} };
const sessionHolder: { user: { id: string } | null } = {
  user: { id: "user-1" },
};

vi.mock("@/shared/api", () => ({
  api: {
    getHistory: vi.fn(),
  },
  getAuthSession: () =>
    sessionHolder.user ? { user: sessionHolder.user } : null,
  toClientTrack: (track: any) => ({
    id: track.id,
    title: track.title,
    artists: track.artists || "",
    coverUrl: track.coverUrl || "",
    durationMs: track.durationMs || 0,
    playCount: track.playCount || 0,
    album: track.album,
  }),
}));

vi.mock("@/features/mixer/engine/tasteTracker", () => ({
  getTasteProfile: () => ({
    artists: {},
    tags: {},
    tracks: tasteHolder.tracks,
    updatedAtMs: Date.now(),
  }),
}));

vi.mock("@/features/mixer/engine/tasteProfile", () => ({
  decayProfile: (profile: any) => profile,
}));

function heard(id: string, plays: number, lastIndex: number): HeardTrack {
  return {
    track: {
      id,
      title: `Track ${id}`,
      artists: "Artist",
      coverUrl: "",
      durationMs: 0,
      playCount: 0,
    } as HeardTrack["track"],
    plays,
    lastIndex,
  };
}

describe("rankHeavyRotation", () => {
  it("leads with taste-weighted tracks when the profile has real signal", () => {
    const entries = [
      heard("a", 5, 0),
      heard("b", 1, 1),
      heard("c", 2, 2),
      heard("d", 1, 3),
      heard("e", 9, 4),
    ];
    const ranked = rankHeavyRotation(entries, { a: 1, b: 4, c: 3, d: 2 }, 20);
    // "e" is the most-played but carries no taste weight, so with a
    // real taste signal present it does not lead the rail.
    expect(ranked.map((item) => item.item.id)).toEqual(["b", "c", "d", "a"]);
  });

  it("falls back to play frequency when taste signal is sparse", () => {
    const entries = [heard("a", 1, 0), heard("b", 3, 1), heard("c", 2, 2)];
    const ranked = rankHeavyRotation(entries, { a: 5 }, 20);
    expect(ranked.map((item) => item.item.id)).toEqual(["b", "c"]);
    expect(ranked[0].playCount).toBe(3);
  });

  it("returns nothing when there is neither taste signal nor a repeat play", () => {
    const entries = [heard("a", 1, 0), heard("b", 1, 1)];
    expect(rankHeavyRotation(entries, {}, 20)).toEqual([]);
  });
});

describe("useHeavyRotation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    tasteHolder.tracks = {};
    sessionHolder.user = { id: "user-1" };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
  });

  async function renderHook(limit: number) {
    let hookResult: ReturnType<typeof useHeavyRotation> | undefined;
    function TestComponent() {
      hookResult = useHeavyRotation(limit);
      return null;
    }
    await act(async () => {
      root.render(<TestComponent />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return () => hookResult;
  }

  it("builds the rail from the listener's own history frequency", async () => {
    (api.getHistory as any).mockResolvedValue({
      items: [
        { track: { id: "x", title: "X" } },
        { track: { id: "y", title: "Y" } },
        { track: { id: "x", title: "X" } },
        { track: { id: "x", title: "X" } },
        { track: { id: "y", title: "Y" } },
      ],
      nextCursor: null,
    });
    const getResult = await renderHook(31);
    expect(getResult()?.isLoading).toBe(false);
    expect(getResult()?.data.map((item) => item.item.id)).toEqual(["x", "y"]);
  });

  it("stays empty for guests without touching the history endpoint", async () => {
    sessionHolder.user = null;
    const getResult = await renderHook(32);
    expect(getResult()?.data).toEqual([]);
    expect(api.getHistory).not.toHaveBeenCalled();
  });
});
