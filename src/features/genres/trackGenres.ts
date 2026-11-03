import {
  localKeyValueStorage,
  normalizeGenreLabel,
  playlistGenreStore,
  type KeyValueStorage,
} from "./playlistGenreStore";

// Track genre resolution: the one place consumers ask "what labels
// does this track carry" — and the two kinds of label are answered
// separately, because the founding ruling keeps them separate:
//
//   - Playlist Genres (the owner's categorisation): a track inherits
//     the UNION of the labels of every playlist it sits in. Membership
//     comes from the index below, which is built from playlist
//     contents the app has actually loaded and persisted, so it warms
//     as the owner browses. Honest limit: a track in a playlist the
//     app has never opened inherits nothing until that playlist is
//     loaded once — consumers must read "no labels found" as UNKNOWN,
//     not as "this track has no labels".
//
//   - Basic Genres (source-provided): read from an enrichment record
//     that NOTHING in the app writes today, because no source the app
//     talks to carries genre data (no API contract, artist record or
//     import format has a genre field — verified by inventory). The
//     record is the socket: when a real source exists (a metadata
//     feed, a richer import format), it writes here and every
//     consumer lights up without a data-model change. Until then
//     genreForTrack returns [] — "unknown" — and that absence is a
//     normal state, never a negative signal. Design rule, absolute:
//     no heuristic may invent a basic Genre (no guessing from artist
//     names, track titles or playlist names). An invented genre is
//     worse than an absent one, because consumers would reason from
//     it as if it were data.

export const PLAYLIST_MEMBERSHIP_STORAGE_KEY = "liner_playlist_membership_v1";
export const TRACK_GENRES_STORAGE_KEY = "liner_track_genres_v1";

export interface TrackLabels {
  /** Playlist Genre labels inherited from every containing playlist. */
  playlistGenres: string[];
  /** Basic Genre labels from source enrichment; [] = unknown. */
  genres: string[];
}

// ---------------------------------------------------------------------
// Membership index: playlist -> track ids (persisted), track -> playlists
// (derived in memory). Updated whenever playlist details land in the
// library data layer, and only from what was actually fetched.
// ---------------------------------------------------------------------

interface MembershipRecord {
  version: 1;
  byPlaylist: Record<string, { trackIds: string[]; fetchedAtMs: number }>;
}

function emptyMembership(): MembershipRecord {
  return { version: 1, byPlaylist: {} };
}

export class PlaylistMembershipIndex {
  private byPlaylist = new Map<
    string,
    { trackIds: string[]; fetchedAtMs: number }
  >();
  private byTrack = new Map<string, Set<string>>();
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
      const raw = this.storage?.get(PLAYLIST_MEMBERSHIP_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<MembershipRecord>;
      if (!parsed || typeof parsed !== "object" || !parsed.byPlaylist) return;
      for (const [playlistId, entry] of Object.entries(parsed.byPlaylist)) {
        if (!entry || !Array.isArray(entry.trackIds)) continue;
        const trackIds = [
          ...new Set(
            entry.trackIds.filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            ),
          ),
        ];
        if (trackIds.length > 0) {
          this.setMembership(
            playlistId,
            trackIds,
            typeof entry.fetchedAtMs === "number" ? entry.fetchedAtMs : 0,
          );
        }
      }
    } catch {
      this.byPlaylist.clear();
      this.byTrack.clear();
    }
  }

  private setMembership(
    playlistId: string,
    trackIds: string[],
    fetchedAtMs: number,
  ): void {
    const previous = this.byPlaylist.get(playlistId)?.trackIds ?? [];
    for (const trackId of previous) {
      const set = this.byTrack.get(trackId);
      if (set) {
        set.delete(playlistId);
        if (set.size === 0) this.byTrack.delete(trackId);
      }
    }
    this.byPlaylist.set(playlistId, { trackIds, fetchedAtMs });
    for (const trackId of trackIds) {
      const set = this.byTrack.get(trackId) ?? new Set<string>();
      set.add(playlistId);
      this.byTrack.set(trackId, set);
    }
  }

  private persist(): void {
    try {
      const byPlaylist: MembershipRecord["byPlaylist"] = {};
      for (const [playlistId, entry] of this.byPlaylist) {
        byPlaylist[playlistId] = entry;
      }
      this.storage?.set(
        PLAYLIST_MEMBERSHIP_STORAGE_KEY,
        JSON.stringify({ version: 1, byPlaylist } satisfies MembershipRecord),
      );
    } catch {
      // Storage refused: the index still serves this session.
    }
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /**
   * Records the track ids a playlist was just seen to contain.
   * `complete` records replace the playlist's list (a full detail
   * fetch); partial records (a first page) only ever ADD — a page
   * must never evict tracks it simply did not reach.
   */
  record(playlistId: string, trackIds: string[], complete: boolean): void {
    if (!playlistId) return;
    const clean = [
      ...new Set(trackIds.filter((id) => typeof id === "string" && id)),
    ];
    if (complete) {
      this.setMembership(playlistId, clean, Date.now());
    } else {
      const existing = this.byPlaylist.get(playlistId)?.trackIds ?? [];
      const merged = [...new Set([...existing, ...clean])];
      if (merged.length === existing.length) return;
      this.setMembership(playlistId, merged, Date.now());
    }
    this.persist();
  }

  /** Ids of the playlists this track is known to sit in. */
  playlistsForTrack(trackId: string): string[] {
    return [...(this.byTrack.get(trackId) ?? [])];
  }

  /** Ids of the tracks this playlist is known to contain. */
  tracksForPlaylist(playlistId: string): string[] {
    return [...(this.byPlaylist.get(playlistId)?.trackIds ?? [])];
  }

  clear(): void {
    this.byPlaylist.clear();
    this.byTrack.clear();
    this.persist();
  }
}

// ---------------------------------------------------------------------
// Basic Genre enrichment record — the socket. Written by nobody in
// the app today (see the header); the read side is real so consumers
// can be built against the truth, which is "unknown".
// ---------------------------------------------------------------------

interface TrackGenreRecord {
  version: 1;
  byTrack: Record<string, { genres: string[]; source: string }>;
}

export class TrackGenreEnrichment {
  private byTrack = new Map<string, { genres: string[]; source: string }>();
  private readonly storage: KeyValueStorage | null;

  constructor(storage?: KeyValueStorage | null) {
    this.storage = storage === undefined ? localKeyValueStorage() : storage;
    this.load();
  }

  private load(): void {
    try {
      const raw = this.storage?.get(TRACK_GENRES_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<TrackGenreRecord>;
      if (!parsed || typeof parsed !== "object" || !parsed.byTrack) return;
      for (const [trackId, entry] of Object.entries(parsed.byTrack)) {
        if (!entry || !Array.isArray(entry.genres)) continue;
        const genres = entry.genres.filter(
          (genre): genre is string =>
            typeof genre === "string" && genre.trim().length > 0,
        );
        if (genres.length > 0) {
          this.byTrack.set(trackId, {
            genres,
            source: typeof entry.source === "string" ? entry.source : "",
          });
        }
      }
    } catch {
      this.byTrack.clear();
    }
  }

  private persist(): void {
    try {
      const byTrack: TrackGenreRecord["byTrack"] = {};
      for (const [trackId, entry] of this.byTrack) byTrack[trackId] = entry;
      this.storage?.set(
        TRACK_GENRES_STORAGE_KEY,
        JSON.stringify({ version: 1, byTrack } satisfies TrackGenreRecord),
      );
    } catch {
      // Storage refused: enrichment lives for this session only.
    }
  }

  /** The track's basic Genres from source enrichment; [] = unknown. */
  genresForTrack(trackId: string): string[] {
    return [...(this.byTrack.get(trackId)?.genres ?? [])];
  }

  /**
   * The socket's write side, for a future real source. `source` names
   * where the values came from; entries without a named source are
   * refused — unattributed genre data is how invented data starts.
   */
  setTrackGenres(trackId: string, genres: string[], source: string): void {
    if (!trackId || !source) return;
    const clean = [
      ...new Set(
        genres
          .map((genre) => genre.trim().replace(/\s+/g, " "))
          .filter(Boolean),
      ),
    ];
    if (clean.length === 0) this.byTrack.delete(trackId);
    else this.byTrack.set(trackId, { genres: clean, source });
    this.persist();
  }

  clear(): void {
    this.byTrack.clear();
    this.persist();
  }
}

// ---------------------------------------------------------------------
// The shared instances and the resolver consumers call.
// ---------------------------------------------------------------------

export const playlistMembership = new PlaylistMembershipIndex();
export const trackGenreEnrichment = new TrackGenreEnrichment();

/** Records a fetched playlist's contents into the membership index. */
export function recordPlaylistTracks(
  playlistId: string,
  trackIds: string[],
  complete: boolean,
): void {
  playlistMembership.record(playlistId, trackIds, complete);
}

/** Ids of the playlists this track is known to sit in. */
export function playlistsContainingTrack(trackId: string): string[] {
  return playlistMembership.playlistsForTrack(trackId);
}

/**
 * The track's Playlist Genres: the union of the labels of every
 * playlist it sits in, de-duplicated by label identity. Several is
 * normal; none means either "unlabelled" or "not yet known" — the
 * membership index's honesty limit (see the header), and consumers
 * must treat it as unknown, never as a negative.
 */
export function playlistGenresForTrack(trackId: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const playlistId of playlistMembership.playlistsForTrack(trackId)) {
    for (const label of playlistGenreStore.labelsForPlaylist(playlistId)) {
      const identity = normalizeGenreLabel(label);
      if (seen.has(identity)) continue;
      seen.add(identity);
      out.push(label);
    }
  }
  return out;
}

/** The track's basic Genres from source enrichment; [] = unknown. */
export function genreForTrack(trackId: string): string[] {
  return trackGenreEnrichment.genresForTrack(trackId);
}

/** The one call consumers make: both label kinds, kept separate. */
export function labelsForTrack(trackId: string): TrackLabels {
  return {
    playlistGenres: playlistGenresForTrack(trackId),
    genres: genreForTrack(trackId),
  };
}
