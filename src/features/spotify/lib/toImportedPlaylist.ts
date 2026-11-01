import type { ClientImportedPlaylist } from "@/features/library/services/import/importTypes";
import type {
  SpotifyPlaylistSummary,
  SpotifyPlaylistTracks,
} from "./spotifyApi";

// Maps what the official API returns onto the exact contract
// Liner's import pipeline already consumes — the same shape the
// paste-a-link import produces — so an account import flows through
// the identical matching, review and playlist-creation machinery.
// Nothing is matched or saved here; this is translation only.
// Note what an import is: the list, not Spotify's audio. Playback
// still comes from Liner's own sources, matched per track.

export function toImportedPlaylist(
  summary: SpotifyPlaylistSummary,
  tracks: SpotifyPlaylistTracks,
): ClientImportedPlaylist {
  return {
    source: "spotify",
    sourceUrl: `https://open.spotify.com/playlist/${summary.id}`,
    title: summary.name,
    ...(summary.description ? { description: summary.description } : {}),
    tracks: tracks.tracks.map((track) => ({
      sourceId: track.id,
      title: track.title,
      artists: track.artists,
      album: track.album,
      durationMs: track.durationMs,
      ...(track.coverUrl ? { coverUrl: track.coverUrl } : {}),
    })),
  };
}
