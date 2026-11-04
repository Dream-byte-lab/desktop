import { mediaUrl, toClientTrack, toMaxQualityAvatarUrl } from "@/shared/api";
import type { ApiSearchItem } from "@/shared/api";
import type { Track } from "@/shared/types";
import { isSoundCloudCatalogId } from "@/shared/media/soundcloud";

// The Search page's row view models. The mapping below is the
// AppFrame overlay's own normalisation, extracted into the search
// fence (the interface programme's S1 file map allows exactly this
// extraction — never a fork): a result means the same thing on the
// page as it did in the overlay, and when the overlay retires at
// integration this file is the one surviving copy.

export type SearchRowKind = "track" | "artist" | "album" | "playlist";

export interface SearchRowItem {
  [key: string]: any;
  _type: SearchRowKind;
  id: string;
  title: string;
  coverUrl: string;
  artists: string;
}

function coverOf(item: { cover?: { url: string }; coverUrl?: string }): string {
  return item.cover ? mediaUrl(item.cover.url) : (item.coverUrl ?? "");
}

/** useSearchAll's mixed results, normalised for the page's blocks. */
export function mapSearchAllItems(items: ApiSearchItem[]): SearchRowItem[] {
  return items.map((item: any) => {
    const coverUrl = coverOf(item);
    if (item.type === "track") {
      const clientTrack = toClientTrack(item);
      return {
        ...clientTrack,
        ...item,
        _type: "track",
        coverUrl: clientTrack.coverUrl || coverUrl,
        artists: clientTrack.artists,
        artistId: clientTrack.artistId,
        artistList: clientTrack.artistList,
      };
    }
    if (item.type === "artist") {
      return {
        ...item,
        _type: "artist",
        title: item.name,
        coverUrl: toMaxQualityAvatarUrl(coverUrl),
        artists: "",
      };
    }
    if (item.type === "album") {
      return {
        ...item,
        _type: "album",
        coverUrl,
        artists: Array.isArray(item.artists)
          ? item.artists.map((a: any) => a.name).join(", ")
          : (item.artists ?? ""),
        artistId: item.artists?.[0]?.id,
        artistList: Array.isArray(item.artists)
          ? item.artists.map((a: any) => ({ id: a.id, name: a.name }))
          : undefined,
      };
    }
    return {
      ...item,
      _type: item.type,
      coverUrl,
      artists: item.author ?? item.artists ?? "",
      artistId: item.artists?.[0]?.id,
      artistList: Array.isArray(item.artists)
        ? item.artists.map((a: any) => ({ id: a.id, name: a.name }))
        : undefined,
    };
  });
}

/** useSearchTracks' typed results, normalised the same way. */
export function mapSearchTrackItems(tracks: Track[]): SearchRowItem[] {
  return tracks.map((t: any) => {
    const clientTrack = toClientTrack(t);
    return {
      ...clientTrack,
      ...t,
      _type: "track",
      coverUrl: clientTrack.coverUrl || coverOf(t),
      artists: clientTrack.artists,
      artistId: clientTrack.artistId,
      artistList: clientTrack.artistList,
    };
  });
}

/** useSearchArtists' typed results, normalised the same way. */
export function mapSearchArtistItems(artists: any[]): SearchRowItem[] {
  return artists.map((a: any) => ({
    ...a,
    _type: "artist",
    title: a.name,
    coverUrl: toMaxQualityAvatarUrl(coverOf(a)),
  }));
}

/** useSearchAlbums' typed results, normalised the same way. */
export function mapSearchAlbumItems(albums: any[]): SearchRowItem[] {
  return albums.map((a: any) => ({
    ...a,
    _type: "album",
    coverUrl: coverOf(a),
    artists: Array.isArray(a.artists)
      ? a.artists.map((ar: any) => ar.name).join(", ")
      : (a.artists ?? ""),
    artistId: a.artists?.[0]?.id,
    artistList: Array.isArray(a.artists)
      ? a.artists.map((ar: any) => ({ id: ar.id, name: ar.name }))
      : undefined,
  }));
}

/** useSearchPlaylists' typed results, normalised the same way. */
export function mapSearchPlaylistItems(playlists: any[]): SearchRowItem[] {
  return playlists.map((p: any) => ({
    ...p,
    _type: "playlist",
    coverUrl: coverOf(p),
  }));
}

export interface SearchBlocks {
  tracks: SearchRowItem[];
  artists: SearchRowItem[];
  albums: SearchRowItem[];
  playlists: SearchRowItem[];
}

export function partitionSearchRows(rows: SearchRowItem[]): SearchBlocks {
  return {
    tracks: rows.filter((row) => row._type === "track"),
    artists: rows.filter((row) => row._type === "artist"),
    albums: rows.filter((row) => row._type === "album"),
    playlists: rows.filter((row) => row._type === "playlist"),
  };
}

export function formatSearchDuration(durationMs?: number): string {
  if (!durationMs) return "";
  const mins = Math.floor(durationMs / 60000);
  const secs = Math.floor((durationMs % 60000) / 1000)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
}

/**
 * Provenance, scoped to what the data proves: the client's own
 * catalogue router treats an `sc:`/`sc_` id as SoundCloud
 * deterministically, so that shape is a proven source. Every other
 * id may be a YouTube item or a server-filed one — the response
 * carries no source field — so no badge is claimed for it.
 */
export function provenSourceLabel(id: string): "SoundCloud" | undefined {
  return isSoundCloudCatalogId(id) ? "SoundCloud" : undefined;
}
