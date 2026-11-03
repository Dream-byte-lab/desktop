import { describe, expect, it } from "vitest";
import {
  PLAYLIST_GENRES_STORAGE_KEY,
  PlaylistGenreStore,
  normalizeGenreLabel,
  type KeyValueStorage,
} from "./playlistGenreStore";

function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("normalizeGenreLabel", () => {
  it("trims, collapses whitespace and case-folds", () => {
    expect(normalizeGenreLabel("  Gym   Mix ")).toBe("gym mix");
    expect(normalizeGenreLabel("")).toBe("");
    expect(normalizeGenreLabel("   ")).toBe("");
  });
});

describe("PlaylistGenreStore", () => {
  it("round-trips labels through persistence", () => {
    const storage = memoryStorage();
    const first = new PlaylistGenreStore(storage);
    expect(first.addLabel("pl1", "Gym")).toBe(true);
    expect(first.addLabel("pl1", "Road Trip")).toBe(true);
    expect(first.addLabel("pl2", "Church")).toBe(true);

    const second = new PlaylistGenreStore(storage);
    expect(second.labelsForPlaylist("pl1")).toEqual(["Gym", "Road Trip"]);
    expect(second.labelsForPlaylist("pl2")).toEqual(["Church"]);
    expect(second.labelsForPlaylist("unknown")).toEqual([]);
    expect(storage.map.has(PLAYLIST_GENRES_STORAGE_KEY)).toBe(true);
  });

  it("finds-or-creates: an absent record reads as no labels, first write creates it", () => {
    const storage = memoryStorage();
    const store = new PlaylistGenreStore(storage);
    expect(store.labelsForPlaylist("pl1")).toEqual([]);
    expect(storage.map.size).toBe(0);
    store.addLabel("pl1", "Focus");
    expect(storage.map.size).toBe(1);
    expect(store.labelsForPlaylist("pl1")).toEqual(["Focus"]);
  });

  it("collapses duplicate labels by identity and keeps the first-typed display", () => {
    const store = new PlaylistGenreStore(memoryStorage());
    expect(store.addLabel("pl1", "Gym")).toBe(true);
    expect(store.addLabel("pl1", " gym ")).toBe(false);
    expect(store.addLabel("pl1", "GYM")).toBe(false);
    expect(store.addLabel("pl2", "gym")).toBe(true);
    // the registry's first-typed display wins on every playlist
    expect(store.labelsForPlaylist("pl1")).toEqual(["Gym"]);
    expect(store.labelsForPlaylist("pl2")).toEqual(["Gym"]);
    expect(store.addLabel("pl1", "  ")).toBe(false);
  });

  it("removes labels, and an emptied playlist leaves no entry behind", () => {
    const storage = memoryStorage();
    const store = new PlaylistGenreStore(storage);
    store.addLabel("pl1", "Gym");
    store.addLabel("pl1", "Focus");
    expect(store.removeLabel("pl1", "GYM")).toBe(true);
    expect(store.labelsForPlaylist("pl1")).toEqual(["Focus"]);
    expect(store.removeLabel("pl1", "Focus")).toBe(true);
    expect(store.labelsForPlaylist("pl1")).toEqual([]);
    expect(store.removeLabel("pl1", "Focus")).toBe(false);
    const reloaded = new PlaylistGenreStore(storage);
    expect(reloaded.labelsForPlaylist("pl1")).toEqual([]);
  });

  it("registry remembers labels no playlist carries any more", () => {
    const store = new PlaylistGenreStore(memoryStorage());
    store.addLabel("pl1", "Gym");
    store.addLabel("pl1", "Church");
    store.removeLabel("pl1", "Gym");
    expect(store.allInUseLabels()).toEqual(["Church"]);
    // "Gym" is out of use but still the owner's word: still offered back
    expect(store.allKnownLabels()).toEqual(["Church", "Gym"]);
  });

  it("renames a label across every playlist and the registry", () => {
    const store = new PlaylistGenreStore(memoryStorage());
    store.addLabel("pl1", "Gym");
    store.addLabel("pl2", "gym");
    store.addLabel("pl2", "Focus");
    expect(store.renameLabel("Gym", "Workout")).toBe(true);
    expect(store.labelsForPlaylist("pl1")).toEqual(["Workout"]);
    expect(store.labelsForPlaylist("pl2")).toEqual(["Workout", "Focus"]);
    expect(store.allKnownLabels()).toEqual(["Focus", "Workout"]);
    expect(store.renameLabel("Missing", "Other")).toBe(false);
    expect(store.renameLabel("Workout", "  ")).toBe(false);
  });

  it("rename collapses into a label the playlist already carries", () => {
    const store = new PlaylistGenreStore(memoryStorage());
    store.addLabel("pl1", "Gym");
    store.addLabel("pl1", "Workout");
    expect(store.renameLabel("Gym", "workout")).toBe(true);
    expect(store.labelsForPlaylist("pl1")).toEqual(["Workout"]);
  });

  it("recovers from corrupt storage as an empty overlay", () => {
    const storage = memoryStorage();
    storage.set(PLAYLIST_GENRES_STORAGE_KEY, "{not json");
    const store = new PlaylistGenreStore(storage);
    expect(store.labelsForPlaylist("pl1")).toEqual([]);
    expect(store.allKnownLabels()).toEqual([]);
    // and the store still works afterwards
    expect(store.addLabel("pl1", "Gym")).toBe(true);
    expect(store.labelsForPlaylist("pl1")).toEqual(["Gym"]);
  });

  it("recovers from a structurally wrong record", () => {
    const storage = memoryStorage();
    storage.set(
      PLAYLIST_GENRES_STORAGE_KEY,
      JSON.stringify({ version: 1, byPlaylist: "nope", knownLabels: 42 }),
    );
    const store = new PlaylistGenreStore(storage);
    expect(store.labelsForPlaylist("pl1")).toEqual([]);
    expect(store.allInUseLabels()).toEqual([]);
  });

  it("works with no storage at all (in-memory only)", () => {
    const store = new PlaylistGenreStore(null);
    expect(store.addLabel("pl1", "Gym")).toBe(true);
    expect(store.labelsForPlaylist("pl1")).toEqual(["Gym"]);
  });

  it("notifies subscribers on change with a rising version", () => {
    const store = new PlaylistGenreStore(memoryStorage());
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    const v0 = store.getVersion();
    store.addLabel("pl1", "Gym");
    expect(calls).toBe(1);
    expect(store.getVersion()).toBeGreaterThan(v0);
    unsubscribe();
    store.addLabel("pl1", "Focus");
    expect(calls).toBe(1);
  });
});
