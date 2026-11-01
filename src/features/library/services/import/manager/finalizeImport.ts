import { api, ApiError } from "@/shared/api";
import type { Track } from "@/shared/contracts";

const FALLBACK_CONCURRENCY = 4;

export interface FinalizedPlaylist {
  playlistId: string;
  saved: number;
  /** Tracks that could not be saved, named — a save failure is never silent and never fatal to the rest. */
  failedTracks: Track[];
}

function uniqueTracks(tracks: Track[]): Track[] {
  return [
    ...new Map(
      tracks
        .filter((track) => Boolean(track?.id))
        .map((track) => [track.id, track] as const),
    ).values(),
  ];
}

async function addOneByOne(
  playlistId: string,
  tracks: Track[],
): Promise<{ saved: number; failedTracks: Track[] }> {
  let saved = 0;
  const failedTracks: Track[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < tracks.length) {
      const track = tracks[cursor++];
      try {
        await api.addPlaylistTrack(playlistId, track.id, track);
        saved += 1;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          saved += 1;
        } else {
          failedTracks.push(track);
        }
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(FALLBACK_CONCURRENCY, tracks.length) },
      worker,
    ),
  );
  return { saved, failedTracks };
}

async function addTracks(
  playlistId: string,
  tracks: Track[],
): Promise<{ saved: number; failedTracks: Track[] }> {
  try {
    const result = await api.addPlaylistTrackSnapshots(playlistId, tracks);
    if (result.added >= tracks.length)
      return { saved: result.added, failedTracks: [] };
    // The batch claims a partial save but cannot say which tracks
    // landed; settle it per track instead of guessing or failing.
    return addOneByOne(playlistId, tracks);
  } catch {
    // Any batch failure degrades to per-track saving: one bad song
    // (or one bad batch) must never orphan the whole playlist.
    return addOneByOne(playlistId, tracks);
  }
}

export async function finalizeImportedPlaylist(
  title: string,
  description: string | undefined,
  tracks: Track[],
): Promise<FinalizedPlaylist> {
  const playlist = await api.createPlaylist({
    title: title.trim().slice(0, 200) || "Imported playlist",
    ...(description?.trim()
      ? { description: description.trim().slice(0, 2000) }
      : {}),
  });
  const unique = uniqueTracks(tracks);
  const { saved, failedTracks } =
    unique.length > 0
      ? await addTracks(playlist.id, unique)
      : { saved: 0, failedTracks: [] as Track[] };
  return { playlistId: playlist.id, saved, failedTracks };
}
