import type {
  ApiTrack,
  ArtistAlbum,
  ArtistRelease,
  Cover,
  SimilarArtistItem,
} from "@/shared/contracts";
import {
  asArray,
  asRecord,
  type JsonRecord,
  numberValue,
  trimmedString,
} from "@/shared/utils/json";
import {
  soundCloudPlaylistId,
  soundCloudTrackId,
  soundCloudUserId,
} from "./soundcloudIds";

const ARTWORK_SIZE = 500;
const ARTWORK_VARIANT = /-(?:large|t\d+x\d+|crop|original)(?=\.[a-z]+$)/i;

export interface SoundCloudArtistRef {
  id: string;
  name: string;
}

export function soundCloudCover(rawUrl: unknown): Cover | undefined {
  const url = trimmedString(rawUrl);
  if (!url) return undefined;
  return {
    url: url.replace(ARTWORK_VARIANT, `-t${ARTWORK_SIZE}x${ARTWORK_SIZE}`),
    width: ARTWORK_SIZE,
    height: ARTWORK_SIZE,
    fallbackUrl: url,
  };
}

export function mapSoundCloudArtist(
  rawUser: unknown,
): SoundCloudArtistRef | undefined {
  const user = asRecord(rawUser);
  const id = numberValue(user?.id);
  const name = trimmedString(user?.username);
  return id !== undefined && name
    ? { id: soundCloudUserId(id), name }
    : undefined;
}

// Similar artists, derived from SoundCloud's own related-tracks
// graph: the uploaders of the tracks SoundCloud's /related
// endpoint pairs with this artist's top songs, ranked by how
// often each uploader appears there, with the avatar SoundCloud
// itself serves for that uploader. This is relatedness data, not
// fan data — callers must label it so. The artist the list was
// derived for never appears in it.
export function similarArtistsFromRelatedTracks(
  rawTracks: readonly unknown[],
  selfId: string,
  limit = 8,
): SimilarArtistItem[] {
  const counts = new Map<
    string,
    { name: string; cover?: Cover; count: number }
  >();
  for (const raw of rawTracks) {
    const user = asRecord(asRecord(raw)?.user);
    const artist = mapSoundCloudArtist(user);
    if (!artist || artist.id === selfId) continue;
    const entry = counts.get(artist.id);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(artist.id, {
        name: artist.name,
        cover: soundCloudCover(user?.avatar_url),
        count: 1,
      });
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      ...(entry.cover ? { cover: entry.cover } : {}),
    }));
}

export function mapSoundCloudCatalogTrack(rawTrack: unknown): ApiTrack | null {
  const track = asRecord(rawTrack);
  const id = numberValue(track?.id);
  const title = trimmedString(track?.title);
  if (!track || id === undefined || !title) return null;
  const artist = mapSoundCloudArtist(track.user);
  const publisher = asRecord(track.publisher_metadata);
  const cover =
    soundCloudCover(track.artwork_url) ??
    soundCloudCover(asRecord(track.user)?.avatar_url);
  const playCount = numberValue(track.playback_count);
  return {
    id: soundCloudTrackId(id),
    title,
    artists: artist ? [artist] : [],
    durationMs: numberValue(track.duration) ?? 0,
    ...(cover ? { cover } : {}),
    ...(publisher?.explicit === true ? { explicit: true } : {}),
    ...(playCount !== undefined ? { playCount } : {}),
  };
}

export function mapSoundCloudTracks(rawTracks: unknown): ApiTrack[] {
  return asArray(rawTracks).flatMap(
    (raw) => mapSoundCloudCatalogTrack(raw) ?? [],
  );
}

export function soundCloudYear(record: JsonRecord): number | undefined {
  const date =
    trimmedString(record.release_date) ??
    trimmedString(record.display_date) ??
    trimmedString(record.created_at);
  const year = date ? Number.parseInt(date.slice(0, 4), 10) : Number.NaN;
  return Number.isFinite(year) && year > 1900 ? year : undefined;
}

export function soundCloudPlaylistCover(record: JsonRecord): Cover | undefined {
  const firstTrack = asRecord(asArray(record.tracks)[0]);
  return (
    soundCloudCover(record.artwork_url) ??
    soundCloudCover(firstTrack?.artwork_url) ??
    soundCloudCover(asRecord(record.user)?.avatar_url)
  );
}

export function mapSoundCloudRelease(rawPlaylist: unknown): ArtistAlbum | null {
  const record = asRecord(rawPlaylist);
  const id = numberValue(record?.id);
  const title = trimmedString(record?.title);
  if (!record || id === undefined || !title) return null;
  const cover = soundCloudPlaylistCover(record);
  const year = soundCloudYear(record);
  const trackCount = numberValue(record.track_count);
  return {
    id: soundCloudPlaylistId(id),
    title,
    ...(year ? { year } : {}),
    ...(cover ? { cover } : {}),
    ...(trackCount !== undefined
      ? { trackCount, totalTracks: trackCount }
      : {}),
  };
}

export function soundCloudReleaseType(
  rawPlaylist: unknown,
): ArtistRelease["releaseType"] | "album" {
  const setType = trimmedString(asRecord(rawPlaylist)?.set_type)?.toLowerCase();
  if (setType === "single") return "single";
  if (setType === "ep") return "ep";
  return "album";
}
