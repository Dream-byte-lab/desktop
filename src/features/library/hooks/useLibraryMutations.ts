import { useCallback, useState } from "react";
import { api } from "@/shared/api";
import { notifyLibraryChanged, evictPlaylistFromCache } from "./usePlaylists";
import {
  beginOptimisticLike,
  beginOptimisticUnlike,
  currentLikedAccountKey,
  toggleTrackLike,
} from "./useLikedTracks";

type Options = {
  onSuccess?: (...args: any[]) => void;
  onError?: (error: unknown) => void;
  onSettled?: () => void;
};

function useMutation<T, R = unknown>(action: (input: T) => Promise<R>) {
  const [isPending, setIsPending] = useState(false);
  const mutateAsync = useCallback(
    async (input: T): Promise<R> => {
      setIsPending(true);
      try {
        const result = await action(input);
        notifyLibraryChanged();
        return result;
      } finally {
        setIsPending(false);
      }
    },
    [action],
  );
  const mutate = useCallback(
    (input: T, options?: Options) => {
      void mutateAsync(input)
        .then((value) => options?.onSuccess?.(value))
        .catch((error) => options?.onError?.(error))
        .finally(() => options?.onSettled?.());
    },
    [mutateAsync],
  );
  return { mutate, mutateAsync, isPending };
}

export function useAddPlaylistTracks() {
  return useMutation(
    ({ playlistId, trackId }: { playlistId: string; trackId: string }) =>
      api.addPlaylistTrack(playlistId, trackId),
  );
}

export function useRemovePlaylistTracks() {
  return useMutation(
    ({ playlistId, itemId }: { playlistId: string; itemId: string }) =>
      api.removePlaylistItem(playlistId, itemId),
  );
}

export function useReorderPlaylistTracks() {
  return useMutation(
    ({
      playlistId,
      itemId,
      beforeItemId,
      revision,
    }: {
      playlistId: string;
      itemId: string;
      beforeItemId: string | null;
      revision: number;
    }) => api.movePlaylistItem(playlistId, itemId, beforeItemId, revision),
  );
}

export function useCreatePlaylist() {
  return useMutation(
    ({ title, description }: { title: string; description?: string }) =>
      api.createPlaylist({ title, description }),
  );
}

export function useDeletePlaylist() {
  return useMutation(async ({ playlistId }: { playlistId: string }) => {
    evictPlaylistFromCache(playlistId);
    await api.deletePlaylist(playlistId);
  });
}

export function useSaveExternalItem() {
  return useMutation(
    ({
      type,
      id,
      snapshot,
    }: {
      type: "album" | "artist" | "playlist";
      id: string;
      snapshot?: Record<string, unknown>;
    }) =>
      api.saveCollection(
        `${type}s` as "albums" | "artists" | "playlists",
        id,
        snapshot,
      ),
  );
}

export function useRemoveExternalItem() {
  return useMutation(
    async ({
      type,
      id,
      isOwned,
    }: {
      type: "album" | "artist" | "playlist";
      id: string;
      isOwned?: boolean;
    }) => {
      if (type === "playlist") {
        evictPlaylistFromCache(id);
        if (isOwned === false) {
          return api.removeCollection("playlists", id);
        }
        try {
          const res = await api.deletePlaylist(id);
          // purge any saved collection reference in case it was both created and saved
          await api.removeCollection("playlists", id).catch(() => {});
          return res;
        } catch (err: unknown) {
          if (isOwned === true) {
            throw err;
          }
          // fall back to removing from saved collections if playlist was not owned
          return api.removeCollection("playlists", id);
        }
      }
      return api.removeCollection(`${type}s` as "albums" | "artists", id);
    },
  );
}

type TrackMutationInput = string | { trackId: string; [key: string]: unknown };
const trackIdFrom = (input: TrackMutationInput) =>
  typeof input === "string" ? input : input.trackId;

/**
 * Per-track serial queue: like/unlike calls for one track reach the
 * server strictly in user-intent order, while different tracks still
 * proceed concurrently. Each caller keeps its own result/error; the
 * chain itself never rejects, so one failure cannot stall later intent.
 */
const trackMutationTails = new Map<string, Promise<void>>();

function enqueueTrackMutation<T>(
  trackId: string,
  task: () => Promise<T>,
): Promise<T> {
  const tail = trackMutationTails.get(trackId) ?? Promise.resolve();
  const result = tail.then(task);
  const nextTail = result.then(
    () => undefined,
    () => undefined,
  );
  trackMutationTails.set(trackId, nextTail);
  void nextTail.then(() => {
    if (trackMutationTails.get(trackId) === nextTail) {
      trackMutationTails.delete(trackId);
    }
  });
  return result;
}

/**
 * Like/unlike successes reload the liked list through one shared
 * trailing debounce: a burst of toggles produces a single
 * library:changed (and therefore a single refetch), not one per toggle.
 * Other mutation types keep notifying immediately via useMutation.
 */
const LIKE_NOTIFY_DEBOUNCE_MS = 300;
let likeNotifyTimer: ReturnType<typeof setTimeout> | null = null;

export function notifyLikeLibraryChangedDebounced() {
  if (likeNotifyTimer) clearTimeout(likeNotifyTimer);
  likeNotifyTimer = setTimeout(() => {
    likeNotifyTimer = null;
    notifyLibraryChanged();
  }, LIKE_NOTIFY_DEBOUNCE_MS);
}

function useTrackLikeMutation(kind: "like" | "unlike") {
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = useCallback(
    async (input: TrackMutationInput) => {
      const trackId = trackIdFrom(input);
      const accountKey = currentLikedAccountKey();
      setIsPending(true);
      // Optimistic intent applies immediately, in call order, even
      // though the API call may wait behind an earlier intent.
      const handle =
        kind === "like"
          ? beginOptimisticLike(trackId)
          : beginOptimisticUnlike(trackId);
      try {
        const result = await enqueueTrackMutation(trackId, async () => {
          // Re-check immediately before the call: work queued under a
          // previous account is dropped, never sent in its name.
          if (currentLikedAccountKey() !== accountKey) {
            throw new Error("Account changed before this change was sent");
          }
          return kind === "like"
            ? api.likeTrack(trackId)
            : api.unlikeTrack(trackId);
        });
        handle.settleSucceeded();
        notifyLikeLibraryChangedDebounced();
        return result;
      } catch (err) {
        handle.settleFailed();
        throw err;
      } finally {
        setIsPending(false);
      }
    },
    [kind],
  );

  const mutate = useCallback(
    (input: TrackMutationInput, options?: Options) => {
      void mutateAsync(input)
        .then((value) => options?.onSuccess?.(value))
        .catch((error) => options?.onError?.(error))
        .finally(() => options?.onSettled?.());
    },
    [mutateAsync],
  );

  return { mutate, mutateAsync, isPending };
}

export function useLikeTrack() {
  return useTrackLikeMutation("like");
}

export function useUnlikeTrack() {
  return useTrackLikeMutation("unlike");
}

/**
 * Fire-and-forget toggle for menus and buttons that only need the
 * resulting state: flips optimistically and lets the desired-state
 * sync in useLikedTracks walk the server to the last click.
 */
export function useToggleTrackLike() {
  return useCallback(
    (
      trackId: string,
      options?: {
        onSuccess?: (liked: boolean) => void;
        onError?: (error: unknown) => void;
      },
    ): boolean => {
      const { liked, settled } = toggleTrackLike(trackId);
      settled.then(
        () => options?.onSuccess?.(liked),
        (error) => options?.onError?.(error),
      );
      return liked;
    },
    [],
  );
}
