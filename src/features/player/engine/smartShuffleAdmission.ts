// Smart Shuffle guest admission: the gate every recommendation
// track must pass before it may join the queue as a guest (user
// ruling, 2026-11-05 — insertions built, under the brain's own
// rules).
//
// A guest earns its slot musically or it does not enter:
//
//   - TASTE GATE (cold-start honesty, the For You layer's standing
//     rule): unless the taste profile can name an artist the
//     listener has demonstrably loved — at least one full
//     completion's worth of weight, decayed to now — there are NO
//     insertions at all. A thin profile gets no faked
//     personalisation; Smart Shuffle then only orders the
//     playlist, which needs no one's permission.
//   - FIT TEST: the candidate is scored with the pairwise fit
//     instrument this feature has always spent — trackFitScore,
//     carried in smartShuffleFacts since the old DJ's intelligence
//     layer was purged, weight for weight unchanged — against the
//     playing track's facts and the set's arc target energy, with
//     the curation stack's shared-label credit. Below
//     GUEST_FIT_THRESHOLD the slot is refused: neutral (0.5) is
//     not earning anything.
//   - TASTE PULL: the candidate must be someone the profile
//     actually points at (forYouScore > 0). A perfect musical fit
//     the listener has no relationship with is radio's job, not
//     this feature's.
//   - RATIO: admission stops at the caller's cap (smartShuffle's
//     maxGuestsFor — at most one guest in four queue slots). The
//     playlist stays the body of the set.
//
// The DJ path spends this same gate at the pool door: guests sit
// in the queue the session starts from, and the engine's brain
// then applies its own suitability per pick — a guest admitted
// here can still lose every draw inside the set. This
// module is pure: callers supply facts (from analyses that already
// exist) and the profile; a candidate without facts cannot be
// fit-tested and is refused, never waved through.

import {
  SHARED_LABEL_CREDIT,
  trackFitScore,
  type SmartTrackIntel,
} from "./smartShuffleFacts";
import {
  decayProfile,
  forYouScore,
  type TasteProfile,
} from "@/features/mixer/engine/tasteProfile";

/** trackFitScore at or above this earns a guest its slot. */
export const GUEST_FIT_THRESHOLD = 0.55;

/**
 * The taste gate's bar: one completed listen of an artist's track
 * lands +1 of artist weight (tasteProfile.eventWeight), so this
 * asks for exactly one real completion's worth of love, after
 * decay — the smallest honest claim that the profile knows the
 * listener at all.
 */
export const GUEST_TASTE_MIN_ARTIST_WEIGHT = 1;

/** True when the profile is thick enough to admit guests at all. */
export function hasInsertionTaste(
  profile: TasteProfile,
  nowMs: number,
): boolean {
  const aged = decayProfile(profile, nowMs);
  return Object.values(aged.artists).some(
    (weight) => weight >= GUEST_TASTE_MIN_ARTIST_WEIGHT,
  );
}

/** A recommendation candidate carrying the facts admission reads. */
export interface GuestCandidate {
  trackId: string;
  artist: string;
  playlistGenres?: string[];
  genres?: string[];
  /** Facts from an analysis that already exists — required. */
  facts: SmartTrackIntel;
}

export interface GuestAdmissionInput {
  /** The playing track's facts; null when it has no analysis. */
  current: SmartTrackIntel | null;
  /** The energy the set's arc wants guests to land near. */
  arcTargetEnergy: number;
  /** Recommendation candidates with facts, in rail order. */
  pool: readonly GuestCandidate[];
  profile: TasteProfile;
  nowMs: number;
  /** Ratio cap for this queue (smartShuffle.maxGuestsFor). */
  maxGuests: number;
  /** Fit bar override; defaults to GUEST_FIT_THRESHOLD. */
  fitThreshold?: number;
}

/**
 * Admits up to `maxGuests` guests from the pool, best musical fit
 * first (fit ties break toward the stronger taste pull). Returns
 * the admitted candidates in admission order; the caller weaves
 * them into the queue — placement is the ordering module's job.
 */
export function admitGuests(input: GuestAdmissionInput): GuestCandidate[] {
  if (input.maxGuests <= 0) return [];
  if (input.pool.length === 0) return [];
  if (!hasInsertionTaste(input.profile, input.nowMs)) return [];

  const aged = decayProfile(input.profile, input.nowMs);
  const threshold = input.fitThreshold ?? GUEST_FIT_THRESHOLD;

  const scored = input.pool
    .map((candidate) => ({
      candidate,
      fit: trackFitScore(input.current, candidate.facts, {
        arcTargetEnergy: input.arcTargetEnergy,
        sharedLabelCredit: SHARED_LABEL_CREDIT,
      }).score,
      taste: forYouScore(
        {
          trackId: candidate.trackId,
          artist: candidate.artist,
          ...(candidate.playlistGenres
            ? { playlistGenres: candidate.playlistGenres }
            : {}),
          ...(candidate.genres ? { genres: candidate.genres } : {}),
        },
        aged,
      ),
    }))
    .filter((entry) => entry.fit >= threshold && entry.taste > 0)
    .sort((a, b) => b.fit - a.fit || b.taste - a.taste);

  return scored.slice(0, input.maxGuests).map((entry) => entry.candidate);
}
