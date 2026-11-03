import type { ImportPartialInfo } from "@/shared/contracts";
import type { JsonRecord } from "@/shared/utils/json";

export interface SoundCloudCollection {
  title: string;
  description?: string;
  /** Set/playlist artwork — per-track fallback when a track has none of its own. */
  artworkUrl?: string;
  rawTracks: JsonRecord[];
  /**
   * Set when the collection provably holds fewer tracks than the
   * source has (a page failed, the API ended early, or the page cap
   * stopped the walk) — never left as a silent shortfall.
   */
  partial?: ImportPartialInfo;
}

export function createSoundCloudCollection(): SoundCloudCollection {
  return { title: "Imported SoundCloud playlist", rawTracks: [] };
}
