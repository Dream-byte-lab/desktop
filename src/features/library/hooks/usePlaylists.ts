import { useEffect, useState, useSyncExternalStore } from "react";
import {
  api,
  getAuthSession,
  mediaUrl,
  toClientTrack,
  type ApiUserPlaylist,
  type ApiUserPlaylistItem,
} from "@/shared/api";
import { queryCache } from "@/shared/cache/queryCache";
import { recordPlaylistTracks } from "@/features/genres/trackGenres";
import {
  applyCustomCover,
  getCustomCover,
  subscribePlaylistIdentity,
} from "../lib/playlistIdentity";
import type { Track } from "@/shared/types";

export interface LibraryPlaylistSummary {
  id: string;
  title: string;
  description?: string;
  trackCount: number;
  coverUrl: string;
  coverUrls: string[];
  updatedAt: string;
  createdAt: string;
  revision: number;
}

export interface LibraryPlaylistDetail {
  id: string;
  title: string;
  description?: string;
  trackCount: number;
  coverUrl: string;
  coverUrls: string[];
  revision: number;
  tracks: Track[];
  durationMs?: number;
  partial?: boolean;
}

const FIRST_PAGE_SIZE = 100;

type PlaylistList = { playlists: LibraryPlaylistSummary[]; total: number };

const COVER_CACHE_KEY = "liner:playlist-covers-v2";
type CoverCacheEntry = {
  coverUrls: string[];
  trackCount: number;
  updatedAt: string;
};
type CoverCache = Record<string, CoverCacheEntry>;

function readCoverCache(): CoverCache {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(COVER_CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeCoverCache(c: CoverCache) {
  try {
    localStorage.setItem(COVER_CACHE_KEY, JSON.stringify(c));
  } catch {}
}

function extractCovers(items: ApiUserPlaylistItem[]): string[] {
  return items
    .map((i) => (i.track.cover ? mediaUrl(i.track.cover.url) : ""))
    .filter(Boolean)
    .filter((url, idx, arr) => arr.indexOf(url) === idx)
    .slice(0, 4);
}

const EMPTY: PlaylistList = { playlists: [], total: 0 };
let cache = EMPTY;
// Derived (server/track-art) covers per playlist id, remembered at
// load time so a custom-cover change can be applied — and, on reset,
// the derived cover restored — without refetching. The summaries in
// `cache` are the single choke point every playlist surface reads
// (library grid/list, Home Your Playlists, Add-to-Playlist lists,
// playlist page preview), so the local custom-cover overlay is
// applied here and nowhere else needs to know it exists.
const derivedCovers = new Map<
  string,
  { coverUrl: string; coverUrls: string[] }
>();

function withCustomCover(
  summary: LibraryPlaylistSummary,
): LibraryPlaylistSummary {
  derivedCovers.set(summary.id, {
    coverUrl: summary.coverUrl,
    coverUrls: summary.coverUrls,
  });
  return applyCustomCover(summary);
}
let loaded = false;
let request: Promise<void> | null = null;
const listeners = new Set<() => void>();
let view = { data: cache, error: undefined as unknown, isLoading: true };

export function notifyLibraryChanged() {
  window.dispatchEvent(new Event("library:changed"));
}

// optimistically drop playlist from store so ui reacts instantly without waiting on network
export function evictPlaylistFromCache(id: string) {
  cache = {
    playlists: cache.playlists.filter((p) => p.id !== id),
    total: Math.max(0, cache.total - 1),
  };
  queryCache.delete(`playlist:detail:${id}`);
  queryCache.delete(`playlist:etag:${id}`);
  emit();
}

function emit(error?: unknown, isLoading = false) {
  view = { data: cache, error, isLoading };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return view;
}

const SERVER_SNAPSHOT = {
  data: EMPTY,
  error: undefined as unknown,
  isLoading: true,
};

function load(force = false): Promise<void> {
  if (request) return request;
  const session = getAuthSession();
  if (!session?.accessToken) {
    cache = EMPTY;
    loaded = false;
    emit();
    return Promise.resolve();
  }
  if (loaded && !force) return Promise.resolve();

  if (!loaded) emit(undefined, true);

  let failure: unknown;
  request = (async () => {
    const coverCache = readCoverCache();
    const response = await api.listPlaylists();

    const playlists = await Promise.all(
      response.items.map(async (playlist) => {
        if (playlist.trackCount !== undefined && playlist.coverUrls) {
          const coverUrls = playlist.coverUrls
            .map((url) => mediaUrl(url))
            .filter(Boolean);
          coverCache[playlist.id] = {
            coverUrls,
            trackCount: playlist.trackCount,
            updatedAt: playlist.updatedAt,
          };
          return withCustomCover({
            ...playlist,
            trackCount: playlist.trackCount,
            coverUrl: coverUrls[0] ?? "",
            coverUrls,
          });
        }

        const cached = coverCache[playlist.id];

        if (cached && cached.updatedAt === playlist.updatedAt) {
          return withCustomCover({
            ...playlist,
            trackCount: cached.trackCount,
            coverUrl: cached.coverUrls[0] ?? "",
            coverUrls: cached.coverUrls,
          });
        }

        const detail = await api.getUserPlaylist(playlist.id);
        const covers = extractCovers(detail.items);
        const entry: CoverCacheEntry = {
          coverUrls: covers,
          trackCount: detail.items.length,
          updatedAt: playlist.updatedAt,
        };
        coverCache[playlist.id] = entry;
        return withCustomCover({
          ...playlist,
          trackCount: detail.items.length,
          coverUrl: covers[0] ?? "",
          coverUrls: covers,
        });
      }),
    );

    const liveIds = new Set(response.items.map((p) => p.id));
    for (const id of Object.keys(coverCache)) {
      if (!liveIds.has(id)) delete coverCache[id];
    }
    writeCoverCache(coverCache);

    cache = { playlists, total: playlists.length };
    loaded = true;
  })()
    .catch((err) => {
      if (!loaded) cache = EMPTY;
      loaded = true;
      failure = err;
    })
    .finally(() => {
      request = null;
      emit(failure);
    });
  return request;
}

if (typeof window !== "undefined") {
  const handleRefresh = () => {
    const session = getAuthSession();
    if (!session?.accessToken) {
      cache = EMPTY;
      loaded = false;
      emit();
    } else {
      void load(true);
    }
  };
  window.addEventListener("library:changed", handleRefresh);
  window.addEventListener("auth:changed", handleRefresh);
}

// A custom cover set/reset re-applies the overlay to the summaries
// already in memory (restoring the remembered derived covers on
// reset) and re-emits, so every surface updates without a refetch.
subscribePlaylistIdentity(() => {
  if (cache.playlists.length === 0) return;
  cache = {
    playlists: cache.playlists.map((summary) => {
      const derived = derivedCovers.get(summary.id);
      const base = derived
        ? {
            ...summary,
            coverUrl: derived.coverUrl,
            coverUrls: derived.coverUrls,
          }
        : summary;
      return applyCustomCover(base);
    }),
    total: cache.total,
  };
  emit();
});

function toTrack(item: ApiUserPlaylistItem): Track {
  const base = toClientTrack(item.track);
  return {
    ...base,
    playlistItemId: item.id,
    addedAt: item.addedAt,
  };
}

export function usePlaylistsList() {
  const state = useSyncExternalStore(
    subscribe,
    snapshot,
    () => SERVER_SNAPSHOT,
  );
  useEffect(() => {
    void load();
  }, []);
  return state;
}

function toDetail(
  playlist: ApiUserPlaylist,
  items: ApiUserPlaylistItem[],
  trackCount: number,
  durationMs: number,
  partial: boolean,
): LibraryPlaylistDetail {
  const covers = extractCovers(items);
  return applyCustomCover({
    id: playlist.id,
    title: playlist.title,
    description: playlist.description,
    trackCount,
    coverUrl: covers[0] ?? "",
    coverUrls: covers,
    revision: playlist.revision,
    tracks: items.map(toTrack),
    durationMs,
    ...(partial ? { partial: true } : {}),
  });
}

function rememberCovers(
  id: string,
  detail: LibraryPlaylistDetail,
  updatedAt: string,
) {
  const coverCache = readCoverCache();
  // The detail may carry the custom-cover overlay; the persistent
  // derived-cover cache must only ever hold derived covers, so when a
  // custom cover is active keep the covers already remembered.
  const custom = getCustomCover(id);
  const derived = derivedCovers.get(id);
  coverCache[id] = {
    coverUrls:
      custom && derived
        ? derived.coverUrls
        : custom
          ? (coverCache[id]?.coverUrls ?? [])
          : detail.coverUrls,
    trackCount: detail.trackCount,
    updatedAt,
  };
  writeCoverCache(coverCache);
}

export function usePlaylist(id: string | null) {
  const cacheKey = id ? `playlist:detail:${id}` : null;
  const cached = cacheKey
    ? queryCache.get<LibraryPlaylistDetail>(cacheKey)
    : undefined;
  const [data, setData] = useState<LibraryPlaylistDetail | null>(
    cached ?? null,
  );
  const [error, setError] = useState<unknown>();
  const [isLoading, setIsLoading] = useState(!cached && Boolean(id));

  useEffect(() => {
    if (!id || !cacheKey) {
      setData(null);
      setIsLoading(false);
      return;
    }

    const initial = queryCache.get<LibraryPlaylistDetail>(cacheKey);
    if (initial) {
      setData(initial);
      setIsLoading(false);
    } else {
      setData(null);
      setIsLoading(true);
    }
    let active = true;

    const etagKey = `playlist:etag:${id}`;
    let complete = false;

    const fetchFirstPage = async () => {
      try {
        const response = await api.readUserPlaylist(id, {
          limit: FIRST_PAGE_SIZE,
        });
        if (!active || complete || response.notModified) return;
        const detail = toDetail(
          response.playlist,
          response.items,
          response.trackCount,
          response.durationMs,
          response.partial,
        );
        // Playlist Genre membership warms from every fetched page: a
        // partial page only adds, a complete one replaces (S5-0).
        recordPlaylistTracks(
          detail.id,
          detail.tracks.map((track) => track.id),
          !response.partial,
        );
        setData(detail);
        setIsLoading(false);
      } catch {}
    };

    const fetchDetail = async (isBackground = false) => {
      if (!isBackground && !queryCache.get(cacheKey)) setIsLoading(true);
      const etag = queryCache.get(cacheKey)
        ? queryCache.get<string>(etagKey)
        : undefined;
      try {
        const response = await api.readUserPlaylist(id, { etag });
        if (!active) return;
        complete = true;
        if (response.notModified) return;

        const detail = toDetail(
          response.playlist,
          response.items,
          response.trackCount,
          response.durationMs,
          false,
        );
        // The full detail fetch is a complete membership record (S5-0).
        recordPlaylistTracks(
          detail.id,
          detail.tracks.map((track) => track.id),
          true,
        );
        rememberCovers(id, detail, response.playlist.updatedAt);
        queryCache.set(cacheKey, detail);
        if (response.etag) queryCache.set(etagKey, response.etag);
        else queryCache.delete(etagKey);
        setData(detail);
        setError(undefined);
      } catch (err) {
        if (active) setError(err);
      } finally {
        if (active) setIsLoading(false);
      }
    };

    if (!initial) void fetchFirstPage();
    void fetchDetail(Boolean(initial));
    const refresh = () => void fetchDetail(true);
    window.addEventListener("library:changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("library:changed", refresh);
    };
  }, [id, cacheKey]);

  return { data, error, isLoading };
}
