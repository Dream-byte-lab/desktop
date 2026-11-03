import { describe, expect, it, vi } from "vitest";

const fakeApi = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock("@/shared/api", () => ({
  api: { search: fakeApi.search },
  toClientTrack: (item: { id: string; title: string; artist: string }) => ({
    id: item.id,
    title: item.title,
    artists: item.artist,
    coverUrl: "",
    durationMs: 0,
    playCount: 0,
  }),
}));

import {
  PROGRAMME_SEARCH_LIMIT,
  searchListings,
  searchProgrammeTracks,
} from "./partyProgrammeSearch";

function trackItem(id: string, title = `Song ${id}`) {
  return { type: "track", id, title, artist: `Artist ${id}` };
}

describe("searchProgrammeTracks", () => {
  it("keeps only tracks, deduped by exact track id", async () => {
    fakeApi.search.mockResolvedValue({
      items: [
        trackItem("a"),
        { type: "album", id: "album-1", title: "An Album" },
        trackItem("a", "Same id, other pressing"),
        // Same title and artist under a DIFFERENT id is a different
        // result: dedup is by exact id only, never by look-alike.
        trackItem("b", "Song a"),
      ],
    });
    const tracks = await searchProgrammeTracks("song");
    expect(tracks.map((track) => track.id)).toEqual(["a", "b"]);
  });

  it("caps one search at the programme limit", async () => {
    fakeApi.search.mockResolvedValue({
      items: Array.from({ length: PROGRAMME_SEARCH_LIMIT + 10 }, (_, i) =>
        trackItem(`t${i}`),
      ),
    });
    const tracks = await searchProgrammeTracks("song");
    expect(tracks).toHaveLength(PROGRAMME_SEARCH_LIMIT);
  });
});

describe("searchListings", () => {
  it("stamps every listing with its programme-search provenance", () => {
    const listings = searchListings([
      {
        id: "a",
        title: "Song a",
        artists: "Artist a",
        coverUrl: "",
        durationMs: 0,
        playCount: 0,
      },
    ]);
    expect(listings).toEqual([
      { id: "a", title: "Song a", artist: "Artist a", source: "search" },
    ]);
  });
});
