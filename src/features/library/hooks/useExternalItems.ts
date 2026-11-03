import { useEffect, useRef, useState } from "react";
import { api, mediaUrl, toMaxQualityAvatarUrl } from "@/shared/api";
import {
  freshFor,
  revalidateResource,
  useCachedResource,
} from "@/shared/cache/useCachedResource";
import { useSessionOwner } from "@/features/home/hooks/sessionAwareLoad";
import { runWorkerPool } from "@/shared/utils/workerPool";
import type { LibraryItemViewModel } from "../types";

export type EntityType = "album" | "artist" | "playlist";

const EMPTY_ITEMS: LibraryItemViewModel[] = [];
const SAVED_ITEMS_POLICY = { isFresh: freshFor(5 * 60_000) };
const HYDRATION_CONCURRENCY = 4;

async function loadSavedItems(
  type: EntityType,
): Promise<LibraryItemViewModel[]> {
  const collectionType =
    type === "album" ? "albums" : type === "artist" ? "artists" : "playlists";
  const response = await api.listSavedCollections(collectionType);
  return response.items.map((entry: any) => {
    const value = entry[type];
    const rawCover = value.cover ? mediaUrl(value.cover.url) : "";
    const cover =
      type === "artist" ? toMaxQualityAvatarUrl(rawCover) : rawCover;
    return {
      id: value.id,
      title: type === "artist" ? value.name : value.title,
      subtitle:
        type === "artist"
          ? "Artist"
          : type === "playlist"
            ? value.author ||
              (value.trackCount ? `${value.trackCount} tracks` : "Playlist")
            : [
                value.year,
                value.trackCount ? `${value.trackCount} tracks` : undefined,
              ]
                .filter(Boolean)
                .join(" • "),
      imageUrl: cover,
      kind: type,
      href:
        type === "artist"
          ? `/artist?id=${encodeURIComponent(value.id)}`
          : type === "playlist"
            ? `/collection?type=playlist&id=${encodeURIComponent(value.id)}`
            : `/collection?type=album&id=${encodeURIComponent(value.id)}`,
      addedAt: entry.savedAt,
      trackCount: value.trackCount,
      isOwned: false,
    };
  });
}

/**
 * The display fields a catalog detail lookup may fill in for a sparse
 * saved entry. Everything else on the view model (id, href, addedAt,
 * trackCount, subtitle) belongs to the saved entry itself and is never
 * overwritten by detail data.
 */
interface HydratedDetails {
  title?: string;
  imageUrl?: string;
}

interface HydrationState {
  scope: string;
  patches: ReadonlyMap<string, HydratedDetails>;
}

const EMPTY_HYDRATION: HydrationState = { scope: "", patches: new Map() };

/**
 * Maps a catalog detail response onto the patchable fields, using the
 * same mapping loadSavedItems applies to saved summaries. Returns null
 * when the response is not usable for the requested item: not an
 * object, an id that does not exactly match the saved entry's own id
 * (identity is by catalog ID only — never a substitute entity), a type
 * that does not match the list being hydrated, or no usable fields.
 */
function detailPatch(
  type: "album" | "artist",
  requestedId: string,
  detail: unknown,
): HydratedDetails | null {
  if (!detail || typeof detail !== "object") return null;
  const value = detail as {
    id?: unknown;
    type?: unknown;
    title?: unknown;
    name?: unknown;
    cover?: { url?: unknown } | null;
  };
  if (value.id !== requestedId) return null;
  if (value.type != null && value.type !== type) return null;
  const rawTitle = type === "artist" ? value.name : value.title;
  const rawCover =
    value.cover && typeof value.cover.url === "string" && value.cover.url
      ? mediaUrl(value.cover.url)
      : "";
  const imageUrl =
    type === "artist" ? toMaxQualityAvatarUrl(rawCover) : rawCover;
  const patch: HydratedDetails = {
    ...(typeof rawTitle === "string" && rawTitle ? { title: rawTitle } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
  return patch.title || patch.imageUrl ? patch : null;
}

function needsHydration(item: LibraryItemViewModel): boolean {
  return Boolean(item.id) && (!item.title || !item.imageUrl);
}

export function useExternalItems(type: EntityType) {
  const owner = useSessionOwner();
  const key = `library:saved:${type}:${owner}`;
  const { data, isLoading } = useCachedResource(
    key,
    () => loadSavedItems(type),
    SAVED_ITEMS_POLICY,
  );

  useEffect(() => {
    const refresh = () =>
      void revalidateResource(key, () => loadSavedItems(type), { force: true });
    window.addEventListener("library:changed", refresh);
    return () => window.removeEventListener("library:changed", refresh);
  }, [key, type]);

  // Hydrated details, scoped to the exact owner+type cache key that
  // produced them: a patch recorded under one scope is never applied
  // under another, so an account switch can never leak one account's
  // resolved details into another account's library.
  const [hydration, setHydration] = useState<HydrationState>(EMPTY_HYDRATION);
  const hydrationRef = useRef(hydration);
  hydrationRef.current = hydration;
  const inFlightRef = useRef<ReadonlySet<string>>(new Set());
  // The latest scope + list, consulted when an async lookup lands: a
  // result is dropped if the scope moved on or the item left the list
  // while the request was in flight.
  const latestRef = useRef<{ key: string; items: LibraryItemViewModel[] }>({
    key,
    items: data ?? EMPTY_ITEMS,
  });
  latestRef.current = { key, items: data ?? EMPTY_ITEMS };

  // Prune resolved details for items that have left the list, so the
  // retained set always mirrors what is actually saved.
  useEffect(() => {
    if (!data) return;
    setHydration((previous) => {
      if (previous.scope !== key) return previous;
      let changed = false;
      const next = new Map(previous.patches);
      for (const id of next.keys()) {
        if (!data.some((item) => item.id === id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? { scope: key, patches: next } : previous;
    });
  }, [data, key]);

  // Hydrate sparse album/artist summaries. Summaries are returned
  // immediately; this effect only fills gaps in once lookups land.
  // Playlists are never hydrated, and complete summaries cost no
  // request. Lookups are pooled at HYDRATION_CONCURRENCY via the
  // shared worker pool; each task swallows its own failure (keeping
  // the summary exactly as-is), which also keeps the pool's fail-fast
  // behaviour from stranding the remaining items.
  useEffect(() => {
    if (!data || type === "playlist") return;
    const detailType = type;
    const resolved =
      hydrationRef.current.scope === key ? hydrationRef.current.patches : null;
    const candidates = data.filter(
      (item) =>
        needsHydration(item) &&
        !resolved?.has(item.id) &&
        !inFlightRef.current.has(`${key}:${item.id}`),
    );
    if (candidates.length === 0) return;
    const inFlight = new Set(inFlightRef.current);
    for (const item of candidates) inFlight.add(`${key}:${item.id}`);
    inFlightRef.current = inFlight;
    const scopeKey = key;
    void runWorkerPool(candidates, HYDRATION_CONCURRENCY, async (item) => {
      try {
        // The scope may have moved on while this task waited its turn.
        if (latestRef.current.key !== scopeKey) return;
        if (!latestRef.current.items.some((entry) => entry.id === item.id))
          return;
        let detail: unknown;
        try {
          detail =
            detailType === "album"
              ? await api.getAlbum(item.id)
              : await api.getArtist(item.id);
        } catch {
          return;
        }
        const patch = detailPatch(detailType, item.id, detail);
        if (!patch) return;
        // Stale discipline: the result must not land if the owner or
        // type changed, or the item left the list, while it was in
        // flight. (The render merge below only ever fills fields the
        // current summary still lacks, so a refreshed complete summary
        // cannot be overwritten either.)
        if (latestRef.current.key !== scopeKey) return;
        if (!latestRef.current.items.some((entry) => entry.id === item.id))
          return;
        setHydration((previous) => {
          if (latestRef.current.key !== scopeKey) return previous;
          const base =
            previous.scope === scopeKey ? previous.patches : new Map();
          if (base.get(item.id) === patch) return previous;
          const next = new Map(base);
          next.set(item.id, patch);
          return { scope: scopeKey, patches: next };
        });
      } finally {
        const remaining = new Set(inFlightRef.current);
        remaining.delete(`${scopeKey}:${item.id}`);
        inFlightRef.current = remaining;
      }
    }).catch(() => undefined);
  }, [data, key, type]);

  const items = data ?? EMPTY_ITEMS;
  const visibleItems =
    hydration.scope === key && hydration.patches.size > 0
      ? items.map((item) => {
          const patch = hydration.patches.get(item.id);
          if (!patch) return item;
          const merged = { ...item };
          if (!merged.title && patch.title) merged.title = patch.title;
          if (!merged.imageUrl && patch.imageUrl)
            merged.imageUrl = patch.imageUrl;
          return merged;
        })
      : items;

  return { data: visibleItems, isLoading };
}
