import type { Track } from "../../../shared/types/track";
import { labelsForTrack } from "../../genres/trackGenres";
import { applyEvent, emptyProfile, type TasteProfile } from "./tasteProfile";

// The taste tracker: the living profile for this listener. The DJ
// session reports every track it finishes, blends out of, or is
// skipped away from; the tracker folds those into the taste profile
// and persists it locally, so the For You layer survives restarts.
// It records nothing else — no timestamps leave the machine, and the
// profile is just three weight maps (artists, tags, tracks).

const STORAGE_KEY = "liner_taste_profile_v1";

let profile: TasteProfile = load();
const heardTracks = new Set<string>(Object.keys(profile.tracks));

function load(): TasteProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw) as TasteProfile;
    if (!parsed.artists || !parsed.tags || !parsed.tracks) {
      return emptyProfile();
    }
    return parsed;
  } catch {
    return emptyProfile();
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Storage unavailable (tests, private mode): the profile simply
    // lives in memory for this run.
  }
}

/**
 * Reports one track's listen: how much of it was heard, and whether
 * it played out. Called by the DJ session at every track change.
 */
export function recordListen(report: {
  track: Track;
  playedRatio: number;
  completed: boolean;
}): void {
  const { track, playedRatio, completed } = report;
  const repeated = heardTracks.has(track.id) && playedRatio >= 0.5;
  heardTracks.add(track.id);
  // The track's labels, resolved at listen time (Step 5, S5-0): the
  // Playlist Genres it inherits from its playlists plus any basic
  // Genres source enrichment knows. This is the first real feed into
  // the profile's tags map — the slot existed, unfed, since the
  // profile was written. An unlabelled track passes no tags, exactly
  // as before.
  const labels = labelsForTrack(track.id);
  const tags = [...labels.playlistGenres, ...labels.genres];
  profile = applyEvent(profile, {
    artist: track.artists,
    trackId: track.id,
    ...(tags.length > 0 ? { tags } : {}),
    playedRatio,
    completed,
    repeated,
    atMs: Date.now(),
  });
  save();
}

export function getTasteProfile(): TasteProfile {
  return profile;
}
