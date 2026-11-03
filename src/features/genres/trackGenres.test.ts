import { afterEach, describe, expect, it } from "vitest";
import {
  PlaylistGenreStore,
  playlistGenreStore,
  type KeyValueStorage,
} from "./playlistGenreStore";
import {
  PlaylistMembershipIndex,
  TrackGenreEnrichment,
  genreForTrack,
  labelsForTrack,
  playlistGenresForTrack,
  playlistMembership,
  recordPlaylistTracks,
  trackGenreEnrichment,
} from "./trackGenres";
import { getTasteProfile, recordListen } from "../mixer/engine/tasteTracker";
import type { Track } from "../../shared/types/track";

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("PlaylistMembershipIndex", () => {
  it("round-trips membership through persistence", () => {
    const storage = memoryStorage();
    const first = new PlaylistMembershipIndex(storage);
    first.record("pl1", ["t1", "t2"], true);
    const second = new PlaylistMembershipIndex(storage);
    expect(second.tracksForPlaylist("pl1")).toEqual(["t1", "t2"]);
    expect(second.playlistsForTrack("t2")).toEqual(["pl1"]);
    expect(second.playlistsForTrack("ghost")).toEqual([]);
  });

  it("a complete record replaces; a partial record only adds", () => {
    const index = new PlaylistMembershipIndex(memoryStorage());
    index.record("pl1", ["t1", "t2", "t3"], true);
    index.record("pl1", ["t1"], false); // a first page must not evict
    expect(index.tracksForPlaylist("pl1")).toEqual(["t1", "t2", "t3"]);
    index.record("pl1", ["t1", "t4"], true); // a full fetch may
    expect(index.tracksForPlaylist("pl1")).toEqual(["t1", "t4"]);
    expect(index.playlistsForTrack("t3")).toEqual([]);
  });

  it("recovers from corrupt storage as an empty index", () => {
    const storage = memoryStorage();
    storage.set("liner_playlist_membership_v1", "[[[");
    const index = new PlaylistMembershipIndex(storage);
    expect(index.playlistsForTrack("t1")).toEqual([]);
    index.record("pl1", ["t1"], true);
    expect(index.playlistsForTrack("t1")).toEqual(["pl1"]);
  });
});

describe("TrackGenreEnrichment — the basic Genre socket", () => {
  it("is empty by default: genre is unknown, never invented", () => {
    const enrichment = new TrackGenreEnrichment(memoryStorage());
    expect(enrichment.genresForTrack("t1")).toEqual([]);
  });

  it("round-trips values a named source wrote, and refuses anonymous ones", () => {
    const storage = memoryStorage();
    const first = new TrackGenreEnrichment(storage);
    first.setTrackGenres("t1", ["Afrobeats", "Highlife"], "test-feed");
    first.setTrackGenres("t2", ["Jazz"], "");
    const second = new TrackGenreEnrichment(storage);
    expect(second.genresForTrack("t1")).toEqual(["Afrobeats", "Highlife"]);
    expect(second.genresForTrack("t2")).toEqual([]);
  });
});

describe("resolution over the shared stores", () => {
  afterEach(() => {
    playlistGenreStore.clear();
    playlistMembership.clear();
    trackGenreEnrichment.clear();
  });

  it("a track inherits the union of labels from every playlist it sits in", () => {
    playlistGenreStore.addLabel("pl-a", "Gym");
    playlistGenreStore.addLabel("pl-a", "Morning");
    playlistGenreStore.addLabel("pl-b", "Road Trip");
    playlistGenreStore.addLabel("pl-c", "gym"); // same identity as pl-a's
    recordPlaylistTracks("pl-a", ["song-1"], true);
    recordPlaylistTracks("pl-b", ["song-1", "song-2"], true);
    recordPlaylistTracks("pl-c", ["song-1"], true);

    // union across three playlists, the duplicate identity collapsed
    expect(playlistGenresForTrack("song-1")).toEqual([
      "Gym",
      "Morning",
      "Road Trip",
    ]);
    expect(playlistGenresForTrack("song-2")).toEqual(["Road Trip"]);
  });

  it("an unlabelled or unknown track resolves to empty, not an error", () => {
    recordPlaylistTracks("pl-a", ["song-1"], true);
    expect(labelsForTrack("song-1")).toEqual({
      playlistGenres: [],
      genres: [],
    });
    expect(labelsForTrack("never-seen")).toEqual({
      playlistGenres: [],
      genres: [],
    });
  });

  it("membership warm-up: labels appear once the playlist has been loaded", () => {
    playlistGenreStore.addLabel("pl-warm", "Church");
    // the label exists, but the app has never loaded this playlist's
    // contents, so no track can inherit yet — unknown, not none
    expect(playlistGenresForTrack("song-9")).toEqual([]);
    recordPlaylistTracks("pl-warm", ["song-9"], true);
    expect(playlistGenresForTrack("song-9")).toEqual(["Church"]);
  });

  it("removing a label from a playlist propagates to resolution", () => {
    playlistGenreStore.addLabel("pl-a", "Gym");
    playlistGenreStore.addLabel("pl-a", "Focus");
    recordPlaylistTracks("pl-a", ["song-1"], true);
    expect(playlistGenresForTrack("song-1")).toEqual(["Gym", "Focus"]);
    playlistGenreStore.removeLabel("pl-a", "Gym");
    expect(playlistGenresForTrack("song-1")).toEqual(["Focus"]);
  });

  it("labelsForTrack keeps the two kinds separate", () => {
    playlistGenreStore.addLabel("pl-a", "Gym");
    recordPlaylistTracks("pl-a", ["song-1"], true);
    trackGenreEnrichment.setTrackGenres("song-1", ["Dancehall"], "test-feed");
    expect(labelsForTrack("song-1")).toEqual({
      playlistGenres: ["Gym"],
      genres: ["Dancehall"],
    });
    expect(genreForTrack("song-2")).toEqual([]);
  });

  it("works against injected stores exactly as against the singletons", () => {
    const overlay = new PlaylistGenreStore(memoryStorage());
    overlay.addLabel("pl-x", "Study");
    // the class-level contract the resolver is built on
    expect(overlay.labelsForPlaylist("pl-x")).toEqual(["Study"]);
  });
});

describe("the taste chain (blueprint §2.4 — the tags slot, fed at last)", () => {
  afterEach(() => {
    playlistGenreStore.clear();
    playlistMembership.clear();
    trackGenreEnrichment.clear();
  });

  it("a listen on a labelled playlist moves the taste profile's tags map", () => {
    playlistGenreStore.addLabel("pl-taste", "Tastechain Label");
    recordPlaylistTracks("pl-taste", ["taste-track-1"], true);
    const before = getTasteProfile().tags["Tastechain Label"] ?? 0;

    const track = {
      id: "taste-track-1",
      title: "Song",
      artists: "Singer",
    } as Track;
    recordListen({ track, playedRatio: 1, completed: true });

    const after = getTasteProfile().tags["Tastechain Label"] ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("a listen on an unlabelled track adds no tags", () => {
    const track = {
      id: "taste-track-unlabelled",
      title: "Song",
      artists: "Singer",
    } as Track;
    const tagsBefore = { ...getTasteProfile().tags };
    recordListen({ track, playedRatio: 1, completed: true });
    expect(getTasteProfile().tags).toEqual(tagsBefore);
  });
});
