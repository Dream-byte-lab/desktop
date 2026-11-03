import { describe, it, expect } from "vitest";
import type { Track } from "@/shared/types";
import {
  FOR_YOU_LIMITS,
  applyDailySnapshot,
  buildBecauseRows,
  buildGenreShelves,
  buildMixes,
  buildMoodRows,
  camelotCompatibility,
  forYouMixId,
  hashSeedKey,
  primaryArtistOf,
  rotateDeterministic,
  type DailyMixSnapshot,
  type ForYouCandidate,
  type ForYouMix,
  type ForYouTrackFacts,
} from "./forYouFeed";

function makeTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    title: `Track ${id}`,
    artists: "Artist A",
    coverUrl: "",
    durationMs: 180_000,
    playCount: 0,
    ...overrides,
  };
}

function makeCandidate(
  id: string,
  overrides: Partial<ForYouCandidate> = {},
): ForYouCandidate {
  return {
    track: makeTrack(id),
    plays: 0,
    lastPlayIndex: Number.POSITIVE_INFINITY,
    liked: false,
    tasteScore: 0,
    playlistGenres: [],
    genres: [],
    facts: null,
    ...overrides,
  };
}

function makeFacts(
  overrides: Partial<ForYouTrackFacts> = {},
): ForYouTrackFacts {
  return {
    bpm: null,
    meanEnergy: null,
    vocalShare: null,
    camelot: null,
    ...overrides,
  };
}

/** n candidates that lean in via tasteScore, ranked best-first by id order. */
function leaning(
  prefix: string,
  count: number,
  overrides: Partial<ForYouCandidate> = {},
): ForYouCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    makeCandidate(`${prefix}${i + 1}`, {
      tasteScore: count - i,
      ...overrides,
    }),
  );
}

const ids = (tracks: Track[]): string[] => tracks.map((track) => track.id);

describe("hashSeedKey", () => {
  it("is deterministic and returns an unsigned 32-bit int", () => {
    const first = hashSeedKey("night-1");
    expect(hashSeedKey("night-1")).toBe(first);
    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(0xffffffff);
  });

  it("gives distinct hashes for distinct seed keys", () => {
    const hashes = new Set(
      ["seed-a", "seed-b", "seed-c", "night-1", "night-2", ""].map(hashSeedKey),
    );
    expect(hashes.size).toBe(6);
  });

  it("hashes the empty string to the FNV-1a offset basis", () => {
    expect(hashSeedKey("")).toBe(2166136261);
  });
});

describe("rotateDeterministic", () => {
  it("rotates left by the offset", () => {
    expect(rotateDeterministic([1, 2, 3, 4], 1)).toEqual([2, 3, 4, 1]);
    expect(rotateDeterministic([1, 2, 3, 4], 3)).toEqual([4, 1, 2, 3]);
  });

  it("wraps offsets larger than the length", () => {
    expect(rotateDeterministic([1, 2, 3, 4], 5)).toEqual([2, 3, 4, 1]);
    expect(rotateDeterministic([1, 2, 3, 4], 8)).toEqual([1, 2, 3, 4]);
  });

  it("returns an unchanged copy for empty and single-item inputs", () => {
    expect(rotateDeterministic([], 3)).toEqual([]);
    expect(rotateDeterministic(["only"], 7)).toEqual(["only"]);
  });

  it("does not mutate the input", () => {
    const input = [1, 2, 3];
    rotateDeterministic(input, 1);
    expect(input).toEqual([1, 2, 3]);
  });
});

describe("primaryArtistOf", () => {
  it("prefers the first artistList entry", () => {
    const track = makeTrack("t", {
      artists: "Someone Else, Guest",
      artistList: [{ name: "Listed Artist" }, { name: "Second" }],
    });
    expect(primaryArtistOf(track)).toBe("Listed Artist");
  });

  it("falls back to the artists string before the first comma", () => {
    expect(
      primaryArtistOf(makeTrack("t", { artists: "Main Act, Featured Act" })),
    ).toBe("Main Act");
    expect(primaryArtistOf(makeTrack("t", { artists: "Solo Act" }))).toBe(
      "Solo Act",
    );
  });

  it("ignores an empty artistList name and an empty first segment", () => {
    const blank = makeTrack("t", {
      artists: "Fallback Act",
      artistList: [{ name: "  " }],
    });
    expect(primaryArtistOf(blank)).toBe("Fallback Act");
    expect(primaryArtistOf(makeTrack("t", { artists: ", Featured" }))).toBe(
      ", Featured",
    );
  });
});

describe("camelotCompatibility", () => {
  it("scores the wheel table", () => {
    expect(camelotCompatibility("8A", "8A")).toBe(1);
    expect(camelotCompatibility("8A", "8B")).toBe(0.9);
    expect(camelotCompatibility("8A", "9A")).toBe(0.85);
    expect(camelotCompatibility("8A", "7A")).toBe(0.85);
    expect(camelotCompatibility("12A", "1A")).toBe(0.85);
    expect(camelotCompatibility("8A", "9B")).toBe(0.6);
    expect(camelotCompatibility("8A", "10A")).toBe(0.3);
    expect(camelotCompatibility("8A", "10B")).toBe(0.1);
    expect(camelotCompatibility("8A", "2B")).toBe(0.1);
  });

  it("accepts lowercase labels", () => {
    expect(camelotCompatibility("8a", "8b")).toBe(0.9);
  });

  it("returns null for null or unparseable labels", () => {
    expect(camelotCompatibility(null, "8A")).toBeNull();
    expect(camelotCompatibility("8A", null)).toBeNull();
    expect(camelotCompatibility("foo", "8A")).toBeNull();
    expect(camelotCompatibility("8C", "8A")).toBeNull();
    expect(camelotCompatibility("", "8A")).toBeNull();
  });
});

describe("FOR_YOU_LIMITS", () => {
  it("carries the contract values", () => {
    expect(FOR_YOU_LIMITS).toEqual({
      minMixTracks: 5,
      maxMixTracks: 20,
      maxMixes: 10,
      minRowTracks: 4,
      maxBecauseRows: 3,
      maxRowTracks: 12,
      minShelfTracks: 4,
      maxShelfTracks: 20,
      maxShelves: 6,
      minMoodTracks: 5,
      maxMoodTracks: 20,
    });
  });
});

describe("buildMixes", () => {
  it("excludes candidates with no lean-in evidence from the pool", () => {
    const ghost = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(`ghost${i + 1}`, { playlistGenres: ["amapiano"] }),
    );
    expect(buildMixes(ghost, { seedKey: "s", topArtists: [] })).toEqual([]);

    // Four lean-in tracks plus one ghost under the same label is
    // still only a pool of four — no mix.
    const mixed = [
      ...leaning("lean", 4, { playlistGenres: ["amapiano"] }),
      makeCandidate("ghost", { playlistGenres: ["amapiano"] }),
    ];
    expect(buildMixes(mixed, { seedKey: "s", topArtists: [] })).toEqual([]);
  });

  it("admits each lean-in signal on its own: taste, repeat plays, like", () => {
    const candidates = [
      makeCandidate("by-taste", { tasteScore: 0.5, playlistGenres: ["g"] }),
      makeCandidate("by-plays", { plays: 2, playlistGenres: ["g"] }),
      makeCandidate("by-like", { liked: true, playlistGenres: ["g"] }),
      ...leaning("filler", 2, { playlistGenres: ["g"] }),
    ];
    const mixes = buildMixes(candidates, { seedKey: "s", topArtists: [] });
    expect(mixes).toHaveLength(1);
    expect(new Set(ids(mixes[0].tracks))).toEqual(
      new Set(["by-taste", "by-plays", "by-like", "filler1", "filler2"]),
    );
  });

  it("needs five pool tracks for a genre mix, not four", () => {
    const four = leaning("a", 4, { playlistGenres: ["amapiano"] });
    expect(buildMixes(four, { seedKey: "s", topArtists: [] })).toEqual([]);
    const five = leaning("a", 5, { playlistGenres: ["amapiano"] });
    const mixes = buildMixes(five, { seedKey: "s", topArtists: [] });
    expect(mixes).toHaveLength(1);
    expect(mixes[0].id).toBe("mix:playlistGenre:amapiano");
    expect(mixes[0].basis).toEqual({
      kind: "playlistGenre",
      label: "amapiano",
    });
    expect(mixes[0].tracks).toHaveLength(5);
  });

  it("groups labels case-insensitively and keeps first-seen casing", () => {
    const candidates = [
      makeCandidate("c1", { tasteScore: 5, playlistGenres: ["Amapiano"] }),
      makeCandidate("c2", { tasteScore: 4, playlistGenres: ["AMAPIANO"] }),
      makeCandidate("c3", { tasteScore: 3, playlistGenres: [" amapiano "] }),
      makeCandidate("c4", { tasteScore: 2, playlistGenres: ["aMapiano"] }),
      makeCandidate("c5", { tasteScore: 1, playlistGenres: ["amapiano"] }),
    ];
    const mixes = buildMixes(candidates, { seedKey: "s", topArtists: [] });
    expect(mixes).toHaveLength(1);
    expect(mixes[0].basis).toEqual({
      kind: "playlistGenre",
      label: "Amapiano",
    });
  });

  it("rotates a mix deterministically by the seed key", () => {
    const candidates = leaning("r", 6, { playlistGenres: ["amapiano"] });
    const rankedOrder = ["r1", "r2", "r3", "r4", "r5", "r6"];

    const first = buildMixes(candidates, { seedKey: "seed-a", topArtists: [] });
    const again = buildMixes(candidates, { seedKey: "seed-a", topArtists: [] });
    expect(ids(first[0].tracks)).toEqual(ids(again[0].tracks));
    // The order is exactly the ranked order rotated by the seeded hash.
    expect(ids(first[0].tracks)).toEqual(
      rotateDeterministic(
        rankedOrder,
        hashSeedKey("seed-a:genre:amapiano") % rankedOrder.length,
      ),
    );

    const other = buildMixes(candidates, { seedKey: "seed-b", topArtists: [] });
    // Membership is identical; only the rotation differs.
    expect(new Set(ids(other[0].tracks))).toEqual(new Set(rankedOrder));
    expect(ids(other[0].tracks)).not.toEqual(ids(first[0].tracks));
  });

  it("builds artist-family mixes in topArtists order", () => {
    const candidates = [
      ...leaning("b", 5).map((c) => ({
        ...c,
        track: makeTrack(c.track.id, { artists: "Artist B" }),
      })),
      ...leaning("a", 5).map((c) => ({
        ...c,
        track: makeTrack(c.track.id, { artists: "Artist A" }),
      })),
    ];
    const mixes = buildMixes(candidates, {
      seedKey: "s",
      topArtists: ["Artist B", "Artist A"],
    });
    expect(mixes.map((mix) => mix.id)).toEqual([
      "mix:artistFamily:artist b",
      "mix:artistFamily:artist a",
    ]);
    expect(mixes[0].basis).toEqual({
      kind: "artistFamily",
      label: "Artist B",
    });
  });

  it("forms an artist-family mix a seed and a label-sharing artist fill together but neither fills alone", () => {
    // Seed: 3 tracks filed "famtag". Sharer: only 1 of its 3 tracks
    // is filed "famtag" (the other two carry "other") — that one
    // shared filing brings ALL of Sharer's tracks into the family.
    // No single genre group reaches five, so no genre mix eats it.
    const seed = Array.from({ length: 3 }, (_, i) =>
      makeCandidate(`seed${i + 1}`, {
        tasteScore: 10 - i,
        track: makeTrack(`seed${i + 1}`, { artists: "Seed Artist" }),
        playlistGenres: ["famtag"],
      }),
    );
    const sharer = Array.from({ length: 3 }, (_, i) =>
      makeCandidate(`sharer${i + 1}`, {
        tasteScore: 7 - i,
        track: makeTrack(`sharer${i + 1}`, { artists: "Sharer Artist" }),
        playlistGenres: i === 0 ? ["FamTag"] : ["other"],
      }),
    );
    // A non-sharing artist with its own filing is excluded.
    const outsider = Array.from({ length: 3 }, (_, i) =>
      makeCandidate(`outsider${i + 1}`, {
        tasteScore: 4 - i,
        track: makeTrack(`outsider${i + 1}`, { artists: "Outsider" }),
        playlistGenres: ["unrelated"],
      }),
    );
    const mixes = buildMixes([...seed, ...sharer, ...outsider], {
      seedKey: "s",
      topArtists: ["Seed Artist"],
    });
    expect(mixes).toHaveLength(1);
    expect(mixes[0].id).toBe("mix:artistFamily:seed artist");
    expect(mixes[0].basis).toEqual({
      kind: "artistFamily",
      label: "Seed Artist",
    });
    // Membership: every track belongs to the family artists only.
    expect(new Set(ids(mixes[0].tracks))).toEqual(
      new Set(["seed1", "seed2", "seed3", "sharer1", "sharer2", "sharer3"]),
    );
    for (const track of mixes[0].tracks) {
      expect(["Seed Artist", "Sharer Artist"]).toContain(
        primaryArtistOf(track),
      );
    }
  });

  it("anchors no artist-family mix on a seed artist absent from the pool", () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeCandidate(`p${i + 1}`, {
        tasteScore: 6 - i,
        track: makeTrack(`p${i + 1}`, { artists: "Present Artist" }),
        playlistGenres: [`label${i + 1}`],
      }),
    );
    const mixes = buildMixes(candidates, {
      seedKey: "s",
      topArtists: ["Ghost Artist"],
    });
    expect(mixes.filter((mix) => mix.basis.kind === "artistFamily")).toEqual(
      [],
    );
    expect(mixes).toEqual([]);
  });

  it("treats the energy band edges as inclusive", () => {
    const high = [
      ...leaning("h", 4, { facts: makeFacts({ meanEnergy: 0.9 }) }),
      makeCandidate("h-edge", {
        tasteScore: 1,
        facts: makeFacts({ meanEnergy: 0.66 }),
      }),
      makeCandidate("h-below", {
        tasteScore: 9,
        facts: makeFacts({ meanEnergy: 0.65 }),
      }),
    ];
    const low = [
      ...leaning("l", 4, { facts: makeFacts({ meanEnergy: 0.1 }) }),
      makeCandidate("l-edge", {
        tasteScore: 1,
        facts: makeFacts({ meanEnergy: 0.4 }),
      }),
      makeCandidate("l-above", {
        tasteScore: 9,
        facts: makeFacts({ meanEnergy: 0.41 }),
      }),
    ];
    const mixes = buildMixes([...high, ...low], {
      seedKey: "s",
      topArtists: [],
    });
    const byId = new Map(mixes.map((mix) => [mix.id, mix]));
    expect(byId.get("mix:derivedEnergy:high")).toBeDefined();
    expect(ids(byId.get("mix:derivedEnergy:high")!.tracks)).toContain("h-edge");
    expect(ids(byId.get("mix:derivedEnergy:high")!.tracks)).not.toContain(
      "h-below",
    );
    expect(byId.get("mix:derivedEnergy:low")).toBeDefined();
    expect(ids(byId.get("mix:derivedEnergy:low")!.tracks)).toContain("l-edge");
    expect(ids(byId.get("mix:derivedEnergy:low")!.tracks)).not.toContain(
      "l-above",
    );
  });

  it("skips a mix whose track set duplicates or nests inside an earlier mix", () => {
    // Same five tracks under a genre label and by their artist:
    // the genre mix lands first, the identical artist mix is dropped.
    const identical = leaning("d", 5, { playlistGenres: ["soul"] });
    const identicalMixes = buildMixes(identical, {
      seedKey: "s",
      topArtists: ["Artist A"],
    });
    expect(identicalMixes).toHaveLength(1);
    expect(identicalMixes[0].basis.kind).toBe("playlistGenre");

    // A strict subset of an earlier kept mix is dropped too: the
    // genre mix holds all six tracks, the artist mix only five.
    const superset = leaning("s", 6, { playlistGenres: ["soul"] }).map(
      (candidate, index) =>
        index === 5
          ? {
              ...candidate,
              track: makeTrack(candidate.track.id, { artists: "Artist B" }),
            }
          : candidate,
    );
    const subsetMixes = buildMixes(superset, {
      seedKey: "s",
      topArtists: ["Artist A"],
    });
    expect(subsetMixes).toHaveLength(1);
  });

  it("caps the number of mixes at maxMixes, biggest groups first", () => {
    const labels = [
      "g01",
      "g02",
      "g03",
      "g04",
      "g05",
      "g06",
      "g07",
      "g08",
      "g09",
      "g10",
      "g11",
    ];
    const candidates = labels.flatMap((label) =>
      leaning(`${label}-t`, 5, { playlistGenres: [label] }),
    );
    const mixes = buildMixes(candidates, { seedKey: "s", topArtists: [] });
    expect(mixes).toHaveLength(FOR_YOU_LIMITS.maxMixes);
    expect(FOR_YOU_LIMITS.maxMixes).toBe(10);
    // Equal sizes → key ascending decides which groups survive.
    expect(mixes.map((mix) => mix.id)).toEqual(
      labels.slice(0, 10).map((label) => `mix:playlistGenre:${label}`),
    );
  });

  it("caps a mix at maxMixTracks after rotation", () => {
    const candidates = leaning("big", 25, { playlistGenres: ["huge"] });
    const mixes = buildMixes(candidates, { seedKey: "s", topArtists: [] });
    expect(mixes[0].tracks).toHaveLength(FOR_YOU_LIMITS.maxMixTracks);
  });

  it("returns [] for empty input", () => {
    expect(buildMixes([], { seedKey: "s", topArtists: [] })).toEqual([]);
  });

  it("groups era mixes by decade from releaseDate", () => {
    const dates = [
      "2015-06-01",
      "2015",
      "2019-03-01",
      "2010-01-01T00:00:00Z",
      "2015-12-31",
    ];
    const candidates = dates.map((releaseDate, i) =>
      makeCandidate(`era${i + 1}`, {
        tasteScore: 5 - i,
        track: makeTrack(`era${i + 1}`, { releaseDate }),
      }),
    );
    const mixes = buildMixes(candidates, { seedKey: "s", topArtists: [] });
    expect(mixes).toHaveLength(1);
    expect(mixes[0].id).toBe("mix:era:2010s");
    expect(mixes[0].basis).toEqual({ kind: "era", label: "2010s" });
    expect(new Set(ids(mixes[0].tracks))).toEqual(
      new Set(["era1", "era2", "era3", "era4", "era5"]),
    );
    // Membership: every track's releaseDate really is in the 2010s.
    for (const track of mixes[0].tracks) {
      const year = Number.parseInt(track.releaseDate!.slice(0, 4), 10);
      expect(year).toBeGreaterThanOrEqual(2010);
      expect(year).toBeLessThanOrEqual(2019);
    }
  });

  it("excludes invalid or missing releaseDates from era mixes and respects year bounds", () => {
    const invalid = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate(`missing${i + 1}`, { tasteScore: 5 - i }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate(`bad${i + 1}`, {
          tasteScore: 5 - i,
          track: makeTrack(`bad${i + 1}`, { releaseDate: "abcd-01-01" }),
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate(`early${i + 1}`, {
          tasteScore: 5 - i,
          track: makeTrack(`early${i + 1}`, { releaseDate: "1899-01-01" }),
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate(`late${i + 1}`, {
          tasteScore: 5 - i,
          track: makeTrack(`late${i + 1}`, { releaseDate: "2030-01-01" }),
        }),
      ),
    ];
    expect(buildMixes(invalid, { seedKey: "s", topArtists: [] })).toEqual([]);

    const bounds = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate(`y1900-${i + 1}`, {
          tasteScore: 5 - i,
          track: makeTrack(`y1900-${i + 1}`, { releaseDate: "1900-06-01" }),
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeCandidate(`y2029-${i + 1}`, {
          tasteScore: 5 - i,
          track: makeTrack(`y2029-${i + 1}`, { releaseDate: "2029-06-01" }),
        }),
      ),
    ];
    const mixes = buildMixes(bounds, { seedKey: "s", topArtists: [] });
    // Equal sizes → label asc.
    expect(mixes.map((mix) => mix.id)).toEqual([
      "mix:era:1900s",
      "mix:era:2020s",
    ]);
  });

  it("applies tempo bands with inclusive edges: 100 slow, 122 driving, 110 neither", () => {
    const slow = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeCandidate(`slow${i + 1}`, {
          tasteScore: 5 - i,
          facts: makeFacts({ bpm: 90 }),
        }),
      ),
      makeCandidate("slow-edge", {
        tasteScore: 1,
        facts: makeFacts({ bpm: 100 }),
      }),
    ];
    const driving = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeCandidate(`drive${i + 1}`, {
          tasteScore: 5 - i,
          facts: makeFacts({ bpm: 140 }),
        }),
      ),
      makeCandidate("drive-edge", {
        tasteScore: 1,
        facts: makeFacts({ bpm: 122 }),
      }),
    ];
    const mid = makeCandidate("mid", {
      tasteScore: 99,
      facts: makeFacts({ bpm: 110 }),
    });
    const mixes = buildMixes([...slow, ...driving, mid], {
      seedKey: "s",
      topArtists: [],
    });
    expect(mixes.map((mix) => mix.id)).toEqual([
      "mix:derivedTempo:slow",
      "mix:derivedTempo:driving",
    ]);
    expect(ids(mixes[0].tracks)).toContain("slow-edge");
    expect(ids(mixes[1].tracks)).toContain("drive-edge");
    for (const mix of mixes) {
      expect(ids(mix.tracks)).not.toContain("mid");
    }
    expect(mixes[0].basis).toEqual({ kind: "derivedTempo", label: "slow" });
    expect(mixes[1].basis).toEqual({
      kind: "derivedTempo",
      label: "driving",
    });
  });

  it("orders a cluster by weighted taste: a high-taste member outranks a low-taste member", () => {
    // Low-taste track carries far more plays; taste still leads
    // inside the cluster under the weighted score.
    const candidates = [
      makeCandidate("high", {
        tasteScore: 10,
        plays: 0,
        playlistGenres: ["g"],
      }),
      makeCandidate("mid1", {
        tasteScore: 8,
        plays: 1,
        playlistGenres: ["g"],
      }),
      makeCandidate("mid2", {
        tasteScore: 6,
        plays: 1,
        playlistGenres: ["g"],
      }),
      makeCandidate("mid3", {
        tasteScore: 4,
        plays: 1,
        playlistGenres: ["g"],
      }),
      makeCandidate("low", {
        tasteScore: 1,
        plays: 99,
        playlistGenres: ["g"],
      }),
    ];
    const mixes = buildMixes(candidates, { seedKey: "s", topArtists: [] });
    expect(mixes).toHaveLength(1);
    const expectedOrder = ["high", "mid1", "mid2", "mid3", "low"];
    expect(ids(mixes[0].tracks)).toEqual(
      rotateDeterministic(
        expectedOrder,
        hashSeedKey("s:genre:g") % expectedOrder.length,
      ),
    );
    // Membership: every track is filed under the genre.
    const byIdMap = new Map(candidates.map((c) => [c.track.id, c]));
    for (const track of mixes[0].tracks) {
      expect(byIdMap.get(track.id)!.playlistGenres).toContain("g");
    }
  });

  it("lets cluster fit break toward the band centre for derivedEnergy when taste is equal", () => {
    const energies: [string, number][] = [
      ["e67", 0.67],
      ["e99", 0.99],
      ["e80", 0.8],
      ["e70", 0.7],
      ["e90", 0.9],
    ];
    const candidates = energies.map(([id, meanEnergy], i) =>
      makeCandidate(id, {
        tasteScore: 5,
        // Plays run against fit order, so only fit can produce it.
        plays: 5 - i,
        facts: makeFacts({ meanEnergy }),
      }),
    );
    const mixes = buildMixes(candidates, { seedKey: "s", topArtists: [] });
    expect(mixes).toHaveLength(1);
    expect(mixes[0].id).toBe("mix:derivedEnergy:high");
    const expectedOrder = ["e99", "e90", "e80", "e70", "e67"];
    expect(ids(mixes[0].tracks)).toEqual(
      rotateDeterministic(
        expectedOrder,
        hashSeedKey("s:energy:high") % expectedOrder.length,
      ),
    );
  });

  it("yields more than four and at most ten mixes from a rich fixture (6 genres + family + era + 2 energy + 2 tempo)", () => {
    const genreBlocks = ["g1", "g2", "g3", "g4", "g5", "g6"].flatMap((label) =>
      leaning(`${label}-t`, 5, { playlistGenres: [label] }),
    );
    const familySeed = Array.from({ length: 3 }, (_, i) =>
      makeCandidate(`fam-seed${i + 1}`, {
        tasteScore: 3,
        track: makeTrack(`fam-seed${i + 1}`, { artists: "Family Seed" }),
        playlistGenres: ["famtag"],
      }),
    );
    const familySharer = Array.from({ length: 3 }, (_, i) =>
      makeCandidate(`fam-sharer${i + 1}`, {
        tasteScore: 3,
        track: makeTrack(`fam-sharer${i + 1}`, {
          artists: "Family Sharer",
        }),
        playlistGenres: i === 0 ? ["famtag"] : ["famother"],
      }),
    );
    const eraBlock = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(`era-t${i + 1}`, {
        tasteScore: 3,
        track: makeTrack(`era-t${i + 1}`, {
          artists: "Era Artist",
          releaseDate: "2015-06-01",
        }),
      }),
    );
    const highBlock = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(`high-t${i + 1}`, {
        tasteScore: 3,
        track: makeTrack(`high-t${i + 1}`, { artists: "High Artist" }),
        facts: makeFacts({ meanEnergy: 0.9 }),
      }),
    );
    const lowBlock = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(`low-t${i + 1}`, {
        tasteScore: 3,
        track: makeTrack(`low-t${i + 1}`, { artists: "Low Artist" }),
        facts: makeFacts({ meanEnergy: 0.1 }),
      }),
    );
    const slowBlock = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(`slow-t${i + 1}`, {
        tasteScore: 3,
        track: makeTrack(`slow-t${i + 1}`, { artists: "Slow Artist" }),
        facts: makeFacts({ bpm: 90 }),
      }),
    );
    const drivingBlock = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(`driving-t${i + 1}`, {
        tasteScore: 3,
        track: makeTrack(`driving-t${i + 1}`, { artists: "Driving Artist" }),
        facts: makeFacts({ bpm: 140 }),
      }),
    );
    const mixes = buildMixes(
      [
        ...genreBlocks,
        ...familySeed,
        ...familySharer,
        ...eraBlock,
        ...highBlock,
        ...lowBlock,
        ...slowBlock,
        ...drivingBlock,
      ],
      { seedKey: "s", topArtists: ["Family Seed"] },
    );
    expect(mixes.length).toBeGreaterThan(4);
    expect(mixes.length).toBeLessThanOrEqual(10);
    expect(mixes.length).toBe(FOR_YOU_LIMITS.maxMixes);
  });
});

describe("buildBecauseRows", () => {
  const seedFacts = makeFacts({ bpm: 100, meanEnergy: 0.5, camelot: "8A" });

  it("excludes the seed from its own row", () => {
    const candidates = [
      makeCandidate("seed", {
        plays: 3,
        tasteScore: 10,
        playlistGenres: ["x"],
        facts: seedFacts,
      }),
      ...leaning("f", 4, { playlistGenres: ["x"] }),
    ];
    const rows = buildBecauseRows(candidates, { topArtists: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0].seed).toEqual({
      kind: "track",
      track: candidates[0].track,
    });
    expect(ids(rows[0].tracks)).not.toContain("seed");
    expect(rows[0].tracks).toHaveLength(4);
  });

  it("drops a row that cannot fill to minRowTracks", () => {
    const candidates = [
      makeCandidate("seed", { plays: 3, tasteScore: 10, facts: seedFacts }),
      // Only three compatible fillers (same artist as the seed).
      ...leaning("f", 3),
      // Incompatible: no shared label, different artist, no facts.
      makeCandidate("stranger", {
        track: makeTrack("stranger", { artists: "Other Artist" }),
      }),
    ];
    expect(buildBecauseRows(candidates, { topArtists: [] })).toEqual([]);
  });

  it("ranks shared-label fill above analysis-only fill", () => {
    const candidates = [
      makeCandidate("seed", {
        plays: 3,
        tasteScore: 10,
        playlistGenres: ["x"],
        facts: seedFacts,
      }),
      // Analysis twin of the seed, but no filing in common — and a
      // far stronger taste score. The filing still wins the row.
      makeCandidate("analysis-only", {
        tasteScore: 9,
        track: makeTrack("analysis-only", { artists: "Other Artist" }),
        facts: makeFacts({ bpm: 100, meanEnergy: 0.5, camelot: "8A" }),
      }),
      makeCandidate("shared-label", {
        tasteScore: 1,
        track: makeTrack("shared-label", { artists: "Other Artist" }),
        playlistGenres: ["x"],
      }),
      ...leaning("pad", 2, { playlistGenres: ["x"] }),
    ];
    const rows = buildBecauseRows(candidates, { topArtists: [] });
    expect(rows).toHaveLength(1);
    expect(ids(rows[0].tracks)[0]).toBe("pad1");
    expect(ids(rows[0].tracks)).toContain("shared-label");
    expect(ids(rows[0].tracks).indexOf("shared-label")).toBeLessThan(
      ids(rows[0].tracks).indexOf("analysis-only"),
    );
  });

  it("builds an artist row from the artist's tracks plus label-sharers", () => {
    const candidates = [
      makeCandidate("own1", {
        track: makeTrack("own1", { artists: "Singer" }),
        playlistGenres: ["soul"],
      }),
      makeCandidate("own2", {
        track: makeTrack("own2", { artists: "Singer" }),
        playlistGenres: ["soul"],
      }),
      makeCandidate("sharer1", { playlistGenres: ["soul"] }),
      makeCandidate("sharer2", { playlistGenres: ["SOUL"] }),
      makeCandidate("unrelated", { playlistGenres: ["jazz"] }),
    ];
    const rows = buildBecauseRows(candidates, { topArtists: ["Singer"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].seed).toEqual({ kind: "artist", artist: "Singer" });
    // The artist's own tracks are in the row; the unrelated one is not.
    expect(new Set(ids(rows[0].tracks))).toEqual(
      new Set(["own1", "own2", "sharer1", "sharer2"]),
    );
  });

  it("needs at least two of the artist's own tracks for an artist row", () => {
    const candidates = [
      makeCandidate("own1", {
        track: makeTrack("own1", { artists: "Singer" }),
        playlistGenres: ["soul"],
      }),
      ...leaning("sharer", 4, { playlistGenres: ["soul"] }),
    ];
    expect(buildBecauseRows(candidates, { topArtists: ["Singer"] })).toEqual(
      [],
    );
  });

  it("returns [] for empty input", () => {
    expect(buildBecauseRows([], { topArtists: [] })).toEqual([]);
  });
});

describe("buildGenreShelves", () => {
  it("needs four tracks for a shelf", () => {
    expect(
      buildGenreShelves(leaning("a", 3, { playlistGenres: ["g"] })),
    ).toEqual([]);
    const shelves = buildGenreShelves(
      leaning("a", 4, { playlistGenres: ["g"] }),
    );
    expect(shelves).toHaveLength(1);
    expect(shelves[0]).toMatchObject({ kind: "playlistGenre", label: "g" });
    expect(shelves[0].tracks).toHaveLength(4);
  });

  it("uses all candidates, not just the mix pool", () => {
    // No taste, no plays, no likes — shelves still file them.
    const shelves = buildGenreShelves(
      Array.from({ length: 4 }, (_, i) =>
        makeCandidate(`plain${i + 1}`, { playlistGenres: ["filed"] }),
      ),
    );
    expect(shelves).toHaveLength(1);
    expect(shelves[0].label).toBe("filed");
  });

  it("puts playlist-genre shelves before basic-genre shelves", () => {
    const candidates = [
      ...leaning("p", 4, { playlistGenres: ["mine"] }),
      ...leaning("b", 8, { genres: ["theirs"] }),
    ];
    const shelves = buildGenreShelves(candidates);
    expect(shelves.map((shelf) => shelf.kind)).toEqual([
      "playlistGenre",
      "genre",
    ]);
    expect(shelves[1].label).toBe("theirs");
  });

  it("orders shelves by size desc, then key asc, and caps the total", () => {
    const candidates = ["g7", "g6", "g5", "g4", "g3", "g2", "g1"].flatMap(
      (label) => leaning(`${label}-t`, 4, { playlistGenres: [label] }),
    );
    const shelves = buildGenreShelves(candidates);
    expect(shelves).toHaveLength(FOR_YOU_LIMITS.maxShelves);
    expect(shelves.map((shelf) => shelf.label)).toEqual([
      "g1",
      "g2",
      "g3",
      "g4",
      "g5",
      "g6",
    ]);
  });

  it("caps a shelf at maxShelfTracks", () => {
    const shelves = buildGenreShelves(
      leaning("big", 25, { playlistGenres: ["huge"] }),
    );
    expect(shelves[0].tracks).toHaveLength(FOR_YOU_LIMITS.maxShelfTracks);
  });

  it("returns [] for empty input", () => {
    expect(buildGenreShelves([])).toEqual([]);
  });
});

describe("buildMoodRows", () => {
  it("orders lowEnergy by energy ascending, edges inclusive", () => {
    const energies = [0.4, 0.1, 0.3, 0.2, 0.0];
    const candidates = energies.map((energy, i) =>
      makeCandidate(`low${i + 1}`, {
        // Taste runs against energy order, to prove energy leads.
        tasteScore: i + 1,
        facts: makeFacts({ meanEnergy: energy }),
      }),
    );
    const rows = buildMoodRows(candidates);
    expect(rows.map((row) => row.kind)).toEqual(["lowEnergy"]);
    expect(ids(rows[0].tracks)).toEqual([
      "low5",
      "low2",
      "low4",
      "low3",
      "low1",
    ]);
  });

  it("applies the highEnergy threshold inclusively", () => {
    const candidates = [
      ...leaning("h", 4, { facts: makeFacts({ meanEnergy: 0.9 }) }),
      makeCandidate("edge", {
        tasteScore: 1,
        facts: makeFacts({ meanEnergy: 0.66 }),
      }),
      makeCandidate("below", {
        tasteScore: 99,
        facts: makeFacts({ meanEnergy: 0.65 }),
      }),
    ];
    const rows = buildMoodRows(candidates);
    expect(rows.map((row) => row.kind)).toEqual(["highEnergy"]);
    expect(ids(rows[0].tracks)).toContain("edge");
    expect(ids(rows[0].tracks)).not.toContain("below");
  });

  it("orders vocalLed by vocal share descending, threshold inclusive", () => {
    const shares = [0.5, 0.9, 0.45, 0.7, 0.6];
    const candidates = shares.map((share, i) =>
      makeCandidate(`v${i + 1}`, {
        tasteScore: 1,
        facts: makeFacts({ vocalShare: share }),
      }),
    );
    candidates.push(
      makeCandidate("below", {
        tasteScore: 99,
        facts: makeFacts({ vocalShare: 0.44 }),
      }),
    );
    const rows = buildMoodRows(candidates);
    expect(rows.map((row) => row.kind)).toEqual(["vocalLed"]);
    expect(ids(rows[0].tracks)).toEqual(["v2", "v4", "v5", "v1", "v3"]);
  });

  it("applies the instrumental threshold inclusively", () => {
    const candidates = [
      ...leaning("i", 4, { facts: makeFacts({ vocalShare: 0.05 }) }),
      makeCandidate("edge", {
        tasteScore: 1,
        facts: makeFacts({ vocalShare: 0.12 }),
      }),
      makeCandidate("above", {
        tasteScore: 99,
        facts: makeFacts({ vocalShare: 0.13 }),
      }),
    ];
    const rows = buildMoodRows(candidates);
    expect(rows.map((row) => row.kind)).toEqual(["instrumental"]);
    expect(ids(rows[0].tracks)).toContain("edge");
    expect(ids(rows[0].tracks)).not.toContain("above");
  });

  it("lets one track appear in rows on different axes, in fixed row order", () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(`both${i + 1}`, {
        tasteScore: 5 - i,
        facts: makeFacts({ meanEnergy: 0.2, vocalShare: 0.05 }),
      }),
    );
    const rows = buildMoodRows(candidates);
    expect(rows.map((row) => row.kind)).toEqual(["lowEnergy", "instrumental"]);
    expect(ids(rows[0].tracks)).toContain("both1");
    expect(ids(rows[1].tracks)).toContain("both1");
  });

  it("ignores candidates without facts and needs five to form a row", () => {
    const candidates = [
      ...leaning("factless", 6),
      ...leaning("low", 4, { facts: makeFacts({ meanEnergy: 0.2 }) }),
    ];
    expect(buildMoodRows(candidates)).toEqual([]);
  });

  it("caps a mood row at maxMoodTracks", () => {
    const rows = buildMoodRows(
      leaning("many", 25, { facts: makeFacts({ meanEnergy: 0.9 }) }),
    );
    expect(rows[0].tracks).toHaveLength(FOR_YOU_LIMITS.maxMoodTracks);
  });

  it("returns [] for empty input", () => {
    expect(buildMoodRows([])).toEqual([]);
  });
});

describe("forYouMixId", () => {
  it("builds the stable id for every basis kind", () => {
    expect(forYouMixId({ kind: "playlistGenre", label: "Amapiano" })).toBe(
      "mix:playlistGenre:amapiano",
    );
    expect(forYouMixId({ kind: "artistFamily", label: "Seed Artist" })).toBe(
      "mix:artistFamily:seed artist",
    );
    expect(forYouMixId({ kind: "era", label: "2010s" })).toBe("mix:era:2010s");
    expect(forYouMixId({ kind: "derivedEnergy", label: "high" })).toBe(
      "mix:derivedEnergy:high",
    );
    expect(forYouMixId({ kind: "derivedTempo", label: "driving" })).toBe(
      "mix:derivedTempo:driving",
    );
  });
});

describe("applyDailySnapshot", () => {
  const tracks = Array.from({ length: 8 }, (_, i) => makeTrack(`t${i + 1}`));
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const generated: ForYouMix[] = [
    {
      id: "mix:playlistGenre:generated",
      basis: { kind: "playlistGenre", label: "Generated" },
      tracks: tracks.slice(0, 5),
    },
  ];

  it("lets a same-day snapshot win over generated, membership and order from the snapshot", () => {
    const snapshot: DailyMixSnapshot = {
      dateKey: "2026-11-03",
      entries: [
        {
          basis: { kind: "playlistGenre", label: "Soul" },
          trackIds: ["t3", "t1", "t5", "t2", "t4"],
        },
        {
          basis: { kind: "era", label: "2010s" },
          trackIds: ["t8", "t7", "t6", "t5", "t4", "t3"],
        },
      ],
    };
    const result = applyDailySnapshot(generated, snapshot, "2026-11-03", byId);
    expect(result.regenerated).toBe(false);
    expect(result.snapshot).toBe(snapshot);
    expect(result.mixes.map((mix) => mix.id)).toEqual([
      "mix:playlistGenre:soul",
      "mix:era:2010s",
    ]);
    expect(ids(result.mixes[0].tracks)).toEqual(["t3", "t1", "t5", "t2", "t4"]);
    expect(ids(result.mixes[1].tracks)).toEqual([
      "t8",
      "t7",
      "t6",
      "t5",
      "t4",
      "t3",
    ]);
  });

  it("ignores a next-day (stale-date) snapshot and regenerates from generated", () => {
    const snapshot: DailyMixSnapshot = {
      dateKey: "2026-11-02",
      entries: [
        {
          basis: { kind: "playlistGenre", label: "Soul" },
          trackIds: ["t3", "t1", "t5", "t2", "t4"],
        },
      ],
    };
    const result = applyDailySnapshot(generated, snapshot, "2026-11-03", byId);
    expect(result.regenerated).toBe(true);
    expect(result.mixes).toBe(generated);
    expect(result.snapshot).not.toBe(snapshot);
    expect(result.snapshot).toEqual({
      dateKey: "2026-11-03",
      entries: [
        {
          basis: { kind: "playlistGenre", label: "Generated" },
          trackIds: ["t1", "t2", "t3", "t4", "t5"],
        },
      ],
    });
  });

  it("regenerates when there is no snapshot at all", () => {
    const result = applyDailySnapshot(generated, null, "2026-11-03", byId);
    expect(result.regenerated).toBe(true);
    expect(result.mixes).toBe(generated);
    expect(result.snapshot.dateKey).toBe("2026-11-03");
  });

  it("drops vanished ids while preserving the stored order of the rest", () => {
    const snapshot: DailyMixSnapshot = {
      dateKey: "2026-11-03",
      entries: [
        {
          basis: { kind: "derivedTempo", label: "slow" },
          trackIds: ["t2", "gone", "t1", "t4", "t3", "t5"],
        },
      ],
    };
    const result = applyDailySnapshot([], snapshot, "2026-11-03", byId);
    expect(result.regenerated).toBe(false);
    expect(result.mixes).toHaveLength(1);
    expect(result.mixes[0].id).toBe("mix:derivedTempo:slow");
    expect(ids(result.mixes[0].tracks)).toEqual(["t2", "t1", "t4", "t3", "t5"]);
  });

  it("drops an entry that falls below minMixTracks after resolving", () => {
    const snapshot: DailyMixSnapshot = {
      dateKey: "2026-11-03",
      entries: [
        {
          basis: { kind: "derivedEnergy", label: "high" },
          trackIds: ["t1", "gone1", "t2", "gone2", "t3"],
        },
        {
          basis: { kind: "playlistGenre", label: "Soul" },
          trackIds: ["t1", "t2", "t3", "t4", "t5"],
        },
      ],
    };
    const result = applyDailySnapshot([], snapshot, "2026-11-03", byId);
    expect(result.regenerated).toBe(false);
    expect(result.snapshot).toBe(snapshot);
    expect(result.mixes.map((mix) => mix.id)).toEqual([
      "mix:playlistGenre:soul",
    ]);
  });
});
