import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadCollection } from "./useCollection";
import { LocalMixNotFoundError } from "../lib/localMixResolver";
import { api } from "@/shared/api";
import { clearScreenCache, writeScreenCache } from "@/shared/cache/screenCache";
import { storeLocale } from "@/languages";
import type { HeardEntry } from "@/features/home/hooks/useForYouFeed";
import type { Track } from "@/shared/types";

// The cold collection path. Local For You mixes (`mix:…`) must
// resolve entirely on-device — the day's snapshot in localStorage
// plus the feed's universe (persisted history cache merged with
// liked tracks) — with no api call of any kind. Server playlist /
// album ids and the legacy server-mix ids keep their existing
// behaviour, pinned by the regression cases at the bottom.

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

function seedSnapshot(dateKey: string, entries: unknown[]): void {
  localStorage.setItem(
    "liner_foryou_mixes_v1",
    JSON.stringify({ dateKey, entries }),
  );
}

function todayKey(): string {
  return new Date().toDateString();
}

function yesterdayKey(): string {
  const day = new Date();
  day.setDate(day.getDate() - 1);
  return day.toDateString();
}

function expectNoApiCalls(): void {
  expect(api.getPlaylist).not.toHaveBeenCalled();
  expect(api.getAlbum).not.toHaveBeenCalled();
  expect(api.getDailyMixes).not.toHaveBeenCalled();
  expect(api.getHistory).not.toHaveBeenCalled();
}

beforeEach(() => {
  localStorage.clear();
  clearScreenCache();
  vi.clearAllMocks();
  sessionHolder.user = { id: "user-1" };
  likedHolder.tracks = [];
  storeLocale("en");
});

describe("loadCollection — local For You mixes", () => {
  it("resolves a local mix id cold, entirely locally (api never called)", async () => {
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
    seedSnapshot(todayKey(), [{ basis: AMAPIANO, trackIds: ids }]);
    seedHistory(ids);

    const data = await loadCollection("playlist", MIX_ID);

    expect(data.type).toBe("playlist");
    expect(data.isDailyMix).toBe(true);
    expect(data.tracks.map((track) => track.id)).toEqual(ids);
    expect(data.title).toBe("Your Amapiano shelf");
    expect(data.description).toBe("From a Playlist Genre you filed");
    expect(data.author).toBe("Ama Artist");
    expect(data.coverUrl).toBe("cover-t1");
    expectNoApiCalls();
  });

  it("is stable within the day and never rewrites the snapshot", async () => {
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
    seedSnapshot(todayKey(), [{ basis: AMAPIANO, trackIds: ids }]);
    seedHistory(ids);
    const before = localStorage.getItem("liner_foryou_mixes_v1");

    const first = await loadCollection("playlist", MIX_ID);
    const second = await loadCollection("playlist", MIX_ID);

    expect(second).toEqual(first);
    expect(localStorage.getItem("liner_foryou_mixes_v1")).toBe(before);
    expectNoApiCalls();
  });

  it("after a day roll, resolves the mix as drawn today under the same cluster identity", async () => {
    // Yesterday's draw (different membership) is gone; today's
    // snapshot carries the same cluster with its own membership.
    const todaysIds = ["t6", "t2", "t3", "t4", "t5"];
    seedSnapshot(todayKey(), [{ basis: AMAPIANO, trackIds: todaysIds }]);
    seedHistory(["t1", "t2", "t3", "t4", "t5", "t6"]);

    const data = await loadCollection("playlist", MIX_ID);

    expect(data.tracks.map((track) => track.id)).toEqual(todaysIds);
    expectNoApiCalls();
  });

  it("never serves a previous day's snapshot (roll not yet redrawn → not found)", async () => {
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
    seedSnapshot(yesterdayKey(), [{ basis: AMAPIANO, trackIds: ids }]);
    seedHistory(ids);

    await expect(loadCollection("playlist", MIX_ID)).rejects.toBeInstanceOf(
      LocalMixNotFoundError,
    );
    expectNoApiCalls();
  });

  it("reports a cluster that vanished from today's snapshot as not found", async () => {
    seedSnapshot(todayKey(), [
      { basis: { kind: "era", label: "2010s" }, trackIds: ["t1"] },
    ]);
    seedHistory(["t1", "t2", "t3", "t4", "t5", "t6"]);

    await expect(loadCollection("playlist", MIX_ID)).rejects.toBeInstanceOf(
      LocalMixNotFoundError,
    );
    expectNoApiCalls();
  });

  it("drops an entry whose surviving membership falls below the coherence bar", async () => {
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
    seedSnapshot(todayKey(), [{ basis: AMAPIANO, trackIds: ids }]);
    seedHistory(["t1", "t2", "t3", "t4"]); // t5/t6 no longer in the universe

    await expect(loadCollection("playlist", MIX_ID)).rejects.toBeInstanceOf(
      LocalMixNotFoundError,
    );
    expectNoApiCalls();
  });

  it("resolves ids the history lacks from the liked side of the universe", async () => {
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
    seedSnapshot(todayKey(), [{ basis: AMAPIANO, trackIds: ids }]);
    seedHistory(["t1", "t2", "t3", "t4"]);
    likedHolder.tracks = [makeTrack("t5"), makeTrack("t6")];

    const data = await loadCollection("playlist", MIX_ID);

    expect(data.tracks.map((track) => track.id)).toEqual(ids);
    expectNoApiCalls();
  });

  it("is not found when no snapshot exists at all", async () => {
    seedHistory(["t1", "t2", "t3", "t4", "t5", "t6"]);

    await expect(loadCollection("playlist", MIX_ID)).rejects.toBeInstanceOf(
      LocalMixNotFoundError,
    );
    expectNoApiCalls();
  });
});

describe("loadCollection — server ids keep their behaviour", () => {
  it("loads a server playlist through getPlaylist", async () => {
    (api.getPlaylist as any).mockResolvedValue({
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
    });

    const data = await loadCollection("playlist", "srv-123");

    expect(api.getPlaylist).toHaveBeenCalledTimes(1);
    expect(api.getPlaylist).toHaveBeenCalledWith("srv-123");
    expect(data.title).toBe("Server List");
    expect(data.author).toBe("Owner");
    expect(data.tracks.map((track) => track.id)).toEqual(["s1"]);
    expect(data.isDailyMix).toBeUndefined();
  });

  it("loads an album through getAlbum", async () => {
    (api.getAlbum as any).mockResolvedValue({
      type: "album",
      title: "Alb",
      artists: [{ id: "a1", name: "Art" }],
      year: 2020,
      cover: { url: "/ac" },
      tracks: [{ id: "x1", title: "X", artists: "Art", durationMs: 1000 }],
    });

    const data = await loadCollection("album", "alb-1");

    expect(api.getAlbum).toHaveBeenCalledTimes(1);
    expect(api.getAlbum).toHaveBeenCalledWith("alb-1");
    expect(data.type).toBe("album");
    expect(data.title).toBe("Alb");
    expect(data.tracks).toHaveLength(1);
    expect(data.tracks[0].album?.id).toBe("alb-1");
  });

  it("keeps the legacy server-mix branch for mix- ids", async () => {
    (api.getDailyMixes as any).mockResolvedValue({ items: [] });
    (api.getPlaylist as any).mockResolvedValue({
      type: "playlist",
      title: "Fallback",
      cover: null,
      tracks: [],
    });

    const data = await loadCollection("playlist", "mix-legacy-1");

    expect(api.getDailyMixes).toHaveBeenCalledTimes(1);
    expect(api.getPlaylist).toHaveBeenCalledWith("mix-legacy-1");
    expect(data.title).toBe("Fallback");
  });
});
