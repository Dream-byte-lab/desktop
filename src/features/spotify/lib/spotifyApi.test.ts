import { describe, expect, it } from "vitest";
import { SpotifyApi, SpotifyApiError } from "./spotifyApi";
import { toImportedPlaylist } from "./toImportedPlaylist";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scriptedFetch(pages: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = pages[url];
    if (body === undefined) return jsonResponse({ error: "nope" }, 404);
    return jsonResponse(body);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const api = (fetchFn: typeof fetch) =>
  new SpotifyApi({ getAccessToken: async () => "token-1", fetchFn });

describe("SpotifyApi", () => {
  it("walks every page of the user's playlists", async () => {
    const page1 = "https://api.spotify.com/v1/me/playlists?limit=50";
    const page2 = "https://api.spotify.com/v1/me/playlists?offset=50&limit=50";
    const { fetchFn, calls } = scriptedFetch({
      [page1]: {
        items: [
          {
            id: "p1",
            name: "Gym",
            description: null,
            owner: { display_name: "dreambyte" },
            tracks: { total: 12 },
            collaborative: false,
            public: false,
            images: [{ url: "https://img/p1" }],
          },
        ],
        next: page2,
      },
      [page2]: {
        items: [
          {
            id: "p2",
            name: "Shared vibes",
            description: "ours",
            owner: { display_name: "friend" },
            tracks: { total: 3 },
            collaborative: true,
            public: true,
            images: [],
          },
        ],
        next: null,
      },
    });
    const playlists = await api(fetchFn).listPlaylists();
    expect(calls).toEqual([page1, page2]);
    expect(playlists.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(playlists[0]).toMatchObject({
      name: "Gym",
      isPublic: false,
      trackTotal: 12,
      imageUrl: "https://img/p1",
    });
    expect(playlists[1].collaborative).toBe(true);
  });

  it("maps tracks and honestly counts what cannot come across", async () => {
    const url = "https://api.spotify.com/v1/playlists/p1/tracks?limit=100";
    const song = (id: string) => ({
      id,
      name: `Song ${id}`,
      type: "track",
      is_local: false,
      duration_ms: 200000,
      artists: [{ name: "Artist" }],
      album: { name: "Album", images: [{ url: "https://img/a" }] },
    });
    const { fetchFn } = scriptedFetch({
      [url]: {
        items: [
          { track: song("t1") },
          { track: { ...song("e1"), type: "episode" } },
          { track: { ...song("l1"), is_local: true } },
          { track: null },
          { track: song("t2") },
        ],
        next: null,
      },
    });
    const result = await api(fetchFn).playlistTracks("p1");
    expect(result.tracks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(result.skippedEpisodes).toBe(1);
    expect(result.skippedLocal).toBe(1);
    expect(result.skippedUnavailable).toBe(1);
  });

  it("surfaces API failures as typed errors with the status", async () => {
    const { fetchFn } = scriptedFetch({});
    await expect(api(fetchFn).me()).rejects.toBeInstanceOf(SpotifyApiError);
    await expect(api(fetchFn).me()).rejects.toMatchObject({ status: 404 });
  });
});

describe("toImportedPlaylist", () => {
  it("produces the import pipeline's contract, order preserved", () => {
    const playlist = toImportedPlaylist(
      {
        id: "p1",
        name: "Gym",
        description: "",
        ownerName: "dreambyte",
        trackTotal: 2,
        collaborative: false,
        isPublic: false,
      },
      {
        tracks: [
          {
            id: "t2",
            title: "Second",
            artists: ["B", "C"],
            album: "Alb",
            durationMs: 180000,
          },
          {
            id: "t1",
            title: "First",
            artists: ["A"],
            album: "Alb",
            durationMs: 190000,
            coverUrl: "https://img/1",
          },
        ],
        skippedEpisodes: 0,
        skippedLocal: 0,
        skippedUnavailable: 0,
      },
    );
    expect(playlist.source).toBe("spotify");
    expect(playlist.sourceUrl).toBe("https://open.spotify.com/playlist/p1");
    expect(playlist.tracks.map((t) => t.sourceId)).toEqual(["t2", "t1"]);
    expect(playlist.tracks[0]).toMatchObject({
      title: "Second",
      artists: ["B", "C"],
      durationMs: 180000,
    });
    expect(playlist.description).toBeUndefined();
  });
});
