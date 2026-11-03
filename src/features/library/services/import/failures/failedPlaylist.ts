import {
  FailedImportsStore,
  failedImports,
  type FailedImportEntry,
  type FailedImportStorage,
} from "./failedImportsStore";

// The ONE failed-songs playlist (user ruling, 2026-11-02, Note 10).
//
// Every song that fails an import — at matching, at saving, or left
// over at the review stage — is saved into this playlist,
// automatically, during the import itself, before the import
// finishes. There is exactly one such playlist in the library: not
// one per import, never a second one. Every import's failures, from
// every imported playlist, land in this same home and it grows
// across imports. No manual step exists: if the user had to save or
// move anything for a song to land here, the ruling would not be
// met.
//
// Why the playlist lives on this device rather than on the server:
// a library playlist on the server holds catalogue track snapshots,
// and a failed song has no catalogue track — no match is exactly
// why it failed. Its contents are therefore the source songs
// themselves (title, artists, source, why it failed), kept by the
// failed-imports store, which is this playlist's working tray: the
// entries in the store ARE this playlist's contents — one set of
// records, one home, never two collections to disagree. From here
// a song can be retried; when a match later exists it recovers into
// the library properly and leaves this playlist (see
// recoverFailedImports).
//
// The playlist's identity is a small persisted record: the first
// failure creates it, every later failure finds the same record and
// reuses it — finds-or-creates exactly once, forever.

export const FAILED_PLAYLIST_TITLE = "Could not import";

const IDENTITY_KEY = "liner_failed_playlist_v1";

export interface FailedPlaylistIdentity {
  id: string;
  title: string;
  createdAt: string;
}

function newPlaylistId(): string {
  const random =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `failed_${random}`;
}

function localIdentityStorage(): FailedImportStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return {
      read: () => localStorage.getItem(IDENTITY_KEY),
      write: (value) => localStorage.setItem(IDENTITY_KEY, value),
    };
  } catch {
    return null;
  }
}

export class FailedPlaylist {
  private readonly storage: FailedImportStorage | null;
  private readonly store: FailedImportsStore;
  /** Session fallback when no storage is available at all. */
  private sessionIdentity: FailedPlaylistIdentity | null = null;

  constructor(options?: {
    storage?: FailedImportStorage | null;
    store?: FailedImportsStore;
  }) {
    this.storage =
      options?.storage === undefined ? localIdentityStorage() : options.storage;
    this.store = options?.store ?? failedImports;
  }

  /** The playlist's identity, if it has been created yet. */
  identity(): FailedPlaylistIdentity | null {
    try {
      const raw = this.storage?.read();
      if (raw) {
        const parsed = JSON.parse(raw) as FailedPlaylistIdentity;
        if (parsed && typeof parsed.id === "string" && parsed.id) {
          return { ...parsed, title: FAILED_PLAYLIST_TITLE };
        }
      }
    } catch {
      // A corrupt record is treated as "not created yet"; ensure()
      // replaces it with a fresh one.
    }
    return this.sessionIdentity;
  }

  /** Finds the one playlist, creating it — once — if it is missing. */
  ensure(): FailedPlaylistIdentity {
    const existing = this.identity();
    if (existing) return existing;
    const created: FailedPlaylistIdentity = {
      id: newPlaylistId(),
      title: FAILED_PLAYLIST_TITLE,
      createdAt: new Date().toISOString(),
    };
    this.sessionIdentity = created;
    try {
      this.storage?.write(JSON.stringify(created));
    } catch {
      // Storage refused the write (private mode, tests): the
      // session identity above still keeps the playlist singular,
      // and the entries persist via the store's own storage.
    }
    return created;
  }

  /**
   * Saves failed songs into the playlist. This is the one door
   * every failure comes through, called by the import itself as
   * part of finalizing — never a user action. An empty save creates
   * nothing: the playlist comes into existence with its first song.
   */
  save(
    additions: Omit<FailedImportEntry, "key" | "attempts">[],
  ): FailedImportEntry[] {
    if (additions.length === 0) return this.store.list();
    this.ensure();
    return this.store.record(additions);
  }

  entries(): FailedImportEntry[] {
    return this.store.list();
  }

  count(): number {
    return this.store.list().length;
  }

  /** Removes songs (e.g. after a retry recovered them). */
  remove(keys: string[]): void {
    this.store.remove(keys);
  }
}

/** The library's single failed-songs playlist. */
export const failedPlaylist = new FailedPlaylist();

/**
 * Saves failed songs into the one failed-songs playlist,
 * automatically, as part of the import that produced them.
 */
export function saveFailedSongsToPlaylist(
  additions: Omit<FailedImportEntry, "key" | "attempts">[],
): FailedImportEntry[] {
  return failedPlaylist.save(additions);
}
