import { useMemo } from "react";
import { useLikedTracks } from "./useLikedTracks";
import type { Track } from "@/shared/types";

/**
 * Liked-id sets are shared across every row: one Set is built per
 * tracks-array identity and reused by all useIsTrackLiked callers,
 * instead of each row scanning the whole list with .some().
 */
const likedIdSets = new WeakMap<Track[], Set<string>>();

export function likedIdSet(tracks: Track[]): Set<string> {
  let set = likedIdSets.get(tracks);
  if (!set) {
    set = new Set(tracks.map((t) => t.id));
    likedIdSets.set(tracks, set);
  }
  return set;
}

export function useIsTrackLiked(trackId: string | undefined): boolean {
  const { data } = useLikedTracks();
  const tracks = data?.tracks;
  return useMemo(() => {
    if (!trackId || !tracks) return false;
    return likedIdSet(tracks).has(trackId);
  }, [trackId, tracks]);
}
