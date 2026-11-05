import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";
import {
  buildForYouCandidates,
  factsFromTrackRead,
  mergeUniverse,
  useForYouFeed,
  type HeardEntry,
} from "./useForYouFeed";
import { ANALYSIS_VERSION } from "@/features/mixer/liverave/analyse";
import type { TrackRead } from "@/features/mixer/liverave/facts";
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
const readsHolder: { reads: TrackRead[] } = { reads: [] };
/** The attribution bridge's pairs, as listTrackHashes returns them. */
const bridgeHolder: { pairs: [string, string][] } = { pairs: [] };

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

// The new engine's storage seam: reads are enumerated (the store
// is content-addressed by audioHash — there is no per-track key),
// so the fake hands back the whole stored set plus the attribution
// bridge's pairs, and the hook's own gates decide what may be used.
vi.mock("@/features/mixer/liverave/storage", () => ({
  listReads: vi.fn(async () => readsHolder.reads),
  listTrackHashes: vi.fn(async () => new Map(bridgeHolder.pairs)),
}));

function makeTrack(id: string, artists = "Artist"): Track {
  return {
    id,
    title: `Track ${id}`,
    artists,
    coverUrl: "",
    durationMs: 0,
    playCount: 0,
  } as Track;
}

/**
 * A stored TrackRead in the new engine's shape. The first argument
 * is the read's audioHash. Attribution reaches a universe track
 * two ways (see the note on factsFromTrackRead): through the
 * attribution bridge (bridgeHolder pairs: trackId → audioHash —
 * the production path), or, in the older fixtures below, by the
 * tracks' ids doubling as their hashes (the direct-key case).
 */
function storedRead(
  audioHash: string,
  energy: number,
  overrides: { analysisVersion?: number } = {},
): TrackRead {
  return {
    audioHash,
    analysisVersion: overrides.analysisVersion ?? ANALYSIS_VERSION,
    depth: "deep",
    durationSec: 60,
    bpm: 120,
    tempoConfidence: 0.9,
    grid: {
      beatsMs: [0, 500, 1000, 1500],
      downbeatsMs: [0],
      beatsPerBar: 4,
      confidence: 0.6,
    },
    key: { tonic: 9, mode: "minor", camelot: "8A", confidence: 0.9 },
    sections: [
      { kind: "verse", startMs: 0, endMs: 60_000, meanEnergy: energy },
    ],
    energyCurvePerSec: [energy, energy],
    energyContour: [],
    vocalActivity: [
      { startMs: 0, endMs: 30_000, activity: 1, confidence: 0.9 },
    ],
    drops: [],
    loudnessRms: 0.2,
  };
}

describe("mergeUniverse + buildForYouCandidates", () => {
  beforeEach(() => {
    labelsHolder.byTrack = {};
    tasteHolder.profile = {
      artists: {},
      tags: {},
      tracks: {},
      updatedAtMs: Date.now(),
    };
  });

  it("merges history and likes: liked-only joins at plays 0, shared keeps history plays", () => {
    const heardA = makeTrack("a");
    const heardB = makeTrack("b");
    const heard: HeardEntry[] = [
      { track: heardA, plays: 3, lastPlayIndex: 0 },
      { track: heardB, plays: 1, lastPlayIndex: 1 },
    ];
    const likedOnly = makeTrack("c");
    const universe = mergeUniverse(heard, [makeTrack("b"), likedOnly]);

    expect(universe).toHaveLength(3);
    const byId = new Map(universe.map((entry) => [entry.track.id, entry]));
    expect(byId.get("a")).toMatchObject({ plays: 3, liked: false });
    // The shared track keeps the history Track object and its plays.
    expect(byId.get("b")?.track).toBe(heardB);
    expect(byId.get("b")).toMatchObject({ plays: 1, liked: true });
    expect(byId.get("c")).toMatchObject({
      plays: 0,
      lastPlayIndex: Number.POSITIVE_INFINITY,
      liked: true,
    });

    const candidates = buildForYouCandidates(
      universe,
      tasteHolder.profile as never,
      new Map(),
    );
    const likedOnlyCandidate = candidates.find(
      (candidate) => candidate.track.id === "c",
    );
    expect(likedOnlyCandidate?.plays).toBe(0);
    expect(likedOnlyCandidate?.liked).toBe(true);
    expect(
      candidates.find((candidate) => candidate.track.id === "b")?.plays,
    ).toBe(1);
  });
});

describe("factsFromTrackRead", () => {
  it("extracts coarse facts from a trustworthy read", () => {
    const facts = factsFromTrackRead(storedRead("t1", 0.2));
    expect(facts).toEqual({
      bpm: 120,
      meanEnergy: 0.2,
      vocalShare: 0.5,
      camelot: "8A",
    });
  });

  it("ignores a read with a stale analysisVersion", () => {
    const facts = factsFromTrackRead(
      storedRead("t1", 0.2, { analysisVersion: ANALYSIS_VERSION - 1 }),
    );
    expect(facts).toBeNull();
  });

  it("ignores a read whose beat grid is missing", () => {
    const read = storedRead("t1", 0.2);
    read.grid = { ...read.grid, beatsMs: [] };
    expect(factsFromTrackRead(read)).toBeNull();
  });

  it("ignores a read with no typed sections", () => {
    const read = storedRead("t1", 0.2);
    read.sections = [];
    expect(factsFromTrackRead(read)).toBeNull();
  });

  it("returns null for a missing read", () => {
    expect(factsFromTrackRead(null)).toBeNull();
    expect(factsFromTrackRead(undefined)).toBeNull();
  });

  it("weights the vocal share by graded activity", () => {
    const read = storedRead("t1", 0.2);
    // Half the track covered at half activity → share 0.25.
    read.vocalActivity = [
      { startMs: 0, endMs: 30_000, activity: 0.5, confidence: 0.9 },
    ];
    expect(factsFromTrackRead(read)?.vocalShare).toBeCloseTo(0.25);
  });
});

describe("useForYouFeed", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    // The hook now persists the day's mixes to localStorage; clear
    // it before every test so one test's snapshot cannot leak into
    // the next test's first generation.
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
    readsHolder.reads = [];
    bridgeHolder.pairs = [];
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
  });

  async function renderHook() {
    let hookResult: ReturnType<typeof useForYouFeed> | undefined;
    function TestComponent() {
      hookResult = useForYouFeed();
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

  it("stays empty and not failed for guests without touching the history endpoint", async () => {
    sessionHolder.user = null;
    const getResult = await renderHook();
    expect(api.getHistory).not.toHaveBeenCalled();
    expect(getResult()?.isLoading).toBe(false);
    expect(getResult()?.hasAnyData).toBe(false);
    expect(getResult()?.loadFailed).toBe(false);
    expect(getResult()?.mixes).toEqual([]);
    expect(getResult()?.becauseRows).toEqual([]);
    expect(getResult()?.genreShelves).toEqual([]);
    expect(getResult()?.moodRows).toEqual([]);
  });

  it("builds a Playlist Genre mix from history tracks sharing a label with taste signal", async () => {
    sessionHolder.user = { id: "user-mix" };
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
    expect(getResult()?.hasAnyData).toBe(true);
    const mix = getResult()?.mixes.find(
      (entry) => entry.basis.kind === "playlistGenre",
    );
    expect(mix?.basis).toEqual({ kind: "playlistGenre", label: "Amapiano" });
    expect(mix?.tracks.map((track) => track.id).sort()).toEqual(ids);
  });

  it("builds a low-energy mood row from stored analyses", async () => {
    sessionHolder.user = { id: "user-mood" };
    const ids = ["m1", "m2", "m3", "m4", "m5"];
    likedHolder.tracks = ids.map((id) => makeTrack(id, "Calm Artist"));
    readsHolder.reads = ids.map((id) => storedRead(id, 0.2));
    (api.getHistory as any).mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    const getResult = await renderHook();
    expect(getResult()?.isLoading).toBe(false);
    const row = getResult()?.moodRows.find(
      (entry) => entry.kind === "lowEnergy",
    );
    expect(row?.tracks.map((track) => track.id).sort()).toEqual(ids);
  });

  it("attributes stored analyses to tracks through the bridge, whose ids are not hashes", async () => {
    sessionHolder.user = { id: "user-mood-bridge" };
    const ids = ["b1", "b2", "b3", "b4", "b5"];
    likedHolder.tracks = ids.map((id) => makeTrack(id, "Calm Artist"));
    // Reads live under hashes that share nothing with the track
    // ids; only the bridge pairs can attribute them.
    readsHolder.reads = ids.map((id) => storedRead(`hash-${id}`, 0.2));
    bridgeHolder.pairs = ids.map(
      (id) => [id, `hash-${id}`] as [string, string],
    );
    (api.getHistory as any).mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    const getResult = await renderHook();
    expect(getResult()?.isLoading).toBe(false);
    const row = getResult()?.moodRows.find(
      (entry) => entry.kind === "lowEnergy",
    );
    expect(row?.tracks.map((track) => track.id).sort()).toEqual(ids);
  });

  it("leaves tracks fact-less when the bridge holds no entry for them (graceful absence)", async () => {
    sessionHolder.user = { id: "user-mood-no-bridge" };
    const ids = ["n1", "n2", "n3", "n4", "n5"];
    likedHolder.tracks = ids.map((id) => makeTrack(id, "Calm Artist"));
    // The reads exist, but under hashes no bridge entry points to
    // and no track id equals — attribution honestly fails and the
    // tracks keep the feed's long-standing null-facts behaviour.
    readsHolder.reads = ids.map((id) => storedRead(`hash-${id}`, 0.2));
    bridgeHolder.pairs = [];
    (api.getHistory as any).mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    const getResult = await renderHook();
    expect(getResult()?.isLoading).toBe(false);
    expect(getResult()?.moodRows).toEqual([]);
  });

  it("ignores stored analyses with a stale analysisVersion", async () => {
    sessionHolder.user = { id: "user-mood-stale" };
    const ids = ["s1", "s2", "s3", "s4", "s5"];
    likedHolder.tracks = ids.map((id) => makeTrack(id, "Calm Artist"));
    readsHolder.reads = ids.map((id) =>
      storedRead(id, 0.2, { analysisVersion: ANALYSIS_VERSION - 1 }),
    );
    (api.getHistory as any).mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    const getResult = await renderHook();
    expect(getResult()?.moodRows).toEqual([]);
  });

  describe("daily snapshot", () => {
    beforeEach(() => {
      // Snapshot hygiene both ways: no snapshot written by an
      // earlier test (or an earlier snapshot test) may leak in,
      // and each test seeds exactly the snapshot it means to.
      localStorage.clear();
    });

    it("follows a snapshot seeded under today's dateKey instead of generating fresh", async () => {
      sessionHolder.user = { id: "user-snapshot-hit" };
      const ids = ["g1", "g2", "g3", "g4", "g5", "g6"];
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
      // A different order and a strict subset (5 of the 6 labelled
      // tracks) than fresh generation would produce.
      const snapshotTrackIds = ["g6", "g3", "g1", "g5", "g2"];
      localStorage.setItem(
        "liner_foryou_mixes_v1",
        JSON.stringify({
          dateKey: new Date().toDateString(),
          entries: [
            {
              basis: { kind: "playlistGenre", label: "Amapiano" },
              trackIds: snapshotTrackIds,
            },
          ],
        }),
      );

      const getResult = await renderHook();
      expect(getResult()?.isLoading).toBe(false);
      expect(getResult()?.mixes).toHaveLength(1);
      const mix = getResult()?.mixes[0];
      expect(mix?.basis).toEqual({
        kind: "playlistGenre",
        label: "Amapiano",
      });
      expect(mix?.tracks.map((track) => track.id)).toEqual(snapshotTrackIds);
    });

    it("regenerates over a stale snapshot and persists today's dateKey", async () => {
      sessionHolder.user = { id: "user-snapshot-stale" };
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
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      localStorage.setItem(
        "liner_foryou_mixes_v1",
        JSON.stringify({
          dateKey: yesterday.toDateString(),
          entries: [
            {
              basis: { kind: "playlistGenre", label: "Amapiano" },
              trackIds: ["g5", "g4", "g3", "g2", "g1"],
            },
          ],
        }),
      );

      const getResult = await renderHook();
      expect(getResult()?.isLoading).toBe(false);
      const mix = getResult()?.mixes.find(
        (entry) => entry.basis.kind === "playlistGenre",
      );
      expect(mix?.basis).toEqual({
        kind: "playlistGenre",
        label: "Amapiano",
      });
      expect(mix?.tracks.map((track) => track.id).sort()).toEqual(ids);

      const stored = JSON.parse(
        localStorage.getItem("liner_foryou_mixes_v1") ?? "null",
      ) as {
        dateKey: string;
        entries: { basis: { kind: string }; trackIds: string[] }[];
      } | null;
      expect(stored?.dateKey).toBe(new Date().toDateString());
      const entry = stored?.entries.find(
        (item) => item.basis.kind === "playlistGenre",
      );
      expect(entry?.trackIds.slice().sort()).toEqual(ids);
    });
  });
});
