import { useEffect, useState } from "react";
import { queryCache } from "@/shared/cache/queryCache";
import { api, toClientTrack } from "@/shared/api";
import type { SearchResponse } from "@/shared/contracts";
import type { Track } from "@/shared/types";

// "Appears on" for the artist page, as an honest derivation from
// the catalogue's own data — there is no appearances feed in any
// source the app queries. The derivation: run the catalogue's own
// track search for the artist's name, and keep only the tracks
// where the catalogue itself credits THIS artist's id in a
// non-lead slot of the track's artist list (a feature, a
// collaboration, a co-billing). Name-only mentions never count —
// the credit must carry the artist's catalogue id — so the list
// can understate (unlinked feature credits are invisible to it)
// but can never invent an appearance.

const APPEARANCES_LIMIT = 25;
const APPEARANCES_STALE_MS = 10 * 60 * 1000;

export function selectAppearances(
  items: SearchResponse["items"],
  artistId: string,
): Track[] {
  const appearances: Track[] = [];
  for (const item of items) {
    if (item.type !== "track") continue;
    const creditedAt = item.artists.findIndex(
      (artist) => artist.id === artistId,
    );
    // -1: not credited. 0: the lead artist — that's the artist's
    // own billing, not an appearance on someone else's track.
    if (creditedAt <= 0) continue;
    appearances.push(toClientTrack(item));
    if (appearances.length >= APPEARANCES_LIMIT) break;
  }
  return appearances;
}

async function loadAppearances(
  artistId: string,
  artistName: string,
): Promise<Track[]> {
  const response = await api.search(artistName, "track");
  return selectAppearances(response.items, artistId);
}

function appearancesCacheKey(id: string): string {
  return `artist-appearances:${id}`;
}

export function useArtistAppearances(
  artistId: string | null,
  artistName: string | null,
) {
  const cacheKey = artistId ? appearancesCacheKey(artistId) : null;
  const cached = cacheKey ? queryCache.get<Track[]>(cacheKey) : undefined;
  const [data, setData] = useState<Track[] | null>(cached ?? null);
  const [loading, setLoading] = useState<boolean>(!cached && Boolean(artistId));

  useEffect(() => {
    if (!artistId || !artistName || !cacheKey) {
      setData(null);
      setLoading(false);
      return;
    }
    const initial = queryCache.get<Track[]>(cacheKey);
    setData(initial ?? null);
    setLoading(!initial);

    let active = true;
    const unsubscribe = queryCache.subscribe<Track[]>(cacheKey, (updated) => {
      if (!active) return;
      setData(updated);
      setLoading(false);
    });
    void queryCache
      .fetchWithSwr(cacheKey, () => loadAppearances(artistId, artistName), {
        staleTimeMs: APPEARANCES_STALE_MS,
      })
      .then(({ data: result }) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch(() => {
        if (!active || queryCache.get(cacheKey)) return;
        setData(null);
        setLoading(false);
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [artistId, artistName, cacheKey]);

  return { data, loading };
}
