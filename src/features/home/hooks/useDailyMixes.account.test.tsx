import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";
import { useDailyMixes } from "./useDailyMixes";
import { api } from "@/shared/api";
import type { Track } from "@/shared/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const tasteHolder: {
  profile: {
    artists: Record<string, number>;
    tags: Record<string, number>;
    tracks: Record<string, number>;
    updatedAtMs: number;
  };
} = {
  profile: { artists: {}, tags: {}, tracks: {}, updatedAtMs: Date.now() },
};
const sessionHolder: { user: { id: string } | null } = {
  user: { id: "user-1" },
};
const likedHolder: { tracks: Track[]; isLoading: boolean; error: boolean } = {
  tracks: [],
  isLoading: false,
  error: false,
};
const playlistsHolder: {
  playlists: unknown[];
  isLoading: boolean;
  error: unknown;
} = { playlists: [], isLoading: false, error: undefined };
const labelsHolder: {
  byTrack: Record<string, { playlistGenres: string[]; genres: string[] }>;
} = { byTrack: {} };
const analysisHolder: { byTrack: Record<string, unknown> } = { byTrack: {} };

vi.mock("@/shared/api", () => ({
  api: {
    getHistory: vi.fn(),
    getDailyMixes: vi.fn(),
  },
  getAuthSession: () =>
    sessionHolder.user ? { user: sessionHolder.user } : null,
  toClientTrack: (track: any) => ({
    id: track.id,
    title: track.title,
    artists: track.artists || "",
    artistList: track.artistList,
    coverUrl: track.coverUrl || "",
    durationMs: track.durationMs || 0,
    playCount: track.playCount || 0,
    album: track.album,
  }),
}));

vi.mock("@/features/mixer/engine/tasteTracker", () => ({
  getTasteProfile: () => tasteHolder.profile,
}));

vi.mock("@/features/library/hooks", () => ({
  useLikedTracks: () => ({
    data: { tracks: likedHolder.tracks, total: likedHolder.tracks.length },
    isLoading: likedHolder.isLoading,
    error: likedHolder.error,
  }),
  usePlaylistsList: () => ({
    data: { playlists: playlistsHolder.playlists, total: 0 },
    isLoading: playlistsHolder.isLoading,
    error: playlistsHolder.error,
  }),
}));

vi.mock("@/features/genres/trackGenres", () => ({
  labelsForTrack: (trackId: string) =>
    labelsHolder.byTrack[trackId] ?? { playlistGenres: [], genres: [] },
}));

vi.mock("@/shared/storage", () => ({
  linerDb: {
    getAnalysis: vi.fn(
      async (trackId: string) => analysisHolder.byTrack[trackId] ?? null,
    ),
  },
}));

describe("useDailyMixes (local engine)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    localStorage.clear();
    tasteHolder.profile = {
      artists: {},
      tags: {},
      tracks: {},
      updatedAtMs: Date.now(),
    };
    sessionHolder.user = { id: "user-1" };
    likedHolder.tracks = [];
    likedHolder.isLoading = false;
    likedHolder.error = false;
    playlistsHolder.playlists = [];
    playlistsHolder.isLoading = false;
    playlistsHolder.error = undefined;
    labelsHolder.byTrack = {};
    analysisHolder.byTrack = {};
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
  });

  async function renderHook() {
    let hookResult: ReturnType<typeof useDailyMixes> | undefined;
    function TestComponent() {
      hookResult = useDailyMixes();
      return null;
    }
    await act(async () => {
      root.render(<TestComponent />);
    });
    // History load, the cache write and the per-track analysis pass
    // are all microtask chains; flush generously.
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    return () => hookResult;
  }

  it("stays empty for guests and never touches the daily-mixes endpoint", async () => {
    sessionHolder.user = null;
    const getResult = await renderHook();
    expect(getResult()?.isLoading).toBe(false);
    expect(getResult()?.data).toEqual([]);
    expect(api.getDailyMixes).not.toHaveBeenCalled();
  });

  it("builds a DailyMix locally from history tracks sharing a Playlist Genre", async () => {
    sessionHolder.user = { id: "user-daily-local" };
    const ids = ["g1", "g2", "g3", "g4", "g5"];
    for (const id of ids) {
      labelsHolder.byTrack[id] = {
        playlistGenres: ["Amapiano"],
        genres: [],
      };
    }
    tasteHolder.profile = {
      artists: {},
      tags: { Amapiano: 3 },
      tracks: {},
      updatedAtMs: Date.now(),
    };
    (api.getHistory as any).mockResolvedValue({
      items: ids.map((id) => ({
        track: { id, title: `Track ${id}`, artists: "Ama Artist" },
      })),
      nextCursor: null,
    });

    const getResult = await renderHook();
    expect(getResult()?.isLoading).toBe(false);
    const mixes = getResult()?.data ?? [];
    expect(mixes).toHaveLength(1);
    const mix = mixes[0];
    expect(mix.title).toBe("Your Amapiano shelf");
    expect(mix.tracks.map((track) => track.id).sort()).toEqual(ids);
    expect(mix.trackCount).toBe(ids.length);
    expect(mix.clusterArtists).toEqual(["Ama Artist"]);
  });

  it("never calls the server daily-mixes endpoint for a signed-in listener", async () => {
    sessionHolder.user = { id: "user-daily-no-server" };
    const ids = ["g1", "g2", "g3", "g4", "g5"];
    for (const id of ids) {
      labelsHolder.byTrack[id] = {
        playlistGenres: ["Amapiano"],
        genres: [],
      };
    }
    tasteHolder.profile = {
      artists: {},
      tags: { Amapiano: 3 },
      tracks: {},
      updatedAtMs: Date.now(),
    };
    (api.getHistory as any).mockResolvedValue({
      items: ids.map((id) => ({
        track: { id, title: `Track ${id}`, artists: "Ama Artist" },
      })),
      nextCursor: null,
    });

    const getResult = await renderHook();
    expect(getResult()?.data.length).toBeGreaterThan(0);
    expect(api.getDailyMixes).not.toHaveBeenCalled();
  });
});
