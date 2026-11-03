import {
  asArray,
  asRecord,
  type JsonRecord,
  numberValue,
  stringValue,
} from "@/shared/utils/json";
import type { ImportPartialInfo } from "@/shared/contracts";
import { fetchSoundCloudApi, SOUNDCLOUD_API } from "@/shared/media/soundcloud";
import { log } from "@/shared/utils/logger";
import type { SoundCloudCollection } from "./soundcloudCollection";

export const MAX_LIKES_PAGES = 500;

/**
 * Where a likes walk stopped when a page fetch failed mid-collection:
 * the tracks already fetched and the page to retry from. Kept per
 * user so a later import of the same user's likes resumes the
 * remainder instead of restarting — and surfaced on the collection
 * as `partial`, never only as a log line (upstream #288: 1,600+
 * likes silently landing as 920).
 */
interface LikesCheckpoint {
  tracks: JsonRecord[];
  fetchedUrls: string[];
  nextUrl: string;
}

const likesCheckpoints = new Map<string, LikesCheckpoint>();

export function isSoundCloudUserEntity(
  body: JsonRecord,
  isLikesUrl: boolean,
): boolean {
  return (
    body.kind === "user" ||
    isLikesUrl ||
    (typeof body.id === "number" && !body.tracks)
  );
}

function likedTrack(item: unknown): JsonRecord | undefined {
  const record = asRecord(item);
  return (
    asRecord(record?.track) ?? (record?.kind === "track" ? record : undefined)
  );
}

function nextLikesUrl(nextHref: unknown): string | null {
  const href = stringValue(nextHref);
  return href?.trim() ? href : null;
}

export async function collectSoundCloudLikes(
  body: JsonRecord,
  fallbackUsername: string,
  collection: SoundCloudCollection,
  signal?: AbortSignal,
): Promise<void> {
  const username = stringValue(body.username) ?? fallbackUsername;
  collection.title = `${username} — Likes`;
  collection.description = `Liked tracks from SoundCloud user ${username}`;

  const userKey = String(body.id);
  const likesCount = numberValue(body.likes_count);
  const expectedTotal =
    likesCount !== undefined && likesCount > 0 ? likesCount : undefined;
  const partialWithCounts = (
    reason: ImportPartialInfo["reason"],
    resumable: boolean,
  ): ImportPartialInfo => ({
    reason,
    resumable,
    ...(expectedTotal !== undefined
      ? {
          expectedTotal,
          missing: Math.max(0, expectedTotal - collection.rawTracks.length),
        }
      : {}),
  });

  // Resume a previous attempt that died on a failed page: seed what
  // it already fetched and continue from the page it stopped at.
  const checkpoint = likesCheckpoints.get(userKey);
  let nextUrl: string | null = `/users/${String(body.id)}/likes?limit=50`;
  const visitedPages = new Set<string>();
  if (checkpoint) {
    likesCheckpoints.delete(userKey);
    collection.rawTracks.push(...checkpoint.tracks);
    for (const url of checkpoint.fetchedUrls) visitedPages.add(url);
    nextUrl = checkpoint.nextUrl;
  }
  const fetchedUrls: string[] = [...visitedPages];

  while (nextUrl) {
    const pageUrl = new URL(nextUrl, SOUNDCLOUD_API).href;
    if (visitedPages.has(pageUrl)) break;
    if (visitedPages.size >= MAX_LIKES_PAGES) {
      log(
        "yellow",
        "import",
        `soundcloud likes import stopped at ${MAX_LIKES_PAGES} pages with ${collection.rawTracks.length} tracks`,
      );
      // A completed pass to the ceiling: nothing to resume from —
      // the cap is stated to the user at import time instead.
      collection.partial = partialWithCounts("page_cap_reached", true);
      break;
    }
    visitedPages.add(pageUrl);
    const response = await fetchSoundCloudApi(nextUrl, {}, { signal });
    if (!response.ok) {
      log(
        "yellow",
        "import",
        `soundcloud likes import is partial: page ${visitedPages.size} failed with ${response.status}, kept ${collection.rawTracks.length} tracks`,
      );
      likesCheckpoints.set(userKey, {
        tracks: [...collection.rawTracks],
        fetchedUrls: [...fetchedUrls],
        nextUrl,
      });
      collection.partial = partialWithCounts("page_fetch_failed", true);
      break;
    }
    fetchedUrls.push(pageUrl);
    const likesBody = asRecord((await response.json()) as unknown);
    for (const item of asArray(likesBody?.collection)) {
      const track = likedTrack(item);
      if (track) collection.rawTracks.push(track);
    }
    nextUrl = nextLikesUrl(likesBody?.next_href);
    if (!nextUrl) {
      // The API ended the walk. If it ended before the user's own
      // likes count, the shortfall is real even though no page
      // failed — say so instead of presenting a clean complete.
      if (
        expectedTotal !== undefined &&
        collection.rawTracks.length < expectedTotal
      ) {
        collection.partial = partialWithCounts("count_shortfall", false);
      }
    }
  }
}
