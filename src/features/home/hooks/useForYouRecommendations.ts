import { useMemo } from "react";
import { api, toClientTrack } from "@/shared/api";
import type { Track } from "@/shared/types";
import { freshFor, useCachedResource } from "@/shared/cache/useCachedResource";
import { useLikedTracks } from "@/features/library/hooks";
import { allInUseGenreLabels } from "@/features/genres/playlistGenreStore";
import { getTasteProfile } from "@/features/mixer/engine/tasteTracker";
import { decayProfile } from "@/features/mixer/engine/tasteProfile";
import { loadWithRetry, useSessionOwner } from "./sessionAwareLoad";
import {
  EMPTY_SEEDS,
  apiRecommendationClient,
  loadRecommendationRows,
  selectRecommendationSeeds,
  type RecommendationRow,
} from "../lib/recommendations";

// The For You feed's server-recommendations hook (user ruling,
// 2026-11-03): catalogue discovery rows seeded by the listener's
// own taste — see lib/recommendations for the audit and the
// honesty rules. This hook only gathers the seed evidence (server
// history, liked tracks, the taste profile, Playlist Genre labels)
// and runs the loader behind the house SWR cache.
//
// Failure honesty: nothing here can fail the page. A guest gets no
// rows and makes no calls; thin taste gets no rows; a dead server
// gets no rows — in every case the local feed renders exactly as
// it did before this layer existed. There is deliberately no error
// surface: absence is the error state.

export interface ForYouRecommendationsData {
  rows: RecommendationRow[];
  isLoading: boolean;
}

const HISTORY_WINDOW = 100;
const EMPTY_TRACKS: Track[] = [];
const EMPTY_ROWS: RecommendationRow[] = [];

// Recommendations are a daily surface (like the mixes): a day's
// rows are fetched once and stay fresh for hours, and the cache
// key carries the date and the taste profile's own clock, so a
// new day — or a day of new listening — is what refreshes them,
// never a re-render.
const EVIDENCE_POLICY = {
  isFresh: freshFor(60_000),
  revalidateOnFocus: true,
};
const ROWS_POLICY = {
  isFresh: freshFor(12 * 60 * 60_000),
  revalidateOnFocus: false,
};

async function loadRecoHistory(): Promise<Track[]> {
  const res = await loadWithRetry(
    () => api.getHistory(undefined, HISTORY_WINDOW),
    () => true,
  );
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (const entry of res.items ?? []) {
    if (!entry.track?.id || seen.has(entry.track.id)) continue;
    seen.add(entry.track.id);
    tracks.push(toClientTrack(entry.track));
  }
  return tracks;
}

export function useForYouRecommendations(): ForYouRecommendationsData {
  const owner = useSessionOwner();
  const { data: historyData } = useCachedResource(
    `home:for-you-reco-history:${owner}`,
    // Guests have no server history and make no calls at all.
    () => (owner ? loadRecoHistory() : Promise.resolve(EMPTY_TRACKS)),
    EVIDENCE_POLICY,
  );
  const { data: likedData, isLoading: likedLoading } = useLikedTracks();

  const heard = historyData ?? EMPTY_TRACKS;
  const liked = likedData?.tracks ?? EMPTY_TRACKS;

  const now = Date.now();
  const dateKey = new Date(now).toDateString();
  const agedProfile = decayProfile(getTasteProfile(), now);

  const seeds = useMemo(
    () =>
      owner
        ? selectRecommendationSeeds({
            profile: agedProfile,
            heard,
            liked,
            genreLabels: allInUseGenreLabels(),
            nowMs: now,
          })
        : EMPTY_SEEDS,
    // The profile read is render-time (as in useForYouCandidates);
    // its own clock is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [owner, heard, liked, agedProfile.updatedAtMs],
  );

  const knownIds = useMemo(() => {
    const ids = new Set<string>();
    for (const track of heard) ids.add(track.id);
    for (const track of liked) ids.add(track.id);
    // The taste profile's own track evidence counts as known: a
    // track the listener has heard through the DJ may sit outside
    // the history window, and it is still not new to them.
    for (const id of Object.keys(agedProfile.tracks)) ids.add(id);
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heard, liked, agedProfile.updatedAtMs]);

  const active =
    owner !== "" &&
    (seeds.radioSeeds.length > 0 ||
      seeds.artistSeeds.length > 0 ||
      seeds.genreSeeds.length > 0);

  const { data: rowsData, isLoading } = useCachedResource(
    active
      ? `home:for-you-reco-rows:${owner}:${dateKey}:${agedProfile.updatedAtMs}`
      : "home:for-you-reco-rows:idle",
    () =>
      active
        ? loadRecommendationRows(seeds, knownIds, apiRecommendationClient)
        : Promise.resolve(EMPTY_ROWS),
    ROWS_POLICY,
  );

  return {
    rows: rowsData ?? EMPTY_ROWS,
    isLoading: active && (isLoading || likedLoading),
  };
}
