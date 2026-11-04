import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { useCollection, type CollectionPageData } from "./useCollection";
import { queryCache } from "@/shared/cache/queryCache";
import { api, ApiError } from "@/shared/api";
import { clearScreenCache } from "@/shared/cache/screenCache";
import { storeLocale } from "@/languages";
import type { Track } from "@/shared/types";

// The collection hook's honest terminal states (S0): a cold load
// that ends without data must say WHICH ending it was — a genuine
// not-found (resolver error / ApiError 404) or a failure (5xx,
// network) — and a failure must be retryable through refetch.
// With cached data on screen, a failed revalidation stays silent.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionHolder: { user: { id: string } | null } = {
  user: { id: "user-1" },
};
const likedHolder: { tracks: Track[] } = { tracks: [] };

vi.mock("@/shared/api", () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError,
    api: {
      getPlaylist: vi.fn(),
      getAlbum: vi.fn(),
      getDailyMixes: vi.fn(),
      getHistory: vi.fn(),
    },
    getAuthSession: () =>
      sessionHolder.user ? { user: sessionHolder.user } : null,
    toClientTrack: (track: any) => ({
      id: track.id,
      title: track.title,
      artists: track.artists || "",
      artistList: track.artistList,
      coverUrl: track.cover?.url ?? track.coverUrl ?? "",
      durationMs: track.durationMs || 0,
      playCount: track.playCount || 0,
      album: track.album,
    }),
    mediaUrl: (url: string) => url,
  };
});

vi.mock("@/features/mixer/engine/tasteTracker", () => ({
  getTasteProfile: () => ({
    artists: {},
    tags: {},
    tracks: {},
    updatedAtMs: Date.now(),
  }),
}));

vi.mock("@/features/library/hooks", () => ({
  useLikedTracks: () => ({
    data: { tracks: likedHolder.tracks, total: likedHolder.tracks.length },
    isLoading: false,
    error: false,
  }),
  usePlaylistsList: () => ({
    data: { playlists: [], total: 0 },
    isLoading: false,
    error: undefined,
  }),
}));

vi.mock("@/features/library/hooks/useLikedTracks", () => ({
  likedTracksSnapshot: () => ({
    tracks: likedHolder.tracks,
    fromServer: true,
  }),
}));

vi.mock("@/features/genres/trackGenres", () => ({
  labelsForTrack: () => ({ playlistGenres: [], genres: [] }),
}));

vi.mock("@/shared/storage", () => ({
  linerDb: { getAnalysis: vi.fn(async () => null) },
}));

const MIX_ID = "mix:playlistGenre:amapiano";
const AMAPIANO = { kind: "playlistGenre", label: "Amapiano" } as const;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  clearScreenCache();
  queryCache.clear();
  vi.clearAllMocks();
  sessionHolder.user = { id: "user-1" };
  likedHolder.tracks = [];
  storeLocale("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderUseCollection(type: string, id: string) {
  let hookResult: ReturnType<typeof useCollection> | undefined;
  function TestComponent() {
    hookResult = useCollection(type, id);
    return null;
  }
  await act(async () => {
    root.render(<TestComponent />);
  });
  await flushMicrotasks();
  return () => hookResult;
}

const SERVER_PLAYLIST = {
  playlist: {
    title: "Server List",
    description: "From the server",
    owner: { displayName: "Owner" },
  },
  items: [
    {
      track: {
        id: "s1",
        title: "Song One",
        artists: "Someone",
        cover: { url: "/c1" },
        durationMs: 1000,
      },
    },
  ],
};

describe("useCollection — error states (S0)", () => {
  it("an ApiError 404 lands on the not-found state", async () => {
    (api.getPlaylist as any).mockRejectedValue(new ApiError(404, "Not found"));

    const getResult = await renderUseCollection("playlist", "srv-missing");

    expect(getResult()?.loading).toBe(false);
    expect(getResult()?.data).toBeNull();
    expect(getResult()?.error).toEqual({ kind: "not-found" });
  });

  it("a local mix with no universe to resolve from lands on not-found", async () => {
    localStorage.setItem(
      "liner_foryou_mixes_v1",
      JSON.stringify({
        dateKey: new Date().toDateString(),
        entries: [{ basis: AMAPIANO, trackIds: ["t1", "t2"] }],
      }),
    );
    // No history seeded and nothing liked: the resolver throws
    // LocalMixNotFoundError, which must read as not-found.

    const getResult = await renderUseCollection("playlist", MIX_ID);

    expect(getResult()?.loading).toBe(false);
    expect(getResult()?.data).toBeNull();
    expect(getResult()?.error).toEqual({ kind: "not-found" });
  });

  it("an ApiError 500 lands on failed, and refetch re-runs the fetch and recovers", async () => {
    (api.getPlaylist as any)
      .mockRejectedValueOnce(new ApiError(500, "Server error"))
      .mockResolvedValue(SERVER_PLAYLIST);

    const getResult = await renderUseCollection("playlist", "srv-123");

    expect(getResult()?.loading).toBe(false);
    expect(getResult()?.data).toBeNull();
    expect(getResult()?.error?.kind).toBe("failed");
    const failure = getResult()?.error;
    expect(failure?.kind === "failed" ? failure.cause : null).toBeInstanceOf(
      ApiError,
    );
    expect(api.getPlaylist).toHaveBeenCalledTimes(1);

    await act(async () => {
      getResult()?.refetch();
    });
    await flushMicrotasks();

    expect(api.getPlaylist).toHaveBeenCalledTimes(2);
    expect(getResult()?.loading).toBe(false);
    expect(getResult()?.error).toBeNull();
    expect(getResult()?.data?.title).toBe("Server List");
    expect(getResult()?.data?.tracks.map((track) => track.id)).toEqual(["s1"]);
  });

  it("a network TypeError lands on failed with the cause kept", async () => {
    (api.getAlbum as any).mockRejectedValue(new TypeError("Failed to fetch"));

    const getResult = await renderUseCollection("album", "alb-x");

    expect(getResult()?.loading).toBe(false);
    expect(getResult()?.data).toBeNull();
    expect(getResult()?.error?.kind).toBe("failed");
    const failure = getResult()?.error;
    expect(failure?.kind === "failed" ? failure.cause : null).toBeInstanceOf(
      TypeError,
    );
  });

  it("cached data stays on screen and error stays null when revalidation fails", async () => {
    const primed: CollectionPageData = {
      type: "playlist",
      title: "Cached List",
      coverUrl: "cover-cached",
      tracks: [],
    };
    // Stale on arrival, so opening it triggers a real revalidation.
    queryCache.set("collection:playlist:srv-cached", primed, 0);
    // Staleness is Date.now() - timestamp > 0: a real millisecond
    // must pass, or the prime can read fresh in the same millisecond
    // and the revalidation this test exercises never fires.
    await new Promise((resolve) => setTimeout(resolve, 2));
    (api.getPlaylist as any).mockRejectedValue(
      new ApiError(500, "Server error"),
    );

    const getResult = await renderUseCollection("playlist", "srv-cached");

    expect(api.getPlaylist).toHaveBeenCalled();
    expect(getResult()?.loading).toBe(false);
    expect(getResult()?.data?.title).toBe("Cached List");
    expect(getResult()?.error).toBeNull();
  });
});
