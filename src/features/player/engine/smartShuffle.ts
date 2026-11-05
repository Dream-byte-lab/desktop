// Smart Shuffle ordering: the pure sequencing heart of the Smart
// Shuffle feature (user order, 2026-11-05).
//
// Plain shuffle is a dice roll: it knows nothing about the listener
// or the music. This module orders the ACTIVE PLAYLIST's upcoming
// tracks from evidence the app already holds:
//
//   - taste: the taste profile's pull toward each track, spent
//     through tasteProfile.forYouScore exactly as the For You layer
//     spends it (artist dominant, track and label weights
//     supporting), normalised across the candidate set;
//   - recency rest: tracks heard very recently sink — a song the
//     listener just heard should not headline the next hour;
//   - flow: neighbour-to-neighbour tempo/energy continuity, read
//     from analyses that ALREADY exist. Nothing here analyses
//     anything; a track without facts simply contributes no flow
//     evidence, never a guess;
//   - artist separation: no avoidable back-to-back same-artist
//     runs, and a softer push against the same artist two picks
//     later;
//   - the owner's Playlist Genre labels: continuing the category
//     the previous track sits in earns a small credit, spent the
//     way playlistIntel's genre component spends it (basic Genre
//     labels only when neither side carries Playlist Genres).
//
// SEEDED VARIETY is a requirement, not a garnish (the standing
// anti-formula ruling): scores only SHAPE the order. Each pick is
// drawn from the band of candidates within SMART_SHUFFLE_WEIGHTS
// .band of the step's best score — the §4/§15 spirit, probability
// shaping over near-equals — using a seeded RNG, so the same
// playlist re-rolled with a new seed comes back different, and a
// given seed always reproduces its order exactly (auditable,
// testable).
//
// Guests (recommendation tracks admitted by smartShuffleAdmission)
// ride the same sequencing with two extra gates, enforced here so
// no caller can break them: a guest never takes the first upcoming
// slot, and guests never exceed GUEST_RATIO of the upcoming queue
// at any prefix — the playlist stays the body of the set.
//
// Everything is pure: callers supply the playlist's candidates, the
// playing track, the taste snapshot, the recency list, whatever
// facts exist, and the seed. No storage, no clock, no network.

import {
  decayProfile,
  forYouScore,
  type TasteProfile,
} from "@/features/mixer/engine/tasteProfile";

/** One track the ordering may place, as the ordering sees it. */
export interface SmartCandidateInput {
  trackId: string;
  /** Display artist string, as the taste profile keys it. */
  artist: string;
  /**
   * Artist identity for separation decisions (primary artist,
   * normalised by the caller); falls back to `artist`.
   */
  artistKey?: string;
  /** The owner's Playlist Genre labels for this track. */
  playlistGenres?: string[];
  /** Basic Genre labels (the enrichment socket; usually absent). */
  genres?: string[];
  /** True for an admitted recommendation guest, not a playlist member. */
  guest?: boolean;
}

/** The musical facts the flow term reads; nulls mean "unknown". */
export interface SmartTrackFacts {
  bpm: number | null;
  energy: number | null;
}

export const SMART_SHUFFLE_WEIGHTS = {
  /** Static pull of the taste profile (normalised -1..1). */
  taste: 0.55,
  /** Deepest recency sink, for the most recently heard candidate. */
  recency: 0.5,
  /** How fast the recency sink fades, in plays-ago. */
  recencyFadePlays: 5,
  /** Neighbour flow term, applied centred (± half this at extremes). */
  flow: 0.35,
  /** Step credit for continuing the owner's Playlist Genre label. */
  genre: 0.12,
  /** Same artist as the previous pick, when an alternative exists. */
  artistClash: 0.85,
  /** Same artist as the pick before the previous, when avoidable. */
  artistEcho: 0.3,
  /** §4-style sampling band under each step's best score. */
  band: 0.12,
} as const;

/** Guests may hold at most this share of the upcoming queue. */
export const GUEST_RATIO = 0.25;

/**
 * How many guests an upcoming run of `playlistUpcomingCount`
 * playlist tracks may carry: guests ≤ GUEST_RATIO of the RESULTING
 * upcoming, i.e. guests ≤ playlist / 3. Zero for tiny queues — a
 * three-song playlist earns no guests.
 */
export function maxGuestsFor(playlistUpcomingCount: number): number {
  const count = Math.max(0, Math.floor(playlistUpcomingCount));
  return Math.floor(count / 3);
}

/** Deterministic seeded RNG (mulberry32): same seed, same stream. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function artistKeyOf(candidate: SmartCandidateInput): string {
  const raw = candidate.artistKey ?? candidate.artist ?? "";
  return raw.split(",")[0]?.trim().toLowerCase() ?? "";
}

/** The static (position-independent) part of a candidate's score. */
export interface SmartStaticScore {
  /** Taste pull, normalised across the candidate set to -1..1. */
  taste: number;
  /** Recency sink actually applied (0 = not recently heard). */
  recencySink: number;
  /** taste * weight − recencySink. */
  base: number;
}

/**
 * The static scores for a candidate set: taste normalised against
 * the set's own extremes (a profile that loves everything in the
 * list equally moves nothing), recency sunk by plays-ago with an
 * exponential fade. Exported so tests — and any future surface —
 * can read WHY the ordering leans the way it does.
 */
export function smartStaticScores(
  candidates: readonly SmartCandidateInput[],
  agedProfile: TasteProfile,
  recentPlays: readonly string[],
): SmartStaticScore[] {
  const raws = candidates.map((candidate) =>
    forYouScore(
      {
        trackId: candidate.trackId,
        artist: candidate.artist,
        ...(candidate.playlistGenres
          ? { playlistGenres: candidate.playlistGenres }
          : {}),
        ...(candidate.genres ? { genres: candidate.genres } : {}),
      },
      agedProfile,
    ),
  );
  const maxPositive = Math.max(0, ...raws);
  const maxNegative = Math.max(0, ...raws.map((raw) => -raw));
  const playsAgoById = new Map<string, number>();
  recentPlays.forEach((trackId, index) => {
    if (!playsAgoById.has(trackId)) playsAgoById.set(trackId, index);
  });
  return candidates.map((candidate, index) => {
    const raw = raws[index];
    const taste =
      raw >= 0
        ? maxPositive > 0
          ? raw / maxPositive
          : 0
        : maxNegative > 0
          ? raw / maxNegative
          : 0;
    const playsAgo = playsAgoById.get(candidate.trackId);
    const recencySink =
      playsAgo === undefined
        ? 0
        : SMART_SHUFFLE_WEIGHTS.recency *
          Math.exp(-playsAgo / SMART_SHUFFLE_WEIGHTS.recencyFadePlays);
    return {
      taste,
      recencySink,
      base: SMART_SHUFFLE_WEIGHTS.taste * taste - recencySink,
    };
  });
}

/** The curation tempo curve (playlistIntel's shape): full within ±8%. */
function tempoFit(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  const ratio = Math.max(a, b) / Math.min(a, b);
  if (ratio <= 1.08) return 1;
  if (ratio >= 1.25) return 0;
  return 1 - (ratio - 1.08) / 0.17;
}

/** 0..1 neighbour fit from whatever facts both sides carry; null = no evidence. */
function flowScore(
  prev: SmartTrackFacts | null,
  candidate: SmartTrackFacts | null,
): number | null {
  if (!prev || !candidate) return null;
  const parts: number[] = [];
  if (prev.bpm !== null && candidate.bpm !== null) {
    parts.push(tempoFit(prev.bpm, candidate.bpm));
  }
  if (prev.energy !== null && candidate.energy !== null) {
    parts.push(1 - Math.min(1, Math.abs(prev.energy - candidate.energy) / 0.5));
  }
  if (parts.length === 0) return null;
  return parts.reduce((sum, part) => sum + part, 0) / parts.length;
}

function sharedLabel(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean | null {
  if (!a || a.length === 0 || !b || b.length === 0) return null;
  return a.some((label) => b.includes(label));
}

export interface SmartShuffleInput<
  T extends SmartCandidateInput = SmartCandidateInput,
> {
  /** The playing track the order flows out of; null when unknown. */
  current: SmartCandidateInput | null;
  /** The playing track's facts, when an analysis already exists. */
  currentFacts?: SmartTrackFacts | null;
  /** The upcoming tracks to order (playlist members + admitted guests). */
  candidates: readonly T[];
  /** Facts by track id, for the candidates that have any. */
  factsById?: ReadonlyMap<string, SmartTrackFacts | null>;
  /** The raw taste snapshot; decayed here against `nowMs`. */
  profile: TasteProfile;
  nowMs: number;
  /** Track ids heard recently, most recent first (may repeat). */
  recentPlays: readonly string[];
  /** The roll's seed: a new seed is a new order. */
  seed: number;
}

/**
 * Orders the candidates. Greedy, step by step: each step scores the
 * remaining candidates (static base + flow/genre/artist step terms
 * against the previous pick), then draws the pick from the band
 * within `band` of the best step score. The playing track is never
 * part of the input — the caller pins it at the head itself.
 */
export function smartShuffleOrder<T extends SmartCandidateInput>(
  input: SmartShuffleInput<T>,
): T[] {
  const { candidates } = input;
  if (candidates.length <= 1) return [...candidates];

  const agedProfile = decayProfile(input.profile, input.nowMs);
  const statics = smartStaticScores(candidates, agedProfile, input.recentPlays);
  const rng = mulberry32(input.seed);
  const w = SMART_SHUFFLE_WEIGHTS;

  const playlistTotal = candidates.filter((c) => !c.guest).length;
  const guestCap = maxGuestsFor(playlistTotal);

  const remaining: { candidate: T; index: number; artistKey: string }[] =
    candidates.map((candidate, index) => ({
      candidate,
      index,
      artistKey: artistKeyOf(candidate),
    }));

  const ordered: T[] = [];
  let prev: SmartCandidateInput | null = input.current;
  let prevFacts: SmartTrackFacts | null = input.currentFacts ?? null;
  let prevArtistKey = prev ? artistKeyOf(prev) : null;
  let prevPrevArtistKey: string | null = null;
  let placedGuests = 0;

  while (remaining.length > 0) {
    const placedTotal = ordered.length;

    // Guest gates, in tiers: the strict gates first; if they would
    // strand every remaining candidate, relax the prefix rules
    // before the global cap, and the cap last — completeness of
    // the playlist's order always wins, the cap was already
    // enforced at admission time.
    const gateTiers: ((entry: (typeof remaining)[number]) => boolean)[] = [
      (entry) =>
        !entry.candidate.guest ||
        (placedTotal >= 1 &&
          placedGuests < guestCap &&
          (placedGuests + 1) * 4 <= placedTotal + 1),
      (entry) => !entry.candidate.guest || placedGuests < guestCap,
      () => true,
    ];
    let eligible = remaining;
    for (const gate of gateTiers) {
      const gated = remaining.filter(gate);
      if (gated.length > 0) {
        eligible = gated;
        break;
      }
    }

    const alternativeArtistExists =
      new Set(eligible.map((entry) => entry.artistKey)).size > 1;

    const scored = eligible.map((entry) => {
      let step = statics[entry.index].base;
      const facts = input.factsById?.get(entry.candidate.trackId) ?? null;
      const flow = flowScore(prevFacts, facts);
      if (flow !== null) step += w.flow * (flow - 0.5);
      if (prev) {
        const shared =
          sharedLabel(prev.playlistGenres, entry.candidate.playlistGenres) ??
          sharedLabel(prev.genres, entry.candidate.genres);
        if (shared !== null) step += shared ? w.genre : -w.genre / 3;
        if (alternativeArtistExists) {
          if (entry.artistKey !== "" && entry.artistKey === prevArtistKey) {
            step -= w.artistClash;
          } else if (
            entry.artistKey !== "" &&
            entry.artistKey === prevPrevArtistKey
          ) {
            step -= w.artistEcho;
          }
        }
      }
      return { entry, step };
    });

    const best = Math.max(...scored.map((s) => s.step));
    const band = scored.filter((s) => s.step >= best - w.band);
    const pick = band[Math.floor(rng() * band.length)] ?? band[0];

    ordered.push(pick.entry.candidate);
    if (pick.entry.candidate.guest) placedGuests += 1;
    remaining.splice(remaining.indexOf(pick.entry), 1);
    prevPrevArtistKey = prevArtistKey;
    prevArtistKey = pick.entry.artistKey;
    prev = pick.entry.candidate;
    prevFacts = input.factsById?.get(pick.entry.candidate.trackId) ?? null;
  }

  return ordered;
}
