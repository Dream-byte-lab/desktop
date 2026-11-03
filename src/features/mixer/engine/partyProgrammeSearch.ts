import { api, toClientTrack, type ApiTrack } from "@/shared/api";
import type { Track } from "@/shared/types";
import type { PartyTrackListing } from "../../../../electron/liverave/types";

// Step 6's renderer half of the widened request door: the
// programme's own search, run on the host's machine for a guest.
// The party host asks this module when the server relays a guest's
// search; the listings it returns are what the server then vouches
// for as requestable, and the full tracks stay cached here-side
// (in the host) so an accepted request resolves to a playable
// track the session can prepare.
//
// Dedup is by exact track id only — the same recording under two
// ids is two results. Merging look-alikes by title or artist is
// recording-identity work and is deliberately NOT done here.

/** How many programme results one guest search may surface. */
export const PROGRAMME_SEARCH_LIMIT = 25;

/** Searches the whole programme for tracks, as the app itself does. */
export async function searchProgrammeTracks(query: string): Promise<Track[]> {
  const res = await api.search(query, "track");
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (const item of res.items) {
    if (item.type !== "track") continue;
    const track = toClientTrack(item as ApiTrack & { type: "track" });
    if (!track.id || seen.has(track.id)) continue;
    seen.add(track.id);
    tracks.push(track);
    if (tracks.length >= PROGRAMME_SEARCH_LIMIT) break;
  }
  return tracks;
}

/** The guest-facing listings for programme tracks, source-stamped. */
export function searchListings(tracks: readonly Track[]): PartyTrackListing[] {
  return tracks.map((track) => ({
    id: track.id,
    title: track.title,
    artist: track.artists,
    source: "search" as const,
  }));
}
