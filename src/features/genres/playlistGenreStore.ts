import { useMemo, useSyncExternalStore } from "react";

// Playlist Genre — the owner's own categorisation of their playlists
// (founding ruling, 2026-10-31: Playlist Genre is not basic Genre; a
// playlist carries the labels its owner gives it, a track inherits the
// labels of every playlist it sits in, and mixing, sequencing and
// liveRave respect them).
//
// Playlists are server-owned entities: there is no local playlist
// record and no field on the server's playlist a label could be
// written into. Labels therefore live in this LOCAL OVERLAY, keyed by
// playlist id — the same persistence pattern as the failed-songs
// playlist's identity record. Two consequences, stated plainly:
// labels are PER-DEVICE and DO NOT SYNC (they die with this device's
// local storage), and an entry whose playlist is later deleted on the
// server simply orphans here, harmless and unreachable, until a
// future sweep collects it.
//
// Label identity is normalise-for-compare (trim, collapse whitespace,
// case-fold); the display form is the first-typed form, kept both per
// playlist and in the label registry, so the owner's vocabulary stays
// spelled the way they first wrote it. The registry remembers every
// label ever used — including ones no playlist currently carries —
// so the editor can offer the owner's own words back as one-tap
// picks and a label can be renamed everywhere at once.

export const PLAYLIST_GENRES_STORAGE_KEY = "liner_playlist_genres_v1";

/** Stable overlay ids for the labellable collections that are not
 *  server playlists: Liked Songs and the local files collection. */
export const LIKED_PLAYLIST_ID = "liked";
export const LOCAL_PLAYLIST_ID = "local";

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function localKeyValueStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return {
      get: (key) => localStorage.getItem(key),
      set: (key, value) => localStorage.setItem(key, value),
    };
  } catch {
    return null;
  }
}

/** The identity a label is compared by: trimmed, single-spaced, folded. */
export function normalizeGenreLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The display form of a freshly typed label. */
export function cleanGenreLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

export interface PlaylistGenreEntry {
  labels: string[];
  updatedAtMs: number;
}

export interface PlaylistGenreRecord {
  version: 1;
  byPlaylist: Record<string, PlaylistGenreEntry>;
  /** Every label ever used: identity -> first-typed display form. */
  knownLabels: Record<string, string>;
}

function emptyRecord(): PlaylistGenreRecord {
  return { version: 1, byPlaylist: {}, knownLabels: {} };
}

function sanitizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const display = cleanGenreLabel(value);
    const identity = normalizeGenreLabel(display);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    out.push(display);
  }
  return out;
}

export class PlaylistGenreStore {
  private record: PlaylistGenreRecord = emptyRecord();
  private readonly storage: KeyValueStorage | null;
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(storage?: KeyValueStorage | null) {
    this.storage = storage === undefined ? localKeyValueStorage() : storage;
    this.load();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.version;

  private load(): void {
    try {
      const raw = this.storage?.get(PLAYLIST_GENRES_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PlaylistGenreRecord>;
      if (!parsed || typeof parsed !== "object") return;
      const record = emptyRecord();
      if (parsed.byPlaylist && typeof parsed.byPlaylist === "object") {
        for (const [playlistId, entry] of Object.entries(parsed.byPlaylist)) {
          const labels = sanitizeLabels((entry as PlaylistGenreEntry)?.labels);
          if (labels.length === 0) continue;
          record.byPlaylist[playlistId] = {
            labels,
            updatedAtMs:
              typeof (entry as PlaylistGenreEntry)?.updatedAtMs === "number"
                ? (entry as PlaylistGenreEntry).updatedAtMs
                : 0,
          };
          for (const label of labels) {
            const identity = normalizeGenreLabel(label);
            record.knownLabels[identity] ??= label;
          }
        }
      }
      if (parsed.knownLabels && typeof parsed.knownLabels === "object") {
        for (const [identity, display] of Object.entries(parsed.knownLabels)) {
          if (typeof display !== "string") continue;
          const clean = cleanGenreLabel(display);
          if (clean) record.knownLabels[normalizeGenreLabel(clean)] = clean;
        }
      }
      this.record = record;
    } catch {
      // Corrupt storage degrades to "no labels anywhere" — the same
      // state as a fresh library — never to a crash.
      this.record = emptyRecord();
    }
  }

  private persist(): void {
    try {
      this.storage?.set(
        PLAYLIST_GENRES_STORAGE_KEY,
        JSON.stringify(this.record),
      );
    } catch {
      // Storage refused (private mode, tests): labels live in memory.
    }
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** The display labels a playlist carries, in the order they were added. */
  labelsForPlaylist(playlistId: string): string[] {
    if (!playlistId) return [];
    return [...(this.record.byPlaylist[playlistId]?.labels ?? [])];
  }

  /**
   * Adds a label to a playlist. Returns false when the label is blank
   * or the playlist already carries it (by identity). Creates the
   * playlist's overlay entry on first write.
   */
  addLabel(playlistId: string, rawLabel: string): boolean {
    if (!playlistId) return false;
    const display = cleanGenreLabel(rawLabel);
    const identity = normalizeGenreLabel(display);
    if (!identity) return false;
    const existing = this.record.byPlaylist[playlistId]?.labels ?? [];
    if (existing.some((label) => normalizeGenreLabel(label) === identity)) {
      return false;
    }
    this.record.knownLabels[identity] ??= display;
    this.record.byPlaylist[playlistId] = {
      labels: [...existing, this.record.knownLabels[identity]],
      updatedAtMs: Date.now(),
    };
    this.persist();
    return true;
  }

  /** Removes a label (by identity) from a playlist. */
  removeLabel(playlistId: string, label: string): boolean {
    const identity = normalizeGenreLabel(label);
    const entry = this.record.byPlaylist[playlistId];
    if (!entry || !identity) return false;
    const next = entry.labels.filter(
      (candidate) => normalizeGenreLabel(candidate) !== identity,
    );
    if (next.length === entry.labels.length) return false;
    if (next.length === 0) delete this.record.byPlaylist[playlistId];
    else {
      this.record.byPlaylist[playlistId] = {
        labels: next,
        updatedAtMs: Date.now(),
      };
    }
    this.persist();
    return true;
  }

  /** Replaces a playlist's whole label set (normalised, de-duplicated). */
  setLabels(playlistId: string, labels: string[]): void {
    if (!playlistId) return;
    const clean = sanitizeLabels(labels);
    if (clean.length === 0) {
      if (!this.record.byPlaylist[playlistId]) return;
      delete this.record.byPlaylist[playlistId];
    } else {
      for (const label of clean) {
        this.record.knownLabels[normalizeGenreLabel(label)] ??= label;
      }
      this.record.byPlaylist[playlistId] = {
        labels: clean.map(
          (label) =>
            this.record.knownLabels[normalizeGenreLabel(label)] ?? label,
        ),
        updatedAtMs: Date.now(),
      };
    }
    this.persist();
  }

  /**
   * Renames a label everywhere: every playlist carrying the old label
   * carries the new one instead (collapsing into it where both were
   * present), and the registry learns the new word. This is how the
   * owner manages their vocabulary — "gym" becoming "workout" is one
   * act, not an edit per playlist.
   */
  renameLabel(fromLabel: string, toLabel: string): boolean {
    const fromIdentity = normalizeGenreLabel(fromLabel);
    const toDisplay = cleanGenreLabel(toLabel);
    const toIdentity = normalizeGenreLabel(toDisplay);
    if (!fromIdentity || !toIdentity) return false;
    if (fromIdentity === toIdentity) {
      // Same word, new spelling: refresh the display form only.
      if (this.record.knownLabels[fromIdentity] === toDisplay) return false;
      this.record.knownLabels[fromIdentity] = toDisplay;
      for (const entry of Object.values(this.record.byPlaylist)) {
        entry.labels = entry.labels.map((label) =>
          normalizeGenreLabel(label) === fromIdentity ? toDisplay : label,
        );
      }
      this.persist();
      return true;
    }
    let touched = fromIdentity in this.record.knownLabels;
    delete this.record.knownLabels[fromIdentity];
    // Renaming into a label that already exists keeps that label's
    // established (first-typed) display — the registry rule everywhere.
    this.record.knownLabels[toIdentity] ??= toDisplay;
    const canonical = this.record.knownLabels[toIdentity];
    for (const [playlistId, entry] of Object.entries(this.record.byPlaylist)) {
      if (
        !entry.labels.some(
          (label) => normalizeGenreLabel(label) === fromIdentity,
        )
      ) {
        continue;
      }
      touched = true;
      const next: string[] = [];
      const seen = new Set<string>();
      for (const label of entry.labels) {
        const replacement =
          normalizeGenreLabel(label) === fromIdentity ? canonical : label;
        const identity = normalizeGenreLabel(replacement);
        if (seen.has(identity)) continue;
        seen.add(identity);
        next.push(replacement);
      }
      this.record.byPlaylist[playlistId] = {
        labels: next,
        updatedAtMs: Date.now(),
      };
    }
    if (!touched) return false;
    this.persist();
    return true;
  }

  /** Every label some playlist currently carries (registry display forms). */
  allInUseLabels(): string[] {
    const byIdentity = new Map<string, string>();
    for (const entry of Object.values(this.record.byPlaylist)) {
      for (const label of entry.labels) {
        const identity = normalizeGenreLabel(label);
        if (!byIdentity.has(identity)) {
          byIdentity.set(identity, this.record.knownLabels[identity] ?? label);
        }
      }
    }
    return [...byIdentity.values()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }

  /** Every label the owner has ever used, in use or not. */
  allKnownLabels(): string[] {
    return Object.values(this.record.knownLabels).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }

  /** Drops everything (tests, a fresh start). */
  clear(): void {
    this.record = emptyRecord();
    this.persist();
  }
}

/** The library's one Playlist Genre overlay. */
export const playlistGenreStore = new PlaylistGenreStore();

export function labelsForPlaylist(playlistId: string): string[] {
  return playlistGenreStore.labelsForPlaylist(playlistId);
}

export function addPlaylistLabel(playlistId: string, label: string): boolean {
  return playlistGenreStore.addLabel(playlistId, label);
}

export function removePlaylistLabel(
  playlistId: string,
  label: string,
): boolean {
  return playlistGenreStore.removeLabel(playlistId, label);
}

export function renamePlaylistLabel(from: string, to: string): boolean {
  return playlistGenreStore.renameLabel(from, to);
}

export function allInUseGenreLabels(): string[] {
  return playlistGenreStore.allInUseLabels();
}

export function allKnownGenreLabels(): string[] {
  return playlistGenreStore.allKnownLabels();
}

export function usePlaylistGenreLabels(playlistId: string): string[] {
  const version = useSyncExternalStore(
    playlistGenreStore.subscribe,
    playlistGenreStore.getVersion,
    playlistGenreStore.getVersion,
  );
  return useMemo(
    () => playlistGenreStore.labelsForPlaylist(playlistId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the store's change signal
    [version, playlistId],
  );
}

export function useAllInUseGenreLabels(): string[] {
  const version = useSyncExternalStore(
    playlistGenreStore.subscribe,
    playlistGenreStore.getVersion,
    playlistGenreStore.getVersion,
  );
  return useMemo(
    () => playlistGenreStore.allInUseLabels(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the store's change signal
    [version],
  );
}

export function useAllKnownGenreLabels(): string[] {
  const version = useSyncExternalStore(
    playlistGenreStore.subscribe,
    playlistGenreStore.getVersion,
    playlistGenreStore.getVersion,
  );
  return useMemo(
    () => playlistGenreStore.allKnownLabels(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the store's change signal
    [version],
  );
}
