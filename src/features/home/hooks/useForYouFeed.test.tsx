import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";
import {
  buildForYouCandidates,
  factsFromAnalysisRecord,
  mergeUniverse,
  useForYouFeed,
  type HeardEntry,
} from "./useForYouFeed";
import { ANALYSIS_VERSION } from "@/features/mixer/engine/analyseTrack";
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

function analysisRecord(
  trackId: string,
  energy: number,
  overrides: { recordVersion?: number; analysisVersion?: number } = {},
): unknown {
  return {
    trackId,
    audioHash: "hash-a",
    analysisVersion: overrides.recordVersion ?? ANALYSIS_VERSION,
    depth: "deep",
    savedAt: Date.now(),
    analysis: {
      analysisVersion: overrides.analysisVersion ?? ANALYSIS_VERSION,
      audioHash: "hash-a",
      beatMap: {
        bpm: 120,
        firstBeatSec: 0,
        beatsPerBar: 4,
        durationSec: 60,
        grid: { anchors: [], sections: [], confidence: 0.5 },
      },
      tempoConfidence: 0.9,
      energyCurve: [
        { timeSec: 0, energy },
        { timeSec: 1, energy },
      ],
      drops: [],
      key: { camelot: "8A", confidence: 0.9 },
      vocalRanges: [{ startSec: 0, endSec: 30 }],
      loudness: 0.2,
      sections: [],
    },
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

describe("factsFromAnalysisRecord", () => {
  it("extracts coarse facts from a trustworthy record", () => {
    const facts = factsFromAnalysisRecord(analysisRecord("t1", 0.2) as never);
    expect(facts).toEqual({
      bpm: 120,
      meanEnergy: 0.2,
      vocalShare: 0.5,
      camelot: "8A",
    });
  });

  it("ignores a record with a stale outer analysisVersion", () => {
    const facts = factsFromAnalysisRecord(
      analysisRecord("t1", 0.2, {
        recordVersion: ANALYSIS_VERSION - 1,
      }) as never,
    );
    expect(facts).toBeNull();
  });

  it("ignores a record whose inner analysisVersion is stale", () => {
    const facts = factsFromAnalysisRecord(
      analysisRecord("t1", 0.2, {
        analysisVersion: ANALYSIS_VERSION - 1,
      }) as never,
    );
    expect(facts).toBeNull();
  });

  it("ignores a record whose analysis lost its beat grid", () => {
    const record = analysisRecord("t1", 0.2) as {
      analysis: { beatMap: Record<string, unknown> };
    };
    delete record.analysis.beatMap.grid;
    expect(factsFromAnalysisRecord(record as never)).toBeNull();
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
    analysisHolder.byTrack = {};
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
    for (const id of ids) {
      analysisHolder.byTrack[id] = analysisRecord(id, 0.2);
    }
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

  it("ignores stored analyses with a stale analysisVersion", async () => {
    sessionHolder.user = { id: "user-mood-stale" };
    const ids = ["s1", "s2", "s3", "s4", "s5"];
    likedHolder.tracks = ids.map((id) => makeTrack(id, "Calm Artist"));
    for (const id of ids) {
      analysisHolder.byTrack[id] = analysisRecord(id, 0.2, {
        recordVersion: ANALYSIS_VERSION - 1,
      });
    }
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
