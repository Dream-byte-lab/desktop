import type {
  ImportedTrack,
  ImportPartialInfo,
  ImportSource,
} from "@/shared/contracts";

export interface ClientImportedTrack extends ImportedTrack {
  artistIds?: (string | undefined)[];
  albumId?: string;
}

export interface ClientImportedPlaylist {
  source: ImportSource;
  sourceUrl: string;
  title: string;
  description?: string;
  tracks: ClientImportedTrack[];
  canonicalTrackIds?: string[];
  /** Source records that could not become tracks — named, never silently dropped. */
  unresolvedTracks?: ClientImportedTrack[];
  /** Set when the source provably holds more tracks than landed. */
  partial?: ImportPartialInfo;
}
