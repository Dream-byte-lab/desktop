import type { Track } from "../../../shared/types/track";
import { labelsForTrack } from "../../genres/trackGenres";
import {
  applyEvent,
  applyJoinEvidence,
  emptyProfile,
  type TasteProfile,
} from "./tasteProfile";

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
  profile = applyEvent(profile, {
    artist: track.artists,
    trackId: track.id,
    // The two label kinds are passed APART (v2): a Playlist Genre is
    // the owner's own filing and lands at full rate; a basic Genre
    // is source metadata and lands at the weakest. Merging them into
    // one flat list — v1's way — priced the owner's signal at the
    // mixed rate and hid the difference.
    ...(labels.playlistGenres.length > 0
      ? { playlistGenres: labels.playlistGenres }
      : {}),
    ...(labels.genres.length > 0 ? { genres: labels.genres } : {}),
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

/**
 * The profile with the brain's DJ history folded in: performed joins
 * are weak positive evidence for the tracks they joined. Read-only —
 * the stored profile is untouched; the caller (the For You layer)
 * ranks against the returned copy.
 */
/**
 * The join-evidence shape this tracker folds into the profile —
 * exactly the fields tasteProfile.applyJoinEvidence reads (the two
 * sides' audio fingerprints and when the join happened). It is a
 * local structural type on purpose: no engine module owns this
 * record type any more, and this kept module imports nothing from
 * the DJ engine. Any record source
 * carrying these three fields (the new engine's behaviour record
 * adapted by its caller, a test fixture) satisfies it.
 */
export interface TasteJoinEvidence {
  /** Audio fingerprints; null when a side carried none — skipped. */
  aAudioHash: string | null;
  bAudioHash: string | null;
  at: number;
}

export function getTasteProfileWithJoins(
  joins: readonly TasteJoinEvidence[],
  trackIdByAudioHash: ReadonlyMap<string, string>,
): TasteProfile {
  return applyJoinEvidence(profile, joins, trackIdByAudioHash, Date.now());
}
