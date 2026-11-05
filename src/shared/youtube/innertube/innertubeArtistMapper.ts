import type {
  ArtistAlbum,
  ArtistDetails,
  ArtistRelease,
  SimilarArtistItem,
  Track,
} from "@/shared/contracts";
import { asArray, asRecord, findFirst, walkRecords } from "@/shared/utils/json";
import {
  getBrowseEndpoint,
  getPageType,
  getRuns,
  getText,
  isArtistPage,
  yearFromRuns,
} from "./innertubeJson";
import { coverFromThumbnail } from "./innertubeThumbnail";
import { hasExplicitBadge } from "./innertubeTrackMapper";
import {
  mapInnertubeBrowseTracks,
  microformatCover,
} from "./innertubeCollectionMapper";
import {
  isVerifiedArtist,
  parseMonthlyListenersCount,
} from "./monthlyListeners";

const LISTENERS_PATTERN =
  /[\d.,]+[KMBkmb]?\s*(?:monthly (?:audience|listeners)|слушателей за месяц|слухачів за місяць)/i;

function artistHeader(body: unknown) {
  return (
    findFirst(body, "musicImmersiveHeaderRenderer") ??
    findFirst(body, "musicVisualHeaderRenderer") ??
    findFirst(body, "musicHeaderRenderer") ??
    findFirst(body, "musicResponsiveHeaderRenderer")
  );
}

function parseMonthlyListeners(
  header: Record<string, unknown> | undefined,
): string | undefined {
  if (!header) return undefined;
  const direct = getText(header.monthlyListenerCount);
  if (direct) return direct;
  const label = asRecord(
    asRecord(asRecord(header.monthlyListenerCount)?.accessibility)
      ?.accessibilityData,
  )?.label;
  if (typeof label === "string" && label.trim()) return label.trim();
  return (
    getText(header.subtitle)?.match(LISTENERS_PATTERN)?.[0] ??
    getText(header.secondSubtitle)?.match(LISTENERS_PATTERN)?.[0]
  );
}

function parseSubscribers(
  header: Record<string, unknown> | undefined,
): number | undefined {
  const button = asRecord(
    asRecord(header?.subscriptionButton)?.subscribeButtonRenderer,
  );
  return parseMonthlyListenersCount(getText(button?.subscriberCountText));
}

function mapReleaseItem(raw: unknown): ArtistAlbum | null {
  const item = asRecord(asRecord(raw)?.musicTwoRowItemRenderer);
  const titleRun = getRuns(item?.title)[0];
  const endpoint =
    asRecord(asRecord(titleRun?.navigationEndpoint)?.browseEndpoint) ??
    asRecord(asRecord(item?.navigationEndpoint)?.browseEndpoint);
  const title = getText(item?.title);
  if (
    getPageType(endpoint) !== "MUSIC_PAGE_TYPE_ALBUM" ||
    typeof endpoint?.browseId !== "string" ||
    !title
  ) {
    return null;
  }
  const year = yearFromRuns(item?.subtitle);
  const cover = coverFromThumbnail(item?.thumbnailRenderer);
  return {
    id: endpoint.browseId,
    title,
    ...(year ? { year } : {}),
    ...(cover ? { cover } : {}),
    explicit: hasExplicitBadge(item),
  };
}

function releaseTypeOf(raw: unknown): ArtistRelease["releaseType"] {
  const item = asRecord(asRecord(raw)?.musicTwoRowItemRenderer);
  const first = getRuns(item?.subtitle)[0]?.text;
  return typeof first === "string" && first.trim().toLowerCase() === "ep"
    ? "ep"
    : "single";
}

function mapArtistReleases(body: unknown): {
  albums: ArtistAlbum[];
  singles: ArtistRelease[];
} {
  const albums: ArtistAlbum[] = [];
  const singles: ArtistRelease[] = [];
  const seen = new Set<string>();
  walkRecords(body, (record) => {
    const carousel = asRecord(record.musicCarouselShelfRenderer);
    if (!carousel) return false;
    const header = asRecord(
      asRecord(carousel.header)?.musicCarouselShelfBasicHeaderRenderer,
    );
    const shelfTitle = getText(header?.title)?.toLowerCase();
    if (shelfTitle !== "albums" && shelfTitle !== "singles & eps") return true;
    for (const raw of asArray(carousel.contents)) {
      const release = mapReleaseItem(raw);
      if (!release || seen.has(release.id)) continue;
      seen.add(release.id);
      if (shelfTitle === "albums") albums.push(release);
      else singles.push({ ...release, releaseType: releaseTypeOf(raw) });
    }
    return true;
  });
  return { albums, singles };
}

// Similar artists, from the artist browse body itself: YouTube
// Music artist pages carry a "Fans might also like" carousel of
// artist cards — the source's own listener-derived similar
// artists, in the SAME response this mapper already consumes for
// the header, top songs and releases. The parse is title-keyed
// exactly like mapArtistReleases and accepts only items whose
// endpoint is an artist page, so nothing but artist cards can
// land here; when the shelf is absent the field stays unset and
// the UI shows no section — never a dressed-up guess.
const SIMILAR_SHELF_TITLES = new Set([
  "fans might also like",
  "fans also like",
  "similar artists",
]);

function mapSimilarArtistItem(raw: unknown): SimilarArtistItem | null {
  const twoRow = asRecord(asRecord(raw)?.musicTwoRowItemRenderer);
  if (twoRow) {
    const titleRun = getRuns(twoRow.title)[0];
    const endpoint =
      asRecord(asRecord(titleRun?.navigationEndpoint)?.browseEndpoint) ??
      asRecord(asRecord(twoRow.navigationEndpoint)?.browseEndpoint);
    const name = getText(twoRow.title);
    if (
      !isArtistPage(getPageType(endpoint)) ||
      typeof endpoint?.browseId !== "string" ||
      !name
    ) {
      return null;
    }
    const cover = coverFromThumbnail(twoRow.thumbnailRenderer, {
      isArtist: true,
    });
    return { id: endpoint.browseId, name, ...(cover ? { cover } : {}) };
  }
  const listItem = asRecord(asRecord(raw)?.musicResponsiveListItemRenderer);
  if (listItem) {
    const titleColumn = asRecord(
      asArray(listItem.flexColumns)[0],
    )?.musicResponsiveListItemFlexColumnRenderer;
    const titleRun = getRuns(asRecord(titleColumn)?.text)[0];
    const endpoint = getBrowseEndpoint(titleRun);
    const name = getText(asRecord(titleColumn)?.text);
    if (
      !isArtistPage(getPageType(endpoint)) ||
      typeof endpoint?.browseId !== "string" ||
      !name
    ) {
      return null;
    }
    const cover = coverFromThumbnail(listItem.thumbnail, { isArtist: true });
    return { id: endpoint.browseId, name, ...(cover ? { cover } : {}) };
  }
  return null;
}

export function mapSimilarArtists(
  body: unknown,
  selfId: string,
): SimilarArtistItem[] {
  const artists: SimilarArtistItem[] = [];
  const seen = new Set<string>([selfId]);
  walkRecords(body, (record) => {
    const carousel = asRecord(record.musicCarouselShelfRenderer);
    if (!carousel) return false;
    const header = asRecord(
      asRecord(carousel.header)?.musicCarouselShelfBasicHeaderRenderer,
    );
    const shelfTitle = getText(header?.title)?.toLowerCase();
    if (!shelfTitle || !SIMILAR_SHELF_TITLES.has(shelfTitle)) return true;
    for (const raw of asArray(carousel.contents)) {
      const artist = mapSimilarArtistItem(raw);
      if (!artist || seen.has(artist.id)) continue;
      seen.add(artist.id);
      artists.push(artist);
      if (artists.length >= 12) break;
    }
    return true;
  });
  return artists;
}

// The derivation used when the source supplied no similar-artists
// shelf: rank the artists of a related-tracks list (the source's
// own radio/related graph) by how many of those tracks credit
// them. An artist is counted once per track; the artist the list
// was derived for, and id-less credits, never appear. This is
// relatedness data, not fan data — callers must label it so.
export function rankSimilarArtistsFromTracks(
  tracks: readonly Track[],
  selfId: string,
  limit = 8,
): SimilarArtistItem[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const track of tracks) {
    const credited = new Set<string>();
    for (const artist of track.artists) {
      if (!artist.id || artist.id === "unknown" || artist.id === selfId) {
        continue;
      }
      if (credited.has(artist.id)) continue;
      credited.add(artist.id);
      const entry = counts.get(artist.id);
      if (entry) entry.count += 1;
      else counts.set(artist.id, { name: artist.name, count: 1 });
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([id, entry]) => ({ id, name: entry.name }));
}

export function mapInnertubeArtistDetails(
  id: string,
  body: unknown,
): ArtistDetails | null {
  const header = artistHeader(body);
  const name = getText(header?.title);
  if (!name) return null;
  const monthlyListeners = parseMonthlyListeners(header);
  const followers = parseSubscribers(header);
  const bio = getText(header?.description)?.trim();
  const cover =
    microformatCover(body, true) ??
    coverFromThumbnail(header?.thumbnail, { isArtist: true });
  const releases = mapArtistReleases(body);
  const similarArtists = mapSimilarArtists(body, id);
  return {
    type: "artist",
    id,
    name,
    verified: isVerifiedArtist(monthlyListeners),
    ...(cover ? { cover } : {}),
    ...(monthlyListeners ? { monthlyListeners } : {}),
    ...(followers !== undefined ? { followers } : {}),
    ...(bio ? { bio } : {}),
    tracks: mapInnertubeBrowseTracks(body, [{ id, name }]),
    albums: releases.albums,
    singles: releases.singles,
    ...(similarArtists.length > 0
      ? { similarArtists, similarArtistsBasis: "fans" as const }
      : {}),
  };
}

export function getArtistTopSongsBrowse(
  body: unknown,
): { browseId: string; params?: string } | undefined {
  let found: { browseId: string; params?: string } | undefined;
  walkRecords(body, (record) => {
    if (found) return true;
    const shelf = asRecord(record.musicShelfRenderer);
    if (!shelf) return false;
    const titleRun = getRuns(shelf.title)[0];
    const endpoint =
      asRecord(asRecord(titleRun?.navigationEndpoint)?.browseEndpoint) ??
      asRecord(asRecord(shelf.bottomEndpoint)?.browseEndpoint);
    if (typeof endpoint?.browseId !== "string") return false;
    found = {
      browseId: endpoint.browseId,
      ...(typeof endpoint.params === "string"
        ? { params: endpoint.params }
        : {}),
    };
    return true;
  });
  return found;
}
