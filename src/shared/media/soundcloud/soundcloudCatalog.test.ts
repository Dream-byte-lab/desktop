import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rememberSoundCloudClientId,
  resetSoundCloudClientIdCache,
} from "./soundcloudClientId";
import { soundcloudCatalog } from "./soundcloudCatalog";
import { isSoundCloudUrl, resolveSoundCloudUrl } from "./soundcloudResolveUrl";

type Route = (url: URL) => unknown;

const USER = {
  id: 42,
  username: "label-upload",
  full_name: "Real Artist",
  avatar_url: "https://i1.sndcdn.com/avatars-x-large.jpg",
  verified: true,
  description: "bio",
};

function track(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Song ${id}`,
    duration: 1000 * id,
    artwork_url: `https://i1.sndcdn.com/artworks-${id}-large.jpg`,
    user: USER,
    ...extra,
  };
}

function installFetch(routes: Record<string, Route>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const route = routes[url.pathname];
    const body = route?.(url);
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  resetSoundCloudClientIdCache();
  rememberSoundCloudClientId("c".repeat(32));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("soundcloudCatalog.getArtist", () => {
  it("builds an artist page from the user, top tracks, uploads and releases", async () => {
    installFetch({
      "/users/42": () => USER,
      "/users/42/toptracks": () => ({
        collection: [track(2, { playback_count: 1234567 }), track(1)],
      }),
      "/users/42/tracks": () => ({ collection: [track(1), track(3)] }),
      "/users/42/albums": () => ({
        collection: [
          {
            id: 7,
            title: "LP",
            set_type: "album",
            track_count: 9,
            release_date: "2024-05-01T00:00:00Z",
          },
          { id: 8, title: "Two Songs", set_type: "ep", track_count: 2 },
        ],
      }),
    });

    const artist = await soundcloudCatalog.getArtist("sc_user_42");

    expect(artist).toMatchObject({
      id: "sc_user_42",
      name: "Real Artist",
      bio: "bio",
      verified: true,
    });
    expect(artist.cover?.url).toBe(
      "https://i1.sndcdn.com/avatars-x-t500x500.jpg",
    );
    expect(artist.tracks.map((item) => item.id)).toEqual([
      "sc:2",
      "sc:1",
      "sc:3",
    ]);
    expect(artist.tracks[0].artists).toEqual([
      { id: "sc_user_42", name: "label-upload" },
    ]);
    // SoundCloud publishes a playback_count; it rides the track as
    // playCount. A track whose payload carries none stays without
    // the field — absent, never zero-filled.
    expect(artist.tracks[0].playCount).toBe(1234567);
    expect(artist.tracks[1].playCount).toBeUndefined();
    expect(artist.albums).toEqual([
      expect.objectContaining({
        id: "sc_playlist_7",
        year: 2024,
        trackCount: 9,
      }),
    ]);
    expect(artist.singles).toEqual([
      expect.objectContaining({ id: "sc_playlist_8", releaseType: "ep" }),
    ]);
  });

  it("derives similar artists from the related tracks of the top tracks", async () => {
    const otherUser = (id: number, username: string) => ({
      id,
      username,
      full_name: username,
      avatar_url: `https://i1.sndcdn.com/avatars-${username}-large.jpg`,
    });
    const otherTrack = (id: number, user: Record<string, unknown>) => ({
      id,
      title: `Other ${id}`,
      duration: 1000,
      user,
    });
    installFetch({
      "/users/42": () => USER,
      "/users/42/toptracks": () => ({ collection: [track(2), track(1)] }),
      "/users/42/tracks": () => ({ collection: [] }),
      "/users/42/albums": () => ({ collection: [] }),
      "/tracks/2/related": () => ({
        collection: [
          otherTrack(21, otherUser(7, "seven")),
          otherTrack(22, otherUser(9, "nine")),
          track(23),
        ],
      }),
      "/tracks/1/related": () => ({
        collection: [otherTrack(24, otherUser(7, "seven"))],
      }),
    });

    const artist = await soundcloudCatalog.getArtist("sc_user_42");

    // Ranked by appearances across both related lists; the
    // artist's own uploads in the lists never appear; the cover
    // is the avatar SoundCloud serves for that uploader.
    expect(artist.similarArtistsBasis).toBe("related");
    expect(artist.similarArtists?.map((entry) => entry.id)).toEqual([
      "sc_user_7",
      "sc_user_9",
    ]);
    expect(artist.similarArtists?.[0].name).toBe("seven");
    expect(artist.similarArtists?.[0].cover?.url).toBe(
      "https://i1.sndcdn.com/avatars-seven-t500x500.jpg",
    );
  });

  it("still opens the artist when a secondary listing fails", async () => {
    installFetch({
      "/users/42": () => USER,
      "/users/42/tracks": () => ({ collection: [track(5)] }),
    });
    const artist = await soundcloudCatalog.getArtist("sc_user_42");
    expect(artist.tracks.map((item) => item.id)).toEqual(["sc:5"]);
    expect(artist.albums).toEqual([]);
  });

  it("rejects ids that are not SoundCloud users", async () => {
    installFetch({});
    await expect(soundcloudCatalog.getArtist("UCabc")).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("soundcloudCatalog sets", () => {
  it("hydrates stub tracks and maps a playlist", async () => {
    const spy = installFetch({
      "/playlists/7": () => ({
        id: 7,
        title: "Mix",
        description: "d",
        user: USER,
        track_count: 2,
        tracks: [track(1), { id: 2 }],
      }),
      "/tracks": (url) =>
        url.searchParams.get("ids") === "2" ? [track(2)] : undefined,
    });

    const playlist = await soundcloudCatalog.getPlaylist("sc_playlist_7");

    expect(playlist).toMatchObject({
      type: "playlist",
      id: "sc_playlist_7",
      title: "Mix",
      author: "label-upload",
      description: "d",
      trackCount: 2,
    });
    expect(playlist.tracks.map((item) => item.id)).toEqual(["sc:1", "sc:2"]);
    expect(playlist.durationMs).toBe(3000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("maps the same set as an album with its uploader as artist", async () => {
    installFetch({
      "/playlists/7": () => ({
        id: 7,
        title: "LP",
        user: USER,
        tracks: [track(1)],
      }),
    });
    const album = await soundcloudCatalog.getAlbum("sc_playlist_7");
    expect(album).toMatchObject({
      type: "album",
      artists: [{ id: "sc_user_42", name: "label-upload" }],
    });
  });
});

describe("soundcloudCatalog tracks", () => {
  it("loads a track and its related radio", async () => {
    installFetch({
      "/tracks/1": () =>
        track(1, {
          description: "about",
          publisher_metadata: { explicit: true },
        }),
      "/tracks/1/related": () => ({ collection: [track(2), track(3)] }),
    });
    await expect(soundcloudCatalog.getTrack("sc:1")).resolves.toMatchObject({
      id: "sc:1",
      description: "about",
      explicit: true,
    });
    await expect(soundcloudCatalog.getRadio("sc:1", 1)).resolves.toEqual({
      items: [expect.objectContaining({ id: "sc:2" })],
    });
  });
});

describe("resolveSoundCloudUrl", () => {
  it("detects SoundCloud links", () => {
    expect(isSoundCloudUrl("https://soundcloud.com/artist/sets/lp")).toBe(true);
    expect(isSoundCloudUrl("soundcloud.com/artist")).toBe(true);
    expect(isSoundCloudUrl("the weeknd")).toBe(false);
  });

  it("resolves users, albums, playlists and tracks into search results", async () => {
    const bodies: Record<string, unknown> = {
      "https://soundcloud.com/label-upload": { kind: "user", ...USER },
      "https://soundcloud.com/label-upload/sets/lp": {
        kind: "playlist",
        id: 7,
        title: "LP",
        set_type: "album",
        user: USER,
      },
      "https://soundcloud.com/label-upload/sets/mix": {
        kind: "playlist",
        id: 9,
        title: "Mix",
        set_type: "",
        user: USER,
      },
      "https://soundcloud.com/label-upload/song-1": {
        kind: "track",
        ...track(1),
      },
    };
    installFetch({
      "/resolve": (url) => bodies[url.searchParams.get("url") ?? ""],
    });

    await expect(
      resolveSoundCloudUrl("https://soundcloud.com/label-upload?si=x"),
    ).resolves.toEqual([
      expect.objectContaining({ type: "artist", id: "sc_user_42" }),
    ]);
    await expect(
      resolveSoundCloudUrl("soundcloud.com/label-upload/sets/lp"),
    ).resolves.toEqual([
      expect.objectContaining({ type: "album", id: "sc_playlist_7" }),
    ]);
    await expect(
      resolveSoundCloudUrl("https://m.soundcloud.com/label-upload/sets/mix"),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "playlist",
        id: "sc_playlist_9",
        author: "label-upload",
      }),
    ]);
    await expect(
      resolveSoundCloudUrl(
        "https://soundcloud.com/label-upload/song-1",
        "track",
      ),
    ).resolves.toEqual([
      expect.objectContaining({ type: "track", id: "sc:1" }),
    ]);
    await expect(
      resolveSoundCloudUrl(
        "https://soundcloud.com/label-upload/song-1",
        "artist",
      ),
    ).resolves.toEqual([]);
  });
});
