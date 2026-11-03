import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { useCollection, type CollectionPageData } from "./useCollection";
import { queryCache } from "@/shared/cache/queryCache";
import { api } from "@/shared/api";
import { clearScreenCache, writeScreenCache } from "@/shared/cache/screenCache";
import { storeLocale } from "@/languages";
import type { HeardEntry } from "@/features/home/hooks/useForYouFeed";
import type { Track } from "@/shared/types";

// Note 23 regression — the open flow at the hook level, with the
// real query cache, screen cache and local resolver: a mix the
// app renders from the day's snapshot must open to its tracks,
// primed (the in-session bridge both mix surfaces now write) and
// cold (the resolver path), and a mix whose universe is genuinely
// unavailable must land on the clean not-found state — data null,
// loading finished — never a spinner forever.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionHolder: { user: { id: string } | null } = {
  user: { id: "user-1" },
};
const likedHolder: { tracks: Track[] } = { tracks: [] };

vi.mock("@/shared/api", () => ({
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
}));

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
const IDS = ["t1", "t2", "t3", "t4", "t5", "t6"];

function makeTrack(id: string, artists = "Ama Artist"): Track {
  return {
    id,
    title: `Track ${id}`,
    artists,
    coverUrl: `cover-${id}`,
    durationMs: 180_000,
    playCount: 0,
  } as Track;
}

function seedHistory(ids: string[]): void {
  const heard: HeardEntry[] = ids.map((id, index) => ({
    track: makeTrack(id),
    plays: 1,
    lastPlayIndex: index,
  }));
  writeScreenCache(`home:for-you-history:user-1`, heard);
}

function seedSnapshot(): void {
  localStorage.setItem(
    "liner_foryou_mixes_v1",
    JSON.stringify({
      dateKey: new Date().toDateString(),
      entries: [{ basis: AMAPIANO, trackIds: IDS }],
    }),
  );
}

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

async function renderUseCollection(id: string) {
  let hookResult: ReturnType<typeof useCollection> | undefined;
  function TestComponent() {
    hookResult = useCollection("playlist", id);
    return null;
  }
  await act(async () => {
    root.render(<TestComponent />);
  });
  for (let i = 0; i < 40; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return () => hookResult;
}

describe("useCollection — opening a local mix (Note 23)", () => {
  it("primed open (a mix surface rendered it this session) shows its tracks", async () => {
    seedSnapshot();
    seedHistory(IDS);
    // Exactly what the mix surfaces' priming writes for the mix.
    const primed: CollectionPageData = {
      type: "playlist",
      title: "Your Amapiano shelf",
      author: "Ama Artist",
      description: "From a Playlist Genre you filed",
      coverUrl: "cover-t1",
      tracks: IDS.map((id) => makeTrack(id)),
      isDailyMix: true,
    };
    queryCache.set(`collection:playlist:${MIX_ID}`, primed);

    const getResult = await renderUseCollection(MIX_ID);

    expect(getResult()?.loading).toBe(false);
    expect(getResult()?.data?.tracks.map((track) => track.id)).toEqual(IDS);
  });

  it("cold open (primed entry gone) resolves locally and shows its tracks", async () => {
    seedSnapshot();
    seedHistory(IDS);

    const getResult = await renderUseCollection(MIX_ID);

    expect(getResult()?.loading).toBe(false);
    expect(getResult()?.data?.tracks.map((track) => track.id)).toEqual(IDS);
    expect(api.getPlaylist).not.toHaveBeenCalled();
  });

  it("a mix whose universe is genuinely unavailable lands on clean not-found, not a spinner", async () => {
    seedSnapshot();
    // No history seeded and nothing liked: nothing the mix could
    // honestly be rebuilt from exists on this machine right now.

    const getResult = await renderUseCollection(MIX_ID);

    expect(getResult()?.loading).toBe(false);
    expect(getResult()?.data).toBeNull();
  });
});
