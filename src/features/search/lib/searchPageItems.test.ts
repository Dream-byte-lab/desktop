import { describe, it, expect } from "vitest";
import {
  mapSearchAllItems,
  partitionSearchRows,
  provenSourceLabel,
  type SearchRowItem,
} from "./searchPageItems";

describe("searchPageItems", () => {
  it("normalises the overlay's item shapes for the page's blocks", () => {
    const rows = mapSearchAllItems([
      {
        type: "artist",
        id: "art-1",
        name: "ABBA",
        cover: { url: "https://img.example/abba.jpg" },
      } as any,
      {
        type: "album",
        id: "alb-1",
        title: "Waterloo",
        artists: [
          { id: "art-1", name: "ABBA" },
          { id: "art-2", name: "Guests" },
        ],
        year: 1974,
      } as any,
    ]);
    expect(rows[0]._type).toBe("artist");
    expect(rows[0].title).toBe("ABBA");
    expect(rows[1]._type).toBe("album");
    expect(rows[1].artists).toBe("ABBA, Guests");
    expect(rows[1].artistId).toBe("art-1");
  });

  it("partitions rows into the four blocks", () => {
    const rows: SearchRowItem[] = [
      { _type: "track", id: "1", title: "T", coverUrl: "", artists: "" },
      { _type: "artist", id: "2", title: "A", coverUrl: "", artists: "" },
      { _type: "album", id: "3", title: "Al", coverUrl: "", artists: "" },
      { _type: "playlist", id: "4", title: "P", coverUrl: "", artists: "" },
      { _type: "track", id: "5", title: "T2", coverUrl: "", artists: "" },
    ];
    const blocks = partitionSearchRows(rows);
    expect(blocks.tracks.map((r) => r.id)).toEqual(["1", "5"]);
    expect(blocks.artists.map((r) => r.id)).toEqual(["2"]);
    expect(blocks.albums.map((r) => r.id)).toEqual(["3"]);
    expect(blocks.playlists.map((r) => r.id)).toEqual(["4"]);
  });

  it("provenance is claimed only where the id shape proves it", () => {
    expect(provenSourceLabel("sc:123456")).toBe("SoundCloud");
    expect(provenSourceLabel("sc_abc")).toBe("SoundCloud");
    // A non-SoundCloud id may be YouTube or server-filed — the
    // response carries no source field, so nothing is claimed.
    expect(provenSourceLabel("dQw4w9WgXcQ")).toBeUndefined();
    expect(provenSourceLabel("album-42")).toBeUndefined();
  });
});
