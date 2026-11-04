import { useCallback, useEffect, useState } from "react";
import { api, mediaUrl, toClientTrack } from "@/shared/api";
import { queryCache } from "@/shared/cache/queryCache";
import type { Track } from "@/shared/types";
import { YOUTUBE_THUMBNAIL_HOST } from "@/shared/youtube";
import { getDailyMixArtists } from "@/features/home/hooks/useDailyMixes";
import {
  isLocalMixId,
  resolveLocalMixCollection,
} from "../lib/localMixResolver";
import {
  classifyCollectionLoadError,
  type CollectionLoadError,
} from "../lib/collectionLoadError";

export type { CollectionLoadError } from "../lib/collectionLoadError";

export interface CollectionPageData {
  type?: "playlist" | "album";
  title: string;
  author?: string;
  artists?: { id: string; name: string }[];
  description?: string;
  year?: number;
  coverUrl: string;
  tracks: Track[];
  isDailyMix?: boolean;
}

const COLLECTION_STALE_MS = 5 * 60 * 1000;

// Exported for tests; the hook and the prefetcher below are the
// only production callers.
export async function loadCollection(
  type: string,
  id: string,
): Promise<CollectionPageData> {
  const decodedId = id ? decodeURIComponent(id) : "";

  // Local For You mixes (`mix:…`) exist only on-device: resolve
  // them from the day's snapshot and the local universe, never
  // from the server (see lib/localMixResolver).
  if (type === "playlist" && isLocalMixId(decodedId)) {
    return resolveLocalMixCollection(decodedId);
  }

  const isDailyMix =
    decodedId.startsWith("daily-mix") ||
    decodedId.startsWith("mix-") ||
    id.startsWith("daily-mix") ||
    id.startsWith("mix-");

  if (type === "playlist" && isDailyMix) {
    const mixesRes = await api.getDailyMixes();
    const found = mixesRes.items?.find(
      (m) => m.id === id || m.id === decodedId,
    );
    if (found) {
      const clientTracks = (found.tracks || []).map((t) => toClientTrack(t));
      const primaryCover = found.cover?.url
        ? mediaUrl(found.cover.url)
        : clientTracks[0]?.coverUrl || clientTracks[1]?.coverUrl || "";
      const computedArtists = getDailyMixArtists(
        found.clusterArtists,
        clientTracks,
        4,
      );
      const formatted: CollectionPageData = {
        type: "playlist",
        title: found.title,
        author:
          computedArtists.length > 0 ? computedArtists.join(", ") : "Daily Mix",
        description: found.description,
        coverUrl: primaryCover,
        tracks: clientTracks,
        isDailyMix: true,
      };
      return formatted;
    }
  }

  const collection =
    type === "playlist" ? await api.getPlaylist(id) : await api.getAlbum(id);

  if (
    (collection as any).playlist &&
    Array.isArray((collection as any).items)
  ) {
    const userPlaylist = (collection as any).playlist;
    const userItems = (collection as any).items as any[];
    const covers = userItems
      .map((i) => (i.track?.cover ? mediaUrl(i.track.cover.url) : ""))
      .filter(Boolean)
      .filter((url, idx, arr) => arr.indexOf(url) === idx)
      .slice(0, 4);
    const tracks: Track[] = userItems.map((item) => toClientTrack(item.track));
    const ownerName =
      userPlaylist.owner?.displayName || userPlaylist.owner?.username || "";
    const formatted: CollectionPageData = {
      type: "playlist",
      title: userPlaylist.title,
      author: ownerName || undefined,
      description: userPlaylist.description || undefined,
      coverUrl: covers[0] || "",
      tracks,
    };
    return formatted;
  }

  const collectionCoverUrl = collection.cover
    ? mediaUrl(collection.cover.url)
    : "";
  const tracks = (collection.tracks || []).map((t: any) => {
    const clientTrack = toClientTrack(t);
    let updated = clientTrack;
    if (collection.type === "album") {
      const albumData = {
        id: decodedId,
        title: collection.title,
      };
      updated = {
        ...updated,
        album: updated.album?.id ? updated.album : albumData,
      };
      if (
        collectionCoverUrl &&
        (!updated.coverUrl || updated.coverUrl.includes(YOUTUBE_THUMBNAIL_HOST))
      ) {
        updated = { ...updated, coverUrl: collectionCoverUrl };
      }
    }
    return updated;
  });

  const formatted: CollectionPageData = {
    type: collection.type,
    title: collection.title,
    author: collection.type === "playlist" ? collection.author : undefined,
    artists: collection.type === "album" ? collection.artists : undefined,
    description: (collection as any).description,
    year: collection.year,
    coverUrl: collectionCoverUrl,
    tracks,
  };
  return formatted;
}

export function prefetchCollection(type: string, id: string): void {
  const cacheKey = `collection:${type}:${id}`;
  if (queryCache.get(cacheKey)) return;
  void queryCache
    .fetchWithSwr(cacheKey, () => loadCollection(type, id), {
      staleTimeMs: COLLECTION_STALE_MS,
    })
    .catch(() => undefined);
}

export function useCollection(type: string | null, id: string | null) {
  const cacheKey = type && id ? `collection:${type}:${id}` : null;
  const cached = cacheKey
    ? queryCache.get<CollectionPageData>(cacheKey)
    : undefined;
  const [data, setData] = useState<CollectionPageData | null>(cached ?? null);
  const [loading, setLoading] = useState<boolean>(
    !cached && Boolean(type && id),
  );
  // Why a load ended with nothing to show: a genuine not-found
  // vs a failure worth retrying (see lib/collectionLoadError).
  // Null whenever data is on screen or a load is in flight — a
  // failed background revalidation of cached data stays silent,
  // exactly as before.
  const [error, setError] = useState<CollectionLoadError | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Re-runs the same SWR fetch (the failure state's way back).
  const refetch = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!type || !id || !cacheKey) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const initial = queryCache.get<CollectionPageData>(cacheKey);
    if (initial) {
      setData(initial);
      setLoading(false);
      setError(null);
    } else {
      setData(null);
      setLoading(true);
      setError(null);
    }

    let active = true;

    const unsubscribe = queryCache.subscribe<CollectionPageData>(
      cacheKey,
      (updated) => {
        if (active) {
          setData(updated);
          setLoading(false);
          setError(null);
        }
      },
    );

    void queryCache
      .fetchWithSwr(cacheKey, () => loadCollection(type, id), {
        staleTimeMs: COLLECTION_STALE_MS,
      })
      .then(({ data: result }) => {
        if (active) {
          setData(result);
          setLoading(false);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (active && !queryCache.get(cacheKey)) {
          setData(null);
          setLoading(false);
          setError(classifyCollectionLoadError(err));
        }
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [type, id, cacheKey, attempt]);

  return { data, loading, error, refetch };
}
