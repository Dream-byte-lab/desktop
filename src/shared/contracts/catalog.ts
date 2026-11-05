import type { Cover } from "./cover";
import type { Track, ApiTrack } from "./track";

export type SearchType = "all" | "track" | "artist" | "album" | "playlist";

export const SEARCH_TYPES: readonly SearchType[] = [
  "all",
  "track",
  "artist",
  "album",
  "playlist",
];

export interface SearchArtistItem {
  type: "artist";
  id: string;
  name: string;
  cover?: Cover;
}

export interface SearchAlbumItem {
  type: "album";
  id: string;
  title: string;
  artists: { id: string; name: string }[];
  year?: number;
  cover?: Cover;
}

export interface SearchPlaylistItem {
  type: "playlist";
  id: string;
  title: string;
  author?: string;
  cover?: Cover;
}

export type SearchResult =
  | (Track & { type: "track"; viewer?: { liked: boolean } })
  | SearchArtistItem
  | SearchAlbumItem
  | SearchPlaylistItem;

export type ApiSearchItem = SearchResult;
export type SearchResponse = { items: ApiSearchItem[] };
export type ApiArtist = SearchArtistItem;
export type ApiAlbum = SearchAlbumItem;
export type ApiPlaylist = SearchPlaylistItem;

export interface ArtistAlbum {
  id: string;
  title: string;
  year?: number;
  cover?: Cover;
  explicit?: boolean;
  totalTracks?: number;
  trackCount?: number;
}

export type ApiArtistAlbum = ArtistAlbum;

export interface ArtistRelease extends ArtistAlbum {
  releaseType: "single" | "ep";
}

export type ApiArtistRelease = ArtistRelease;

export interface ArtistDetails {
  type: "artist";
  id: string;
  name: string;
  bio?: string;
  cover?: Cover;
  monthlyListeners?: string;
  followers?: number;
  verified: boolean;
  geniusImageUrl?: string;
  geniusAka?: string[];
  geniusUsername?: string;
  tracks: ApiTrack[];
  albums: ArtistAlbum[];
  singles: ArtistRelease[];
  /** The catalogue's own similar artists, when it supplies any. */
  similarArtists?: SimilarArtistItem[];
  /** Provenance of similarArtists — see SimilarArtistItem. */
  similarArtistsBasis?: SimilarArtistsBasis;
}

export type ApiArtistDetails = ArtistDetails;

/**
 * An artist the catalogue itself puts next to this one. Two
 * provenances exist, told apart by SimilarArtistsBasis:
 *  - "fans": the source presented the list as its own
 *    fans/similar shelf inside the artist payload (YouTube's
 *    "Fans might also like" carousel) — the entries are the
 *    source's listener-derived similar artists.
 *  - "related": derived on the client from the source's own
 *    related-tracks graph (the tracks its radio/related endpoints
 *    pair with this artist's songs), ranked by how often each
 *    artist appears there. Never fan data; the UI labels it
 *    "Similar artists", never "Fans also like".
 */
export interface SimilarArtistItem {
  id: string;
  name: string;
  cover?: Cover;
}

export type SimilarArtistsBasis = "fans" | "related";

export interface AlbumDetails {
  type: "album";
  id: string;
  title: string;
  artists: { id: string; name: string }[];
  year?: number;
  cover?: Cover;
  trackCount?: number;
  durationMs?: number;
  tracks: ApiTrack[];
}

export type ApiAlbumDetails = AlbumDetails;

export interface CatalogPlaylistDetails {
  type: "playlist";
  id: string;
  title: string;
  author?: string;
  description?: string;
  year?: number;
  cover?: Cover;
  trackCount?: number;
  durationMs?: number;
  tracks: ApiTrack[];
}

export type ApiCatalogPlaylistDetails = CatalogPlaylistDetails;

export interface RadioTrack {
  id: string;
  title: string;
  artists: { id: string; name: string }[];
  album?: { id: string; title: string };
  durationMs: number;
  cover?: Cover;
  explicit?: boolean;
}

export type ApiRadioTrack = RadioTrack;
export type RadioResponse = { items: ApiRadioTrack[] };
