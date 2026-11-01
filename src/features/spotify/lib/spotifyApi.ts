// A small, typed client for the official Spotify Web API — the
// sanctioned route, in deliberate contrast to the existing import's
// web-player internals. It reads the signed-in user's own data only:
// their profile, their playlists (own, followed, collaborative,
// private), and those playlists' tracks, following pagination to
// the end. It never sees the user's password (OAuth + PKCE happens
// outside this class) and it returns plain data the importer maps
// onto Liner's import contract.

const API_BASE = "https://api.spotify.com/v1";

export class SpotifyApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SpotifyApiError";
    this.status = status;
  }
}

export interface SpotifyUserProfile {
  id: string;
  displayName: string;
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  description: string;
  ownerName: string;
  trackTotal: number;
  collaborative: boolean;
  isPublic: boolean;
  imageUrl?: string;
}

export interface SpotifyTrackItem {
  id: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  coverUrl?: string;
}

export interface SpotifyPlaylistTracks {
  tracks: SpotifyTrackItem[];
  /** Playlist entries that are podcast episodes, not songs. */
  skippedEpisodes: number;
  /** Entries that are files from the owner's own device. */
  skippedLocal: number;
  /** Entries Spotify lists but no longer offers (removed tracks). */
  skippedUnavailable: number;
}

interface Paging<T> {
  items: T[];
  next: string | null;
}

interface RawPlaylist {
  id: string;
  name: string;
  description: string | null;
  owner: { display_name: string | null };
  tracks: { total: number };
  collaborative: boolean;
  public: boolean | null;
  images?: { url: string }[];
}

interface RawTrackEntry {
  track: {
    id: string | null;
    name: string;
    type: string;
    is_local: boolean;
    duration_ms: number;
    artists: { name: string }[];
    album: { name: string; images?: { url: string }[] };
  } | null;
}

export interface SpotifyApiDeps {
  /** Supplies a currently valid access token (refreshing if needed). */
  getAccessToken: () => Promise<string>;
  fetchFn?: typeof fetch;
}

export class SpotifyApi {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: SpotifyApiDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private async get<T>(pathOrUrl: string): Promise<T> {
    const token = await this.deps.getAccessToken();
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${API_BASE}${pathOrUrl}`;
    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new SpotifyApiError(
        response.status,
        `Spotify API request failed (${response.status}) for ${url}`,
      );
    }
    return (await response.json()) as T;
  }

  private async getAllPages<T>(firstPath: string): Promise<T[]> {
    const all: T[] = [];
    let next: string | null = firstPath;
    while (next) {
      const page: Paging<T> = await this.get<Paging<T>>(next);
      all.push(...page.items);
      next = page.next;
    }
    return all;
  }

  async me(): Promise<SpotifyUserProfile> {
    const raw = await this.get<{ id: string; display_name: string | null }>(
      "/me",
    );
    return { id: raw.id, displayName: raw.display_name ?? raw.id };
  }

  async listPlaylists(): Promise<SpotifyPlaylistSummary[]> {
    const raw = await this.getAllPages<RawPlaylist>("/me/playlists?limit=50");
    return raw.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description ?? "",
      ownerName: playlist.owner.display_name ?? "",
      trackTotal: playlist.tracks.total,
      collaborative: playlist.collaborative,
      isPublic: playlist.public ?? false,
      ...(playlist.images?.[0] ? { imageUrl: playlist.images[0].url } : {}),
    }));
  }

  async playlistTracks(playlistId: string): Promise<SpotifyPlaylistTracks> {
    const entries = await this.getAllPages<RawTrackEntry>(
      `/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`,
    );
    const result: SpotifyPlaylistTracks = {
      tracks: [],
      skippedEpisodes: 0,
      skippedLocal: 0,
      skippedUnavailable: 0,
    };
    for (const entry of entries) {
      const track = entry.track;
      if (!track || !track.id) {
        result.skippedUnavailable += 1;
        continue;
      }
      if (track.type === "episode") {
        result.skippedEpisodes += 1;
        continue;
      }
      if (track.is_local) {
        result.skippedLocal += 1;
        continue;
      }
      result.tracks.push({
        id: track.id,
        title: track.name,
        artists: track.artists.map((artist) => artist.name),
        album: track.album.name,
        durationMs: track.duration_ms,
        ...(track.album.images?.[0]
          ? { coverUrl: track.album.images[0].url }
          : {}),
      });
    }
    return result;
  }
}
