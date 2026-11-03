import { useEffect, useSyncExternalStore } from "react";
import { api, getAuthSession, toClientTrack } from "@/shared/api";
import type { Track } from "@/shared/types";

type LikedData = { tracks: Track[]; total: number };
const EMPTY: LikedData = { tracks: [], total: 0 };
let cache: LikedData = EMPTY;
let loaded = false;
let fetchedFromServer = false;
let loadFailed = false;
let request: Promise<void> | null = null;
let queuedReloadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();
let view = { data: cache, isLoading: true, error: false };

/**
 * Stable account identity for liked-tracks work. AuthTokens.user is a
 * PublicUser whose `id` survives token refresh (a refresh mints new
 * access/refresh tokens for the same user), so `user.id` — never a
 * token — is the account key.
 */
export function currentLikedAccountKey(): string | null {
  return getAuthSession()?.user?.id ?? null;
}

let lastKnownAccountKey: string | null = null;
let accountKeyKnown = false;

/**
 * Optimistic overrides carry ordering/settlement bookkeeping so a load
 * can tell apart three very different entries that used to share one
 * bare boolean:
 * - `seq`: monotonic sequence of the most recent intent for the track.
 * - `pending`: how many mutations for the track are still in flight.
 * - `accountKey`: the account the intent belongs to.
 */
type OptimisticEntry = {
  liked: boolean;
  seq: number;
  pending: number;
  accountKey: string | null;
};
const optimisticOverrides = new Map<string, OptimisticEntry>();
let overrideSeq = 0;

export interface OptimisticHandle {
  seq: number;
  accountKey: string | null;
  /** Settle this operation as failed (see beginOptimistic). */
  settleFailed: () => void;
  /** Settle this operation as succeeded: it stops counting as pending. */
  settleSucceeded: () => void;
}

function buildView(isLoading: boolean): {
  data: LikedData;
  isLoading: boolean;
  error: boolean;
} {
  const error = loadFailed;
  if (optimisticOverrides.size === 0) return { data: cache, isLoading, error };

  let tracks = cache.tracks.filter(
    (t) => optimisticOverrides.get(t.id)?.liked !== false,
  );
  for (const [id, entry] of optimisticOverrides) {
    if (entry.liked && !tracks.some((t) => t.id === id)) {
      tracks = [
        {
          id,
          title: "",
          artists: "",
          artistId: undefined,
          coverUrl: "",
          durationMs: 0,
          playCount: 0,
        } as Track,
        ...tracks,
      ];
    }
  }
  return { data: { tracks, total: tracks.length }, isLoading, error };
}

function emit(isLoading = false) {
  view = buildView(isLoading);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return view;
}

const SERVER_SNAPSHOT = { data: EMPTY, isLoading: true, error: false };

function load(force = false): Promise<void> {
  if (request) {
    if (!force) return request;
    // A forced reload during a fetch used to be dropped, leaving the
    // cache stale. Queue exactly one follow-up run after this fetch.
    if (!queuedReloadPromise) {
      let resolveQueued!: () => void;
      queuedReloadPromise = new Promise<void>((resolve) => {
        resolveQueued = resolve;
      });
      const queued = queuedReloadPromise;
      void request.then(() => {
        if (queuedReloadPromise === queued) queuedReloadPromise = null;
        void load(true).then(resolveQueued, resolveQueued);
      });
    }
    return queuedReloadPromise;
  }
  const session = getAuthSession();
  if (!session?.accessToken) {
    cache = EMPTY;
    loaded = false;
    fetchedFromServer = false;
    optimisticOverrides.clear();
    emit(false);
    return Promise.resolve();
  }
  if (loaded && !force) return Promise.resolve();

  if (!loaded) emit(true);

  const accountKey = currentLikedAccountKey();
  lastKnownAccountKey = accountKey;
  accountKeyKnown = true;
  // Overrides settled at or before this sequence were already decided
  // when the fetch started, so the fetched page may speak for them.
  // Anything newer — or still pending — must survive this load.
  const snapshotSeq = overrideSeq;

  request = (async () => {
    const tracks: Track[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.listLikedTracks(100, cursor);
      tracks.push(
        ...page.items.map(({ track, likedAt }) => ({
          ...toClientTrack(track),
          addedAt: likedAt,
        })),
      );
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    // The account changed while this fetch was in flight: its page
    // belongs to the previous account and must not touch our state.
    if (currentLikedAccountKey() !== accountKey) return;
    cache = { tracks, total: tracks.length };
    loaded = true;
    fetchedFromServer = true;
    loadFailed = false;
    for (const [id, entry] of optimisticOverrides) {
      if (entry.pending === 0 && entry.seq <= snapshotSeq) {
        optimisticOverrides.delete(id);
      }
    }
  })()
    .catch(() => {
      if (currentLikedAccountKey() !== accountKey) return;
      if (!fetchedFromServer) cache = EMPTY;
      loaded = fetchedFromServer;
      loadFailed = true;
    })
    .finally(() => {
      request = null;
      emit(false);
    });
  return request;
}

export function reloadLikedTracks(): Promise<void> {
  return load(true);
}

function beginOptimistic(trackId: string, liked: boolean): OptimisticHandle {
  const seq = ++overrideSeq;
  const accountKey = currentLikedAccountKey();
  const prev = optimisticOverrides.get(trackId);
  optimisticOverrides.set(trackId, {
    liked,
    seq,
    pending: (prev?.pending ?? 0) + 1,
    accountKey,
  });
  emit(false);

  let settled = false;
  return {
    seq,
    accountKey,
    settleFailed: () => {
      if (settled) return;
      settled = true;
      const entry = optimisticOverrides.get(trackId);
      // Gone already (e.g. cleared by an account switch), or replaced
      // by the next account's intent for this track: nothing to settle.
      if (!entry || entry.accountKey !== accountKey) return;
      if (entry.seq !== seq) {
        // A newer intent owns the visible state. Only this operation's
        // pending claim ends; the newer override stays untouched.
        entry.pending = Math.max(0, entry.pending - 1);
        return;
      }
      // No newer intent: drop the override entirely so the UI falls
      // back to the last server state. Never resurrect a stale value
      // captured when this operation started.
      optimisticOverrides.delete(trackId);
      emit(false);
    },
    settleSucceeded: () => {
      if (settled) return;
      settled = true;
      const entry = optimisticOverrides.get(trackId);
      if (!entry || entry.accountKey !== accountKey) return;
      entry.pending = Math.max(0, entry.pending - 1);
    },
  };
}

export function beginOptimisticLike(trackId: string): OptimisticHandle {
  return beginOptimistic(trackId, true);
}

export function beginOptimisticUnlike(trackId: string): OptimisticHandle {
  return beginOptimistic(trackId, false);
}

export function applyOptimisticLike(trackId: string): () => void {
  return beginOptimisticLike(trackId).settleFailed;
}

export function applyOptimisticUnlike(trackId: string): () => void {
  return beginOptimisticUnlike(trackId).settleFailed;
}

function resetForSignedOut() {
  cache = EMPTY;
  loaded = false;
  fetchedFromServer = false;
  optimisticOverrides.clear();
  lastKnownAccountKey = null;
  accountKeyKnown = true;
  emit(false);
}

if (typeof window !== "undefined") {
  const handleLibraryChanged = () => {
    const session = getAuthSession();
    if (!session?.accessToken) {
      resetForSignedOut();
    } else {
      void load(true);
    }
  };
  const handleAuthChanged = () => {
    const session = getAuthSession();
    if (!session?.accessToken) {
      resetForSignedOut();
      return;
    }
    const accountKey = currentLikedAccountKey();
    if (accountKeyKnown && accountKey !== lastKnownAccountKey) {
      // A different account signed in: nothing from the previous
      // account — cache or optimistic intent — may leak across.
      cache = EMPTY;
      loaded = false;
      fetchedFromServer = false;
      loadFailed = false;
      optimisticOverrides.clear();
      lastKnownAccountKey = accountKey;
      emit(false);
    }
    void load(true);
  };
  window.addEventListener("library:changed", handleLibraryChanged);
  window.addEventListener("auth:changed", handleAuthChanged);
}

export const loadLikedTracks = load;
export const subscribeLikedTracks = subscribe;

export function likedTracksSnapshot(): {
  tracks: Track[];
  fromServer: boolean;
} {
  return { tracks: view.data.tracks, fromServer: fetchedFromServer };
}

export function useLikedTracks(_params?: { limit?: number; offset?: number }) {
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

export function useLikedTrackCount() {
  const { data, isLoading } = useLikedTracks();
  return { data: data.total, isLoading };
}
