import type {
  ClientImportedPlaylist,
  ClientImportedTrack,
} from "../../importTypes";
import type { ImportPartialInfo } from "@/shared/contracts";
import { asRecord, stringValue } from "@/shared/utils/json";
import {
  getSoundCloudClientId,
  hydrateSoundCloudStubs,
} from "@/shared/media/soundcloud";
import { createSoundCloudCollection } from "./soundcloudCollection";
import { scrapeSoundCloudHydration } from "./soundcloudHydration";
import { resolveSoundCloudApi } from "./soundcloudResolve";
import { mapSoundCloudTrack, soundCloudCanonicalId } from "./soundcloudTracks";
import { isSoundCloudLikesUrl, resolveSoundCloudUrl } from "./soundcloudUrl";

export interface SoundCloudImportOptions {
  signal?: AbortSignal;
}

export async function importSoundCloud(
  rawUrl: string,
  options: SoundCloudImportOptions = {},
): Promise<ClientImportedPlaylist> {
  const { signal } = options;
  const canonicalUrl = await resolveSoundCloudUrl(rawUrl, signal);
  const collection = createSoundCloudCollection();

  if (!isSoundCloudLikesUrl(canonicalUrl)) {
    await scrapeSoundCloudHydration(canonicalUrl, collection, signal);
  }

  await getSoundCloudClientId(undefined, signal);
  if (collection.rawTracks.length === 0) {
    await resolveSoundCloudApi(canonicalUrl, collection, signal);
  }

  const rawTracks = await hydrateSoundCloudStubs(collection.rawTracks, signal);
  const tracks: ClientImportedTrack[] = [];
  const unresolvedTracks: ClientImportedTrack[] = [];
  for (const raw of rawTracks) {
    const track = mapSoundCloudTrack(raw, collection.artworkUrl);
    if (track) {
      tracks.push(track);
    } else {
      // A record the source listed but that cannot become a track
      // (deleted/private, or its metadata never resolved): it is
      // named here so the import can route it to "Could not import"
      // instead of dropping it silently (upstream #288).
      const sourceId = String(raw.id ?? "");
      const username = stringValue(asRecord(raw.user)?.username);
      unresolvedTracks.push({
        sourceId,
        title: stringValue(raw.title) ?? `SoundCloud track ${sourceId}`,
        artists: username ? [username] : [],
      });
    }
  }

  if (tracks.length === 0) {
    throw new Error(
      "No tracks found in the SoundCloud playlist. Make sure the playlist is public and contains available tracks.",
    );
  }

  // The collection-level shortfall (a failed page, an early end, the
  // page cap) is the headline; unresolved tracks get their own
  // partial only when the collection itself landed whole.
  const partial: ImportPartialInfo | undefined =
    collection.partial ??
    (unresolvedTracks.length > 0
      ? {
          reason: "unresolved_tracks",
          missing: unresolvedTracks.length,
          resumable: false,
        }
      : undefined);

  return {
    source: "soundcloud",
    sourceUrl: rawUrl,
    title: collection.title,
    canonicalTrackIds: tracks.map((track) =>
      soundCloudCanonicalId(track.sourceId),
    ),
    ...(collection.description ? { description: collection.description } : {}),
    ...(unresolvedTracks.length > 0 ? { unresolvedTracks } : {}),
    ...(partial ? { partial } : {}),
    tracks,
  };
}
