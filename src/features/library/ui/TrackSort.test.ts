import { describe, expect, it } from "vitest";
import { sortOptionsFor, sortTracks } from "./TrackSort";

const track = (title: string, addedAt?: string) => ({
  title,
  durationMs: 0,
  playCount: 0,
  addedAt,
});

describe("sort by date added", () => {
  it("puts the most recently added tracks first", () => {
    const tracks = [
      track("old", "2026-01-01T00:00:00Z"),
      track("newest", "2026-10-20T00:00:00Z"),
      track("middle", "2026-05-01T00:00:00Z"),
    ];
    expect(sortTracks(tracks, "added").map((t) => t.title)).toEqual([
      "newest",
      "middle",
      "old",
    ]);
  });

  it("keeps tracks without a date at the end in their original order", () => {
    const tracks = [
      track("a"),
      track("dated", "2026-03-01T00:00:00Z"),
      track("b"),
    ];
    expect(sortTracks(tracks, "added").map((t) => t.title)).toEqual([
      "dated",
      "a",
      "b",
    ]);
  });

  it("only offers the option when the list has dates", () => {
    expect(sortOptionsFor([track("album track")])).not.toContain("added");
    expect(
      sortOptionsFor([track("playlist track", "2026-03-01T00:00:00Z")]),
    ).toContain("added");
  });
});

const detailedTrack = (
  title: string,
  extra: {
    addedAt?: string;
    artists?: string | { name: string }[];
    artistList?: { name: string }[];
    album?: { id: string; title: string };
  } = {},
) => ({
  title,
  durationMs: 0,
  playCount: 0,
  addedAt: extra.addedAt,
  artists: extra.artists,
  artistList: extra.artistList,
  album: extra.album,
});

describe("sort by artist", () => {
  it("orders tracks by their artist string, case-insensitively", () => {
    const tracks = [
      detailedTrack("c-song", { artists: "Charlie Puth" }),
      detailedTrack("a-song", { artists: "adele" }),
      detailedTrack("b-song", { artists: "Bob Dylan" }),
    ];
    expect(sortTracks(tracks, "artist").map((t) => t.title)).toEqual([
      "a-song",
      "b-song",
      "c-song",
    ]);
  });

  it("uses the joined names as the key for multi-artist (array) tracks", () => {
    // Derivation: artist key is the ", "-joined artist names, so a
    // multi-artist track sorts under its full credit, first artist first.
    const tracks = [
      detailedTrack("solo", { artists: [{ name: "Zed" }] }),
      detailedTrack("duet", {
        artists: [{ name: "Amy" }, { name: "Zed" }],
      }),
      detailedTrack("other", { artists: [{ name: "Bob" }] }),
    ];
    expect(sortTracks(tracks, "artist").map((t) => t.title)).toEqual([
      "duet",
      "other",
      "solo",
    ]);
  });

  it("falls back to artistList when the display string is empty", () => {
    const tracks = [
      detailedTrack("listed", {
        artists: "",
        artistList: [{ name: "List Artist" }],
      }),
      detailedTrack("plain", { artists: "A Artist" }),
    ];
    expect(sortTracks(tracks, "artist").map((t) => t.title)).toEqual([
      "plain",
      "listed",
    ]);
  });

  it("keeps the original order for tracks sharing an artist", () => {
    const tracks = [
      detailedTrack("first", { artists: "Same Artist" }),
      detailedTrack("second", { artists: "same artist" }),
      detailedTrack("third", { artists: "Another Artist" }),
    ];
    expect(sortTracks(tracks, "artist").map((t) => t.title)).toEqual([
      "third",
      "first",
      "second",
    ]);
  });

  it("puts tracks without artist data last, in their original order", () => {
    const tracks = [
      detailedTrack("no-artist-1"),
      detailedTrack("zed", { artists: "Zed" }),
      detailedTrack("no-artist-2", { artists: "  " }),
      detailedTrack("amy", { artists: "Amy" }),
    ];
    expect(sortTracks(tracks, "artist").map((t) => t.title)).toEqual([
      "amy",
      "zed",
      "no-artist-1",
      "no-artist-2",
    ]);
  });

  it("only offers the option when a track carries artist data", () => {
    expect(sortOptionsFor([detailedTrack("bare")])).not.toContain("artist");
    expect(
      sortOptionsFor([detailedTrack("blank", { artists: "" })]),
    ).not.toContain("artist");
    expect(
      sortOptionsFor([detailedTrack("named", { artists: "Amy" })]),
    ).toContain("artist");
    expect(
      sortOptionsFor([
        detailedTrack("listed", { artistList: [{ name: "Amy" }] }),
      ]),
    ).toContain("artist");
    expect(
      sortOptionsFor([detailedTrack("array", { artists: [{ name: "Amy" }] })]),
    ).toContain("artist");
  });
});

describe("sort by album", () => {
  it("orders tracks by album title", () => {
    const tracks = [
      detailedTrack("zoo-song", { album: { id: "a1", title: "Zoo" } }),
      detailedTrack("abbey-song", {
        album: { id: "a2", title: "Abbey Road" },
      }),
      detailedTrack("midnight-song", {
        album: { id: "a3", title: "Midnight" },
      }),
    ];
    expect(sortTracks(tracks, "album").map((t) => t.title)).toEqual([
      "abbey-song",
      "midnight-song",
      "zoo-song",
    ]);
  });

  it("puts tracks without an album last, in their original order", () => {
    const tracks = [
      detailedTrack("no-album-1"),
      detailedTrack("zoo", { album: { id: "a1", title: "Zoo" } }),
      detailedTrack("no-album-2", { album: { id: "a2", title: " " } }),
      detailedTrack("abbey", { album: { id: "a3", title: "Abbey Road" } }),
    ];
    expect(sortTracks(tracks, "album").map((t) => t.title)).toEqual([
      "abbey",
      "zoo",
      "no-album-1",
      "no-album-2",
    ]);
  });

  it("only offers the option when a track carries album data", () => {
    expect(sortOptionsFor([detailedTrack("bare")])).not.toContain("album");
    expect(
      sortOptionsFor([
        detailedTrack("blank", { album: { id: "a1", title: "" } }),
      ]),
    ).not.toContain("album");
    expect(
      sortOptionsFor([
        detailedTrack("named", { album: { id: "a1", title: "Zoo" } }),
      ]),
    ).toContain("album");
  });
});

describe("sort options with full data", () => {
  it("offers artist and album after title, keeping the existing order", () => {
    const tracks = [
      detailedTrack("full", {
        addedAt: "2026-03-01T00:00:00Z",
        artists: "Amy",
        album: { id: "a1", title: "Zoo" },
      }),
    ];
    expect(sortOptionsFor(tracks)).toEqual([
      "default",
      "added",
      "title",
      "artist",
      "album",
      "duration",
      "popularity",
    ]);
  });

  it("offers neither artist nor album for bare track lists", () => {
    expect(sortOptionsFor([track("album track")])).toEqual([
      "default",
      "title",
      "duration",
      "popularity",
    ]);
  });
});
