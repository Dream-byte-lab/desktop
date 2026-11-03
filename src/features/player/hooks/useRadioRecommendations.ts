import { useEffect, useState } from "react";
import { api, toClientTrack } from "@/shared/api";
import type { Track } from "@/shared/types/track";

/**
 * The full-screen lyrics view's Recommended tab: radio seeded by the
 * track on the decks right now (`api.getRadio` — the client's real
 * similarity mechanism, the same one the For You recommendations
 * layer builds on). Results are cached per seed for the session so
 * flipping between tabs never re-asks the server, and a failure
 * simply yields the tab's empty state — no retry storm, no filler.
 */

const MAX_RECOMMENDATIONS = 12;

const cache = new Map<string, Track[]>();

export interface RadioRecommendations {
  tracks: Track[];
  loading: boolean;
  failed: boolean;
}

export function useRadioRecommendations(
  seedTrackId: string | undefined,
): RadioRecommendations {
  const [state, setState] = useState<RadioRecommendations>(() => ({
    tracks: seedTrackId ? (cache.get(seedTrackId) ?? []) : [],
    loading: Boolean(seedTrackId && !cache.has(seedTrackId)),
    failed: false,
  }));

  useEffect(() => {
    if (!seedTrackId) {
      setState({ tracks: [], loading: false, failed: false });
      return;
    }
    const cached = cache.get(seedTrackId);
    if (cached) {
      setState({ tracks: cached, loading: false, failed: false });
      return;
    }
    let cancelled = false;
    setState({ tracks: [], loading: true, failed: false });
    api
      .getRadio(seedTrackId, { history: [seedTrackId], k: 24 })
      .then((response) => {
        if (cancelled) return;
        const tracks = (response.items ?? [])
          .map((item) => toClientTrack(item))
          .filter((track) => track.id !== seedTrackId)
          .slice(0, MAX_RECOMMENDATIONS);
        cache.set(seedTrackId, tracks);
        setState({ tracks, loading: false, failed: false });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ tracks: [], loading: false, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [seedTrackId]);

  return state;
}
