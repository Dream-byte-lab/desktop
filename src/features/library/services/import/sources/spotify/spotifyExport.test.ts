import { describe, expect, it } from "vitest";
import { parseExportFile } from "./spotifyExport";

const spotifyData = JSON.stringify({
  playlists: [
    {
      name: "Chill Evenings",
      description: "wind down",
      items: [
        {
          track: {
            trackName: "Song One",
            artistName: "Artist A",
            albumName: "Album A",
            trackUri: "spotify:track:abc123",
          },
          episode: null,
          localTrack: null,
        },
        {
          track: null,
          episode: { episodeName: "A Podcast", showName: "Show" },
          localTrack: null,
        },
        {
          track: null,
          episode: null,
          localTrack: {
            trackName: "My Demo",
            artistName: "Me",
            albumName: "",
          },
        },
      ],
    },
    { name: "Empty One", items: [] },
    {
      name: "Second",
      items: [
        {
          track: {
            trackName: "Song Two",
            artistName: "Artist B",
            albumName: "Album B",
            trackUri: "spotify:track:def456",
          },
        },
      ],
    },
  ],
});

describe("parseExportFile — Spotify data JSON", () => {
  it("reads every non-empty playlist, keeping order and Playlist Genre names", () => {
    const parsed = parseExportFile("Playlist1.json", spotifyData);
    expect(parsed.kind).toBe("spotify-json");
    expect(parsed.playlists.map((p) => p.title)).toEqual([
      "Chill Evenings",
      "Second",
    ]);
    const first = parsed.playlists[0];
    expect(first.description).toBe("wind down");
    // The episode is skipped; the local track is kept by name.
    expect(first.tracks.map((t) => t.title)).toEqual(["Song One", "My Demo"]);
    expect(first.tracks[0]).toMatchObject({
      sourceId: "abc123",
      artists: ["Artist A"],
      album: "Album A",
    });
    expect(first.tracks[1].sourceId).toBe("local:my demo|me");
  });

  it("explains itself when the file holds no playlists", () => {
    expect(() => parseExportFile("Userdata.json", "{}")).toThrow(
      /No playlists were found/,
    );
    expect(() => parseExportFile("broken.json", "{not json")).toThrow(
      /could not be read as JSON/,
    );
  });
});

describe("parseExportFile — CSV exports", () => {
  it("maps Exportify-style columns, quoted commas and all", () => {
    const csv = [
      '"Track URI","Track Name","Artist Name(s)","Album Name","Track Duration (ms)"',
      '"spotify:track:xyz789","Song, With Comma","Artist C","Album C","213000"',
      '"spotify:track:xyz790","Plain Song","Artist D","Album D","180000"',
    ].join("\r\n");
    const parsed = parseExportFile("road-trip.csv", csv);
    expect(parsed.kind).toBe("csv");
    expect(parsed.playlists).toHaveLength(1);
    expect(parsed.playlists[0].title).toBe("road-trip");
    expect(parsed.playlists[0].tracks[0]).toMatchObject({
      sourceId: "xyz789",
      title: "Song, With Comma",
      artists: ["Artist C"],
      durationMs: 213000,
    });
    expect(parsed.playlists[0].tracks).toHaveLength(2);
  });

  it("refuses a CSV with no track column", () => {
    expect(() => parseExportFile("x.csv", "foo,bar\n1,2")).toThrow(
      /No songs were found/,
    );
  });
});
