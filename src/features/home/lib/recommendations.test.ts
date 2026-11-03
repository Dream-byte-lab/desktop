import { describe, it, expect, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TasteProfile } from "@/features/mixer/engine/tasteProfile";
import {
  filterNewTracks,
  loadRecommendationRows,
  selectRecommendationSeeds,
  type RecommendationClient,
} from "./recommendations";

function makeTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    title: `Track ${id}`,
    artists: "Artist A",
    artistId: "artist-a",
    artistList: [{ id: "artist-a", name: "Artist A" }],
    coverUrl: "",
    durationMs: 180_000,
    playCount: 0,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<TasteProfile> = {}): TasteProfile {
  return {
    artists: {},
    tags: {},
    tracks: {},
    updatedAtMs: 1_000,
    ...overrides,
  };
}

const NOW = 2_000;

function tracks(prefix: string, count: number): Track[] {
  return Array.from({ length: count }, (_, i) => makeTrack(`${prefix}${i}`));
}

describe("selectRecommendationSeeds", () => {
  it("aims radio seeds at the taste-heaviest tracks that carry metadata", () => {
    const heard = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    const profile = makeProfile({
      // "ghost" outweighs everything but has no metadata anywhere —
      // a weight alone cannot seed a radio, so it must be skipped.
      tracks: { ghost: 99, t2: 5, t1: 3, t3: 1, t4: 0 },
      artists: { "Artist A": 9 },
    });
    const seeds = selectRecommendationSeeds({
      profile,
      heard,
      liked: [],
      genreLabels: [],
      nowMs: NOW,
    });
    expect(seeds.radioSeeds.map((track) => track.id)).toEqual([
      "t2",
      "t1",
      "t3",
    ]);
  });

  it("resolves top artists to catalogue ids through the heard pool", () => {
    const heard = [
      makeTrack("t1", {
        artists: "Artist B",
        artistId: "artist-b",
        artistList: [{ id: "artist-b", name: "Artist B" }],
      }),
      makeTrack("t2"),
      makeTrack("t3"),
    ];
    const profile = makeProfile({
      tracks: { t1: 2, t2: 2, t3: 2 },
      artists: { "Artist B": 7, "Artist A": 4, "Artist Nobody": 3 },
    });
    const seeds = selectRecommendationSeeds({
      profile,
      heard,
      liked: [],
      genreLabels: [],
      nowMs: NOW,
    });
    // "Artist Nobody" has weight but no pool track to resolve an id
    // from, so it cannot seed a row and must not appear.
    expect(seeds.artistSeeds).toEqual([
      { artistId: "artist-b", artistName: "Artist B" },
      { artistId: "artist-a", artistName: "Artist A" },
    ]);
  });

  it("ranks Playlist Genre seeds by taste weight and drops unweighted labels", () => {
    const heard = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    const profile = makeProfile({
      tracks: { t1: 1, t2: 1, t3: 1 },
      tags: { Chill: 2, Jazz: 1, Workout: 0 },
    });
    const seeds = selectRecommendationSeeds({
      profile,
      heard,
      liked: [],
      genreLabels: ["Workout", "Jazz", "Chill"],
      nowMs: NOW,
    });
    expect(seeds.genreSeeds).toEqual(["Chill", "Jazz"]);
  });

  it("builds no seeds at all below the taste floor", () => {
    const heard = [makeTrack("t1")];
    const thin = makeProfile({
      tracks: { t1: 5 },
      artists: { "Artist A": 5 },
      tags: { Chill: 5 },
    });
    // One weighted track and one weighted artist: real listening,
    // but too thin to aim the catalogue with.
    expect(
      selectRecommendationSeeds({
        profile: thin,
        heard,
        liked: [],
        genreLabels: ["Chill"],
        nowMs: NOW,
      }),
    ).toEqual({ radioSeeds: [], artistSeeds: [], genreSeeds: [] });

    expect(
      selectRecommendationSeeds({
        profile: makeProfile(),
        heard,
        liked: [],
        genreLabels: ["Chill"],
        nowMs: NOW,
      }),
    ).toEqual({ radioSeeds: [], artistSeeds: [], genreSeeds: [] });
  });

  it("lets liked tracks carry metadata for seeds too", () => {
    const liked = [makeTrack("l1"), makeTrack("l2"), makeTrack("l3")];
    const profile = makeProfile({
      tracks: { l1: 3, l2: 2, l3: 1 },
    });
    const seeds = selectRecommendationSeeds({
      profile,
      heard: [],
      liked,
      genreLabels: [],
      nowMs: NOW,
    });
    expect(seeds.radioSeeds.map((track) => track.id)).toEqual([
      "l1",
      "l2",
      "l3",
    ]);
  });
});

describe("filterNewTracks", () => {
  it("excludes known, already-shown and repeated tracks", () => {
    const batch = [
      makeTrack("known"),
      makeTrack("shown"),
      makeTrack("new1"),
      makeTrack("new1"),
      makeTrack("new2"),
    ];
    const fresh = filterNewTracks(
      batch,
      new Set(["known"]),
      new Set(["shown"]),
    );
    expect(fresh.map((track) => track.id)).toEqual(["new1", "new2"]);
  });
});

describe("loadRecommendationRows", () => {
  function fakeClient(overrides: Partial<RecommendationClient> = {}) {
    const calls: { method: string; args: unknown[] }[] = [];
    const client: RecommendationClient = {
      getRadioTracks: vi.fn(async (seedId: string) => {
        calls.push({ method: "radio", args: [seedId] });
        return tracks(`radio-${seedId}-`, 6);
      }),
      getArtistTracks: vi.fn(async (artistId: string) => {
        calls.push({ method: "artist", args: [artistId] });
        return tracks(`artist-${artistId}-`, 6);
      }),
      searchTracks: vi.fn(async (query: string) => {
        calls.push({ method: "search", args: [query] });
        return tracks(`genre-${query}-`, 6);
      }),
      ...overrides,
    };
    return { client, calls };
  }

  const seedTrack = makeTrack("seed1");
  const seeds = {
    radioSeeds: [seedTrack],
    artistSeeds: [{ artistId: "artist-a", artistName: "Artist A" }],
    genreSeeds: ["Chill"],
  };

  it("builds rows whose basis is the seed that actually produced them", async () => {
    const { client, calls } = fakeClient();
    const rows = await loadRecommendationRows(seeds, new Set(), client);
    expect(rows.map((row) => row.basis.kind)).toEqual([
      "similarToTrack",
      "moreFromArtist",
      "playlistGenre",
    ]);
    expect(rows[0].basis).toEqual({ kind: "similarToTrack", seed: seedTrack });
    expect(rows[1].basis).toEqual({
      kind: "moreFromArtist",
      artistId: "artist-a",
      artistName: "Artist A",
    });
    expect(rows[2].basis).toEqual({ kind: "playlistGenre", label: "Chill" });
    // The catalogue was actually asked about those exact seeds.
    expect(calls).toEqual([
      { method: "radio", args: ["seed1"] },
      { method: "artist", args: ["artist-a"] },
      { method: "search", args: ["Chill"] },
    ]);
  });

  it("never shows a track the listener already knows", async () => {
    const known = new Set(["seed1", "radio-seed1-0", "radio-seed1-1"]);
    const { client } = fakeClient();
    const rows = await loadRecommendationRows(seeds, known, client);
    const radioRow = rows.find((row) => row.basis.kind === "similarToTrack");
    // The seed itself and the two known radio results are gone;
    // the remaining four still make an honest row.
    expect(radioRow?.tracks.map((track) => track.id)).toEqual([
      "radio-seed1-2",
      "radio-seed1-3",
      "radio-seed1-4",
      "radio-seed1-5",
    ]);
    for (const row of rows) {
      for (const track of row.tracks) {
        expect(known.has(track.id)).toBe(false);
      }
    }
  });

  it("drops a row that cannot reach four genuinely new tracks", async () => {
    const { client } = fakeClient({
      getArtistTracks: vi.fn(async () => tracks("artist-x-", 3)),
    });
    const rows = await loadRecommendationRows(seeds, new Set(), client);
    expect(rows.map((row) => row.basis.kind)).toEqual([
      "similarToTrack",
      "playlistGenre",
    ]);
  });

  it("does not let a dropped row's tracks poison a later row", async () => {
    const shared = tracks("shared-", 3);
    const { client } = fakeClient({
      // The artist row sees 3 new tracks — below the bar, dropped.
      getArtistTracks: vi.fn(async () => shared),
      // The genre row sees those same 3 plus 3 more: a full row.
      searchTracks: vi.fn(async () => [...shared, ...tracks("genre-only-", 3)]),
    });
    const rows = await loadRecommendationRows(seeds, new Set(), client);
    const genreRow = rows.find((row) => row.basis.kind === "playlistGenre");
    expect(genreRow?.tracks).toHaveLength(6);
    expect(genreRow?.tracks.map((track) => track.id)).toContain("shared-0");
  });

  it("shows a track in at most one row", async () => {
    const overlap = makeTrack("overlap");
    const { client } = fakeClient({
      getRadioTracks: vi.fn(async () => [overlap, ...tracks("r-", 5)]),
      getArtistTracks: vi.fn(async () => [overlap, ...tracks("a-", 5)]),
    });
    const rows = await loadRecommendationRows(seeds, new Set(), client);
    const shownIn = rows.filter((row) =>
      row.tracks.some((track) => track.id === "overlap"),
    );
    expect(shownIn).toHaveLength(1);
    expect(shownIn[0].basis.kind).toBe("similarToTrack");
  });

  it("keeps the surviving rows when one source fails", async () => {
    const { client } = fakeClient({
      getRadioTracks: vi.fn(async () => {
        throw new Error("server unreachable");
      }),
    });
    const rows = await loadRecommendationRows(seeds, new Set(), client);
    expect(rows.map((row) => row.basis.kind)).toEqual([
      "moreFromArtist",
      "playlistGenre",
    ]);
  });

  it("resolves to no rows — never a rejection — when every source fails", async () => {
    const failing: RecommendationClient = {
      getRadioTracks: vi.fn(async () => {
        throw new Error("down");
      }),
      getArtistTracks: vi.fn(async () => {
        throw new Error("down");
      }),
      searchTracks: vi.fn(async () => {
        throw new Error("down");
      }),
    };
    await expect(
      loadRecommendationRows(seeds, new Set(), failing),
    ).resolves.toEqual([]);
  });
});
