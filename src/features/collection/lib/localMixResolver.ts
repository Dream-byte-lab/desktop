import { getAuthSession } from "@/shared/api";
import type { Track } from "@/shared/types";
import {
  createTranslatorSync,
  getStoredLocale,
  type TFunction,
} from "@/languages";
import {
  hydrateScreenCache,
  readScreenCache,
} from "@/shared/cache/screenCache";
import {
  FOR_YOU_LIMITS,
  forYouMixId,
  type DailyMixSnapshot,
  type ForYouMixBasis,
} from "@/features/home/lib/forYouFeed";
import {
  mergeUniverse,
  type HeardEntry,
} from "@/features/home/hooks/useForYouFeed";
import { getDailyMixArtists } from "@/features/home/hooks/useDailyMixes";
import { likedTracksSnapshot } from "@/features/library/hooks/useLikedTracks";
import type { CollectionPageData } from "../hooks/useCollection";

// ---------------------------------------------------------------------
// Local mix resolution
// ---------------------------------------------------------------------
//
// The For You feed's mixes are generated on-device and frozen into a
// day-keyed snapshot (localStorage, `liner_foryou_mixes_v1`) whose
// entries carry only a cluster basis and track ids. In-session, the
// Home rail primes the collection cache from the live mixes, so a
// mix detail page never has to resolve anything itself. The cold
// path — fresh app start, a deep link, the primed entry aged out of
// the query cache, the 5-minute SWR revalidation — reaches
// loadCollection with a bare `mix:…` id and must resolve it here,
// locally: local mixes have no server representation at all, so no
// api call may be issued for them.
//
// Resolution is always against THE DAY'S snapshot: an id is looked
// up by cluster identity (the id is derived from the basis) in the
// snapshot whose dateKey is today, and its track ids are resolved
// against the same universe the feed builds from (the persisted
// listening-history cache merged with the liked tracks, via the
// feed's own mergeUniverse). A snapshot from a previous day is never
// served: if the day has rolled and the mix has not been redrawn
// into today's snapshot — or the cluster no longer exists in it —
// the mix is honestly not found, and the detail page renders its
// not-found state rather than a stale or Frankenstein mix.

/** The localStorage key of the feed's daily mix snapshot. Must
 * match DAILY_MIX_SNAPSHOT_KEY in features/home/hooks/useForYouFeed
 * (the feed owns the snapshot; this module only reads it). */
const DAILY_MIX_SNAPSHOT_KEY = "liner_foryou_mixes_v1";

/** The screen-cache key of the feed's persisted history universe.
 * Must match the key useForYouCandidates loads under. */
function forYouHistoryKey(owner: string): string {
  return `home:for-you-history:${owner}`;
}

/** Thrown when a local mix id cannot be honestly resolved. The
 * collection hook treats a rejected load as "not found" whenever
 * nothing is cached, which is the detail page's clean not-found
 * state. */
export class LocalMixNotFoundError extends Error {
  constructor(id: string) {
    super(`Local mix not found: ${id}`);
    this.name = "LocalMixNotFoundError";
  }
}

/** Local For You mixes are the only ids with the `mix:` prefix. */
export function isLocalMixId(id: string): boolean {
  return id.startsWith("mix:");
}

/**
 * Reads the feed's stored daily snapshot. The feed's own reader
 * (readStoredDailySnapshot in useForYouFeed) is not exported, so
 * the read is mirrored here against the same key; the shape is the
 * feed's exported DailyMixSnapshot type and the validation matches
 * the feed's exactly, so the two readers cannot disagree about
 * what a valid snapshot is.
 */
function readDailyMixSnapshot(): DailyMixSnapshot | null {
  try {
    const raw = localStorage.getItem(DAILY_MIX_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { dateKey?: unknown }).dateKey !== "string" ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return null;
    }
    return parsed as DailyMixSnapshot;
  } catch {
    return null;
  }
}

// Title/description composition mirrors useDailyMixes' mixTitle /
// mixDescription (not exported) key for key, so a cold-resolved mix
// is described exactly as the Home rail and the feed describe it.
function mixTitle(basis: ForYouMixBasis, t: TFunction): string {
  switch (basis.kind) {
    case "playlistGenre":
      return t("forYou.mixGenreTitle", { label: basis.label });
    case "artistFamily":
      return t("forYou.mixArtistTitle", { artist: basis.label });
    case "era":
      return t("forYou.mixEraTitle", { era: basis.label });
    case "derivedEnergy":
      return basis.label === "high"
        ? t("forYou.mixEnergyHighTitle")
        : t("forYou.mixEnergyLowTitle");
    case "derivedTempo":
      return basis.label === "slow"
        ? t("forYou.mixTempoSlowTitle")
        : t("forYou.mixTempoDrivingTitle");
  }
}

function mixDescription(basis: ForYouMixBasis, t: TFunction): string {
  switch (basis.kind) {
    case "playlistGenre":
      return t("forYou.mixGenreSubtitle");
    case "artistFamily":
      return t("forYou.mixFamilySubtitle");
    case "era":
      return t("forYou.mixEraSubtitle");
    case "derivedEnergy":
      return t("forYou.moodsDerived");
    case "derivedTempo":
      return t("forYou.moodsDerived");
  }
}

/**
 * The feed's track universe as an id → Track map, assembled from
 * local state only: the persisted history screen cache (the same
 * entry useForYouCandidates loads, IndexedDB-backed so it survives
 * app restarts) merged with the liked-tracks store's current
 * snapshot, through the feed's own mergeUniverse. No api call is
 * made; whatever the app has already gathered is what a local mix
 * may draw from.
 */
async function loadLocalUniverseById(): Promise<Map<string, Track>> {
  await hydrateScreenCache();
  const owner = getAuthSession()?.user?.id ?? "";
  const heard =
    readScreenCache<HeardEntry[]>(forYouHistoryKey(owner))?.data ?? [];
  const liked = likedTracksSnapshot().tracks;
  const byId = new Map<string, Track>();
  for (const entry of mergeUniverse(heard, liked)) {
    byId.set(entry.track.id, entry.track);
  }
  return byId;
}

/**
 * Resolves a local mix id (`mix:…`) to collection page data,
 * entirely locally. Rejects with LocalMixNotFoundError when the
 * mix cannot be honestly resolved: no snapshot for today, the
 * cluster absent from today's snapshot, or fewer than the feed's
 * coherence bar of its tracks present in the local universe.
 */
export async function resolveLocalMixCollection(
  id: string,
): Promise<CollectionPageData> {
  const snapshot = readDailyMixSnapshot();
  const today = new Date().toDateString();
  if (!snapshot || snapshot.dateKey !== today) {
    throw new LocalMixNotFoundError(id);
  }
  const entry = snapshot.entries.find(
    (candidate) => forYouMixId(candidate.basis) === id,
  );
  if (!entry) {
    throw new LocalMixNotFoundError(id);
  }

  const byId = await loadLocalUniverseById();
  const tracks: Track[] = [];
  for (const trackId of entry.trackIds) {
    const track = byId.get(trackId);
    if (track) tracks.push(track);
  }
  // Mirror applyDailySnapshot: an entry whose surviving membership
  // falls below the coherence bar is dropped, not padded.
  if (tracks.length < FOR_YOU_LIMITS.minMixTracks) {
    throw new LocalMixNotFoundError(id);
  }

  const t = createTranslatorSync(getStoredLocale());
  const artists = getDailyMixArtists(undefined, tracks, 4);
  return {
    type: "playlist",
    title: mixTitle(entry.basis, t),
    author: artists.length > 0 ? artists.join(", ") : "Daily Mix",
    description: mixDescription(entry.basis, t),
    coverUrl: tracks[0]?.coverUrl || "",
    tracks,
    isDailyMix: true,
  };
}
