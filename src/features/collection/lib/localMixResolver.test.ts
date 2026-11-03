import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LocalMixNotFoundError,
  resolveLocalMixCollection,
} from "./localMixResolver";
import { storeLocale } from "@/languages";
import type { HeardEntry } from "@/features/home/hooks/useForYouFeed";
import type { Track } from "@/shared/types";

// Note 23 regression — the resolver must wait for the persisted
// screen cache to actually arrive before judging a mix missing.
// Production models as: hydrateScreenCache() is the first-paint
// race and resolves almost immediately, while the IndexedDB scan
// lands later; readScreenCache can only see the history entry
// once the scan has landed. Before the fix the resolver awaited
// the raced promise, read an empty universe and threw not-found
// for a mix that exists; now it awaits whenScreenCacheHydrated.

const sessionHolder: { user: { id: string } | null } = {
  user: { id: "user-1" },
};
const likedHolder: { tracks: Track[] } = { tracks: [] };

const cacheHolder: {
  entries: Map<string, { data: unknown; savedAt: number }>;
  landed: boolean;
  completeScan: (() => void) | null;
} = { entries: new Map(), landed: false, completeScan: null };

vi.mock("@/shared/cache/screenCache", () => ({
  // The first-paint race: resolves immediately, scan still running.
  hydrateScreenCache: () => Promise.resolve(),
  // The real read: settles only when the test lands the scan.
  whenScreenCacheHydrated: () =>
    new Promise<void>((resolve) => {
      cacheHolder.completeScan = () => {
        cacheHolder.landed = true;
        resolve();
      };
    }),
  readScreenCache: (key: string) =>
    cacheHolder.landed ? cacheHolder.entries.get(key) : undefined,
  // Remaining surface, stubbed so the wider import graph loads;
  // none of it is exercised by these tests.
  writeScreenCache: (key: string, data: unknown) => ({
    data,
    savedAt: Date.now(),
  }),
  touchScreenCache: () => undefined,
  subscribeScreenCache: () => () => undefined,
  notifyScreenCache: () => undefined,
  clearScreenCache: () => undefined,
  clearPersistedScreenCache: () => undefined,
  getScreenCacheStats: () => ({ count: 0 }),
}));

vi.mock("@/shared/api", () => ({
  api: {
    getPlaylist: vi.fn(),
    getAlbum: vi.fn(),
    getDailyMixes: vi.fn(),
    getHistory: vi.fn(),
  },
  getAuthSession: () =>
    sessionHolder.user ? { user: sessionHolder.user } : null,
  toClientTrack: (track: any) => track,
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
const IDS = ["t1", "t2", "t3", "t4", "t5", "t6"];

function makeTrack(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    artists: "Ama Artist",
    coverUrl: `cover-${id}`,
    durationMs: 180_000,
    playCount: 0,
  } as Track;
}

function seedPersistedHistory(ids: string[]): void {
  const heard: HeardEntry[] = ids.map((id, index) => ({
    track: makeTrack(id),
    plays: 1,
    lastPlayIndex: index,
  }));
  cacheHolder.entries.set(`home:for-you-history:user-1`, {
    data: heard,
    savedAt: Date.now(),
  });
}

function seedSnapshot(): void {
  localStorage.setItem(
    "liner_foryou_mixes_v1",
    JSON.stringify({
      dateKey: new Date().toDateString(),
      entries: [
        { basis: { kind: "playlistGenre", label: "Amapiano" }, trackIds: IDS },
      ],
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  sessionHolder.user = { id: "user-1" };
  likedHolder.tracks = [];
  cacheHolder.entries.clear();
  cacheHolder.landed = false;
  cacheHolder.completeScan = null;
  storeLocale("en");
});

describe("resolveLocalMixCollection — hydration (Note 23)", () => {
  it("waits for the persisted cache scan and resolves the mix once it lands", async () => {
    seedSnapshot();
    seedPersistedHistory(IDS);

    let settled = false;
    const promise = resolveLocalMixCollection(MIX_ID).then((data) => {
      settled = true;
      return data;
    });

    // The scan has not landed: the resolver must still be waiting,
    // not already failed with not-found.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(cacheHolder.completeScan).not.toBeNull();
    expect(settled).toBe(false);

    cacheHolder.completeScan?.();
    const data = await promise;

    expect(data.tracks.map((track) => track.id)).toEqual(IDS);
    expect(data.isDailyMix).toBe(true);
  });

  it("still reports not found when the landed cache holds no universe for the mix", async () => {
    seedSnapshot();
    // Nothing persisted: the scan lands empty.

    const promise = resolveLocalMixCollection(MIX_ID);
    const assertion = expect(promise).rejects.toBeInstanceOf(
      LocalMixNotFoundError,
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    cacheHolder.completeScan?.();
    await assertion;
  });
});
