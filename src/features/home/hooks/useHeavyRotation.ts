import { api, toClientTrack } from "@/shared/api";
import type { Track } from "@/shared/types";
import type { PopularItem } from "./usePopularTracks";
import { loadWithRetry, useSessionOwner } from "./sessionAwareLoad";
import { freshFor, useCachedResource } from "@/shared/cache/useCachedResource";
import { getTasteProfile } from "@/features/mixer/engine/tasteTracker";
import { decayProfile } from "@/features/mixer/engine/tasteProfile";

// Heavy rotation: the tracks this listener actually plays the most,
// ranked by their own evidence — never a global chart.
//
// The taste profile (liner_taste_profile_v1, fed by the DJ session)
// stores decayed weights per track id, but no metadata: a weight
// alone cannot be played or drawn. So the candidates come from the
// listener's own server history (the last 100 plays), which carries
// full track metadata, and the profile only RANKS them:
//
// - When the profile holds real signal (>= MIN_TASTE_SIGNAL tracks
//   with positive decayed weight among the candidates), those tracks
//   lead, ordered by weight.
// - Otherwise the rail falls back to plain history frequency:
//   tracks played at least twice, most-played first.
// - With neither, there is no rail — Home shows nothing rather than
//   borrowing anyone else's listening.

const EMPTY_ITEMS: PopularItem[] = [];
const HEAVY_POLICY = { isFresh: freshFor(60_000), revalidateOnFocus: true };
const HISTORY_WINDOW = 100;
const MIN_TASTE_SIGNAL = 4;

export interface HeardTrack {
  track: Track;
  /** How many times it appears in the history window. */
  plays: number;
  /** Index of its most recent play (0 = most recent). */
  lastIndex: number;
}

export function rankHeavyRotation(
  heard: HeardTrack[],
  tasteWeights: Record<string, number>,
  limit: number,
): PopularItem[] {
  const tasted = heard.filter(
    (entry) => (tasteWeights[entry.track.id] ?? 0) > 0,
  );
  let ranked: HeardTrack[];
  if (tasted.length >= MIN_TASTE_SIGNAL) {
    ranked = [...tasted].sort(
      (a, b) =>
        (tasteWeights[b.track.id] ?? 0) - (tasteWeights[a.track.id] ?? 0) ||
        b.plays - a.plays ||
        a.lastIndex - b.lastIndex,
    );
  } else {
    const repeated = heard.filter((entry) => entry.plays >= 2);
    if (repeated.length === 0) return EMPTY_ITEMS;
    ranked = [...repeated].sort(
      (a, b) =>
        b.plays - a.plays ||
        (tasteWeights[b.track.id] ?? 0) - (tasteWeights[a.track.id] ?? 0) ||
        a.lastIndex - b.lastIndex,
    );
  }
  return ranked.slice(0, limit).map((entry) => ({
    type: "track" as const,
    item: entry.track,
    playCount: entry.plays,
  }));
}

async function loadHeavyRotation(limit: number): Promise<PopularItem[]> {
  const res = await loadWithRetry(
    () => api.getHistory(undefined, HISTORY_WINDOW),
    () => true,
  );
  const byId = new Map<string, HeardTrack>();
  (res.items ?? []).forEach((entry, index) => {
    if (!entry.track?.id) return;
    const track = toClientTrack(entry.track);
    const existing = byId.get(track.id);
    if (existing) {
      existing.plays += 1;
    } else {
      byId.set(track.id, { track, plays: 1, lastIndex: index });
    }
  });
  const aged = decayProfile(getTasteProfile(), Date.now());
  return rankHeavyRotation([...byId.values()], aged.tracks, limit);
}

export function useHeavyRotation(limit = 20) {
  const owner = useSessionOwner();
  const { data, isLoading } = useCachedResource(
    `home:heavy-rotation:${owner}:${limit}`,
    // Guests have no listening history on the server — skip the call
    // entirely instead of failing against an account-only endpoint.
    () => (owner ? loadHeavyRotation(limit) : Promise.resolve(EMPTY_ITEMS)),
    HEAVY_POLICY,
  );
  return { data: data ?? EMPTY_ITEMS, isLoading };
}
