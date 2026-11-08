import { api, mediaUrl } from "@/shared/api";
import type { TrackArtist } from "@/shared/types";

export const AVATAR_PIXELS = 96;

const artistAvatarCache = new Map<string, string | null>();
const pendingArtistAvatars = new Map<string, Promise<string | null>>();

export function primaryArtistId(
  artistId?: string,
  artistList?: TrackArtist[],
): string | undefined {
  const id = artistId || artistList?.[0]?.id;
  return id && id !== "unknown" ? id : undefined;
}

export function avatarArtistIds(
  artistId?: string,
  artistList?: TrackArtist[],
): string[] {
  const ids = [artistId, ...(artistList ?? []).map((artist) => artist.id)];
  const unique = new Set(
    ids.filter((id): id is string => Boolean(id) && id !== "unknown"),
  );
  return [...unique].slice(0, 2);
}

export function cachedArtistAvatar(
  artistId: string,
): string | null | undefined {
  return artistAvatarCache.get(artistId);
}

export function loadArtistAvatar(artistId: string): Promise<string | null> {
  const pending = pendingArtistAvatars.get(artistId);
  if (pending) return pending;
  const request = api
    .getArtistImage(artistId)
    .then((url) => (url ? mediaUrl(url) || null : null))
    .catch(() => null)
    .then((url) => {
      artistAvatarCache.set(artistId, url);
      pendingArtistAvatars.delete(artistId);
      return url;
    });
  pendingArtistAvatars.set(artistId, request);
  return request;
}

// Anchored to a parsed hostname: dot-separated labels, so the match is
// linear and lookalike hosts (googleusercontent.com.evil.com) fail.
const GOOGLE_IMAGE_HOST =
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:googleusercontent|ggpht)\.com$/i;
// Size-suffix tokens never contain "-", so excluding it from the token
// class keeps the repetition unambiguous (no super-linear backtracking).
const GOOGLE_SIZE_SUFFIX = /=(?:w\d+-h\d+|s\d+)(?:-[a-zA-Z0-9_]+)*$/;

export function sizedAvatarUrl(url: string, size: number): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  if (!GOOGLE_IMAGE_HOST.test(host)) return url;
  const suffix = `=s${size}-c`;
  return GOOGLE_SIZE_SUFFIX.test(url)
    ? url.replace(GOOGLE_SIZE_SUFFIX, suffix)
    : `${url}${suffix}`;
}

const warmedAvatars = new Set<string>();

export async function preloadArtistAvatars(
  artistId?: string,
  artistList?: TrackArtist[],
): Promise<void> {
  if (typeof Image === "undefined") return;
  const ids = avatarArtistIds(artistId, artistList);
  const urls = await Promise.all(ids.map(loadArtistAvatar));
  for (const url of urls) {
    if (!url) continue;
    const sized = sizedAvatarUrl(url, AVATAR_PIXELS);
    if (warmedAvatars.has(sized)) continue;
    warmedAvatars.add(sized);
    const img = new Image();
    img.decoding = "async";
    img.src = sized;
    void img.decode().catch(() => warmedAvatars.delete(sized));
  }
}
