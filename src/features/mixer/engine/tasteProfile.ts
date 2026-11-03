// The taste profile: the memory behind the adaptive "For You" layer.
//
// Liner's interface is static — it shows everyone the same shelves.
// Spotify's isn't: it adjusts to the singers and songs you actually
// listen to. This module is our version of that learning, kept to the
// same signal discipline as the live-party clues, but long-term:
//
//   - finishing a song (or riding its blend out)  → strong positive
//   - hearing almost all of it                    → positive
//   - skipping it in the first quarter            → negative
//   - skipping it late                            → near-neutral
//     (satiation is not dislike)
//   - playing it again                            → extra positive
//
// Weights decay with a 30-day half-life, so the profile follows the
// listener as their taste moves instead of fossilising their first
// week. Long-term taste is deliberately separate from in-the-moment
// session signals (liveRave's job): this profile answers "what does
// this person generally love", never "what do they want right now".
//
// v2 (Step 5): the two label kinds are kept apart, because they are
// different evidence. A Playlist Genre is the OWNER's own filing —
// the strongest tag signal there is — and lands at full rate. A
// basic Genre comes from the source's metadata and lands at the
// weakest rate. The legacy flat `tags` (mixed sources) stays at its
// supporting rate. The profile also accepts DJ-history evidence:
// joins the brain actually performed are weak positive evidence for
// the tracks they joined (see applyJoinEvidence).

export interface TasteEvent {
  artist: string;
  trackId: string;
  /** Mixed-source labels (legacy feed); applied at the supporting rate. */
  tags?: string[];
  /** The owner's own Playlist Genre labels; applied at full rate. */
  playlistGenres?: string[];
  /** Basic Genre labels from source enrichment; applied at the weakest rate. */
  genres?: string[];
  /** 0..1 — how much of the track was actually heard. */
  playedRatio: number;
  /** True when the track played out (including blending out). */
  completed: boolean;
  /** True when this listen is a deliberate replay of a heard track. */
  repeated?: boolean;
  atMs: number;
}

/** Tag application rates, by kind of evidence (see the header). */
export const TAG_RATES = {
  playlistGenre: 1,
  mixed: 0.6,
  genre: 0.3,
} as const;

export interface TasteProfile {
  artists: Record<string, number>;
  tags: Record<string, number>;
  tracks: Record<string, number>;
  updatedAtMs: number;
}

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export function emptyProfile(atMs = 0): TasteProfile {
  return { artists: {}, tags: {}, tracks: {}, updatedAtMs: atMs };
}

/** Ages every weight toward zero by the profile's half-life. */
export function decayProfile(
  profile: TasteProfile,
  nowMs: number,
): TasteProfile {
  const elapsed = nowMs - profile.updatedAtMs;
  if (elapsed <= 0) return profile;
  const factor = Math.pow(0.5, elapsed / HALF_LIFE_MS);
  if (factor > 0.999) return profile;
  const scale = (map: Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(map)) {
      const aged = value * factor;
      if (Math.abs(aged) >= 0.01) out[key] = aged;
    }
    return out;
  };
  return {
    artists: scale(profile.artists),
    tags: scale(profile.tags),
    tracks: scale(profile.tracks),
    updatedAtMs: nowMs,
  };
}

function eventWeight(event: TasteEvent): number {
  let weight: number;
  if (event.completed || event.playedRatio >= 0.9) weight = 1;
  else if (event.playedRatio < 0.25) weight = -0.7;
  else if (event.playedRatio < 0.5) weight = -0.15;
  else weight = 0.25;
  if (event.repeated && weight > 0) weight += 0.5;
  return weight;
}

/** Folds one listening event into the profile. Pure — returns a new one. */
export function applyEvent(
  profile: TasteProfile,
  event: TasteEvent,
): TasteProfile {
  const aged = decayProfile(profile, event.atMs);
  const weight = eventWeight(event);
  const bump = (map: Record<string, number>, key: string, amount: number) => {
    if (!key) return;
    map[key] = (map[key] ?? 0) + amount;
  };
  const artists = { ...aged.artists };
  const tags = { ...aged.tags };
  const tracks = { ...aged.tracks };
  bump(artists, event.artist, weight);
  bump(tracks, event.trackId, weight);
  for (const tag of event.tags ?? []) bump(tags, tag, weight * TAG_RATES.mixed);
  for (const tag of event.playlistGenres ?? []) {
    bump(tags, tag, weight * TAG_RATES.playlistGenre);
  }
  for (const tag of event.genres ?? []) {
    bump(tags, tag, weight * TAG_RATES.genre);
  }
  return { artists, tags, tracks, updatedAtMs: event.atMs };
}

export interface ForYouCandidate {
  trackId: string;
  artist: string;
  tags?: string[];
  playlistGenres?: string[];
  genres?: string[];
}

/**
 * How strongly the profile pulls toward a candidate: the artist's
 * weight dominates, the track's own history and its tags support.
 * Tag KINDS are not re-rated here — the rate was applied when the
 * evidence landed, so scoring simply spends the tag bucket.
 */
export function forYouScore(
  candidate: ForYouCandidate,
  profile: TasteProfile,
): number {
  let score = profile.artists[candidate.artist] ?? 0;
  score += (profile.tracks[candidate.trackId] ?? 0) * 0.5;
  const labels = [
    ...(candidate.tags ?? []),
    ...(candidate.playlistGenres ?? []),
    ...(candidate.genres ?? []),
  ];
  for (const tag of labels) {
    score += (profile.tags[tag] ?? 0) * 0.5;
  }
  return score;
}

/**
 * Ranks candidates for a For You surface, most-wanted first. Stable:
 * equally-scored candidates keep their input order. With an empty
 * profile everything scores 0 and the input order survives — a new
 * listener gets the shelf as-is until the profile has something to
 * say. (Pure exploitation in v1; a discovery/exploration mix is a
 * later refinement.)
 */
export function rankForYou(
  candidates: ForYouCandidate[],
  profile: TasteProfile,
  nowMs: number,
): ForYouCandidate[] {
  const aged = decayProfile(profile, nowMs);
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: forYouScore(candidate, aged),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate);
}

/** The profile's strongest artists, for display and set-building. */
export function topArtists(
  profile: TasteProfile,
  nowMs: number,
  limit = 10,
): { artist: string; weight: number }[] {
  const aged = decayProfile(profile, nowMs);
  return Object.entries(aged.artists)
    .map(([artist, weight]) => ({ artist, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

// ---------------------------------------------------------------------
// DJ-history evidence
// ---------------------------------------------------------------------

/** The join-shaped facts this module needs (joinHistory's record). */
export interface JoinEvidence {
  /** Audio fingerprints; null when a side carried none — skipped. */
  aAudioHash: string | null;
  bAudioHash: string | null;
  at: number;
}

/** Per-join evidence weight: a performed join is weak proof of fit. */
export const JOIN_EVIDENCE = {
  asIncoming: 0.2,
  asOutgoing: 0.1,
  /** No track may gain more than this from joins alone. */
  capPerTrack: 0.6,
} as const;

/**
 * Folds the brain's performed joins into a COPY of the profile: a
 * track the brain keeps joining into the night — and the room keeps
 * hearing — earns a small positive track weight, whether or not a
 * full listen event was recorded for it. Joins are keyed by audio
 * fingerprint; `trackIdByAudioHash` is the caller's map from the
 * tracks it prepared. Evidence is deliberately weak and capped: the
 * DJ's choices support taste, they do not substitute for the
 * listener's own completions and skips, which recordListen carries.
 */
export function applyJoinEvidence(
  profile: TasteProfile,
  joins: readonly JoinEvidence[],
  trackIdByAudioHash: ReadonlyMap<string, string>,
  nowMs: number,
): TasteProfile {
  const aged = decayProfile(profile, nowMs);
  const gains = new Map<string, number>();
  const add = (hash: string | null, amount: number) => {
    if (!hash) return;
    const trackId = trackIdByAudioHash.get(hash);
    if (!trackId) return;
    gains.set(
      trackId,
      Math.min(JOIN_EVIDENCE.capPerTrack, (gains.get(trackId) ?? 0) + amount),
    );
  };
  for (const join of joins) {
    add(join.bAudioHash, JOIN_EVIDENCE.asIncoming);
    add(join.aAudioHash, JOIN_EVIDENCE.asOutgoing);
  }
  if (gains.size === 0) return aged;
  const tracks = { ...aged.tracks };
  for (const [trackId, gain] of gains) {
    tracks[trackId] = (tracks[trackId] ?? 0) + gain;
  }
  return { ...aged, tracks };
}
