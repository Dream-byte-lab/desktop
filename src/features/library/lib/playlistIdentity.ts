import { useSyncExternalStore } from "react";

/**
 * Playlist identity pack (upstream harvest Wave 3, Rank 10 remainder;
 * issues #210, #248, #237, #247).
 *
 * Playlists are server-backed and the server API offers no custom-cover
 * upload, so both halves of a playlist's local identity live here, on
 * this device only — exactly the shape #248 asked for ("Local-only
 * storage is sufficient"):
 *
 * - Custom covers: a data URL keyed by playlist id, in localStorage
 *   under `liner:playlist-custom-covers-v1`. Images are downscaled to
 *   at most 512 px on the long edge before they are stored, so a
 *   library of custom covers stays a sane size.
 * - Pins: an ordered id list (oldest pin first) under
 *   `liner:playlist-pins-v1`. Pinned playlists sort first in every
 *   library-playlist list via `orderPinnedFirst`.
 *
 * Liked Songs is NOT a server playlist summary (its tile is a
 * hard-coded card and its page builds its cover from the likes-cover
 * palette), but its cover is the specific subject of #248, so it gets
 * an entry here under the reserved id `likes` and the two surfaces
 * that render it read this store directly.
 */

export const LIKES_COVER_ID = "likes";
export const CUSTOM_COVER_MAX_PX = 512;

const COVERS_KEY = "liner:playlist-custom-covers-v1";
const PINS_KEY = "liner:playlist-pins-v1";

type CoverMap = Record<string, string>;

const listeners = new Set<() => void>();

let coversSnapshot: CoverMap | null = null;
let pinsSnapshot: string[] | null = null;

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribePlaylistIdentity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------- covers

function covers(): CoverMap {
  if (!coversSnapshot) {
    const parsed = readJson<unknown>(COVERS_KEY, {});
    coversSnapshot =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as CoverMap)
        : {};
  }
  return coversSnapshot;
}

export function getCustomCover(
  playlistId: string | null | undefined,
): string | undefined {
  if (!playlistId) return undefined;
  const value = covers()[playlistId];
  return typeof value === "string" && value ? value : undefined;
}

export function getCustomCoversSnapshot(): CoverMap {
  return covers();
}

/** Returns false when the cover could not be persisted (storage full). */
export function setCustomCover(playlistId: string, dataUrl: string): boolean {
  if (!playlistId || !dataUrl) return false;
  const next = { ...covers(), [playlistId]: dataUrl };
  if (!writeJson(COVERS_KEY, next)) return false;
  coversSnapshot = next;
  emit();
  return true;
}

export function clearCustomCover(playlistId: string): void {
  if (!playlistId || !(playlistId in covers())) return;
  const next = { ...covers() };
  delete next[playlistId];
  writeJson(COVERS_KEY, next);
  coversSnapshot = next;
  emit();
}

/**
 * Apply the custom-cover overlay to a playlist summary/detail shape.
 * The custom image replaces the derived collage entirely (coverUrls
 * becomes the single custom image), so every surface that renders
 * coverUrl/coverUrls shows the same art. Returns the input unchanged
 * when there is no custom cover.
 */
export function applyCustomCover<
  T extends { id: string; coverUrl: string; coverUrls: string[] },
>(playlist: T): T {
  const custom = getCustomCover(playlist.id);
  if (!custom) return playlist;
  if (playlist.coverUrl === custom && playlist.coverUrls.length === 1) {
    return playlist;
  }
  return { ...playlist, coverUrl: custom, coverUrls: [custom] };
}

// ------------------------------------------------------------------ pins

function pins(): string[] {
  if (!pinsSnapshot) {
    const parsed = readJson<unknown>(PINS_KEY, []);
    pinsSnapshot = Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && !!id)
      : [];
  }
  return pinsSnapshot;
}

export function getPinnedPlaylistIds(): string[] {
  return pins();
}

export function isPlaylistPinned(playlistId: string): boolean {
  return pins().includes(playlistId);
}

/** Pin (appended, so pin order is pin time). Returns the new state. */
export function pinPlaylist(playlistId: string): boolean {
  if (!playlistId || isPlaylistPinned(playlistId))
    return isPlaylistPinned(playlistId);
  const next = [...pins(), playlistId];
  writeJson(PINS_KEY, next);
  pinsSnapshot = next;
  emit();
  return true;
}

export function unpinPlaylist(playlistId: string): void {
  if (!isPlaylistPinned(playlistId)) return;
  const next = pins().filter((id) => id !== playlistId);
  writeJson(PINS_KEY, next);
  pinsSnapshot = next;
  emit();
}

export function togglePlaylistPin(playlistId: string): boolean {
  if (isPlaylistPinned(playlistId)) {
    unpinPlaylist(playlistId);
    return false;
  }
  return pinPlaylist(playlistId);
}

/**
 * The one shared ordering helper: pinned items first, in pin order;
 * everything else keeps its existing relative order (stable partition
 * within both groups — the pin group itself is ordered by the pinned
 * id list, not by the list's own order, so an earlier pin always sits
 * ahead of a later one).
 */
export function orderPinnedFirst<T extends { id: string }>(
  items: readonly T[],
  pinnedIds: readonly string[] = pins(),
): T[] {
  if (pinnedIds.length === 0 || items.length === 0) return [...items];
  const byId = new Map<string, T>();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const pinnedSet = new Set(pinnedIds);
  const head: T[] = [];
  for (const id of pinnedIds) {
    const item = byId.get(id);
    if (item) head.push(item);
  }
  const tail = items.filter((item) => !pinnedSet.has(item.id));
  // Playlist ids are unique within every consuming list, so the head
  // (one entry per pinned id present) plus the tail is the whole list.
  return [...head, ...tail];
}

// ----------------------------------------------------------------- hooks

const EMPTY_PINS: string[] = [];

export function usePinnedPlaylistIds(): string[] {
  return useSyncExternalStore(
    subscribePlaylistIdentity,
    () => pins(),
    () => EMPTY_PINS,
  );
}

export function useCustomCover(
  playlistId: string | null | undefined,
): string | undefined {
  const all = useSyncExternalStore(
    subscribePlaylistIdentity,
    () => covers(),
    () => EMPTY_COVERS,
  );
  return playlistId ? all[playlistId] : undefined;
}

const EMPTY_COVERS: CoverMap = {};

/** Test/reset helper: forget cached snapshots (storage is re-read). */
export function resetPlaylistIdentityCacheForTests(): void {
  coversSnapshot = null;
  pinsSnapshot = null;
}

// -------------------------------------------------------------- downscale

/** Size after capping the long edge at `max`, preserving aspect. */
export function computeCoverSize(
  width: number,
  height: number,
  max: number = CUSTOM_COVER_MAX_PX,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const longEdge = Math.max(width, height);
  if (longEdge <= max) return { width, height };
  const scale = max / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Read a user-picked image file and return a data URL downscaled to
 * at most 512 px on the long edge (JPEG, except PNG sources keep PNG
 * so transparency survives). Throws on an unreadable file; callers
 * surface the failure with a toast.
 */
export async function fileToCustomCoverDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not read that image"));
      img.src = objectUrl;
    });
    const { width, height } = computeCoverSize(
      image.naturalWidth,
      image.naturalHeight,
    );
    if (!width || !height) throw new Error("Could not read that image");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not read that image");
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL(
      file.type === "image/png" ? "image/png" : "image/jpeg",
      0.85,
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
