// canMix.ts — the One Ruler (optimisation wave item 1; ADAPTATION A4).
//
// ONE predicate answers "can these two tracks physically blend?"
// for every part of the engine: the planner (brain draw / slate
// assembly), the referee (the session's commit-time re-check and
// the authors' pair-feasibility gate), and the fallback ladder.
// There is no second, private notion of fit anywhere: a check that
// lives here is deleted or delegated to at its old home.
//
// The predicate is tiered, because "can mix" is four different
// claims, weakest last:
//
//   "phrase-blend" — a proven phrase-aligned, vocal-safe,
//                    key-compatible beatmatched blend.
//   "beatmatch"    — proven beat grids + a feasible sustained
//                    rate; no phrase/vocal/key claims.
//   "phrase-cut"   — a phrase boundary exists to leave A on and
//                    a phrase entry exists on B; no blend claims.
//   "crossfade"    — the tracks can be fetched/decoded through
//                    the DJ path and have known durations. This
//                    tier makes no musical claims at all.
//
// Three proof outcomes, never two:
//   "proven"   — every check at this tier passed on witnessed
//                evidence.
//   "unproven" — a check could not be proven: missing or
//                low-confidence evidence (unknown key, unwitnessed
//                vocals, untrusted grids, unknown resolvability).
//                Unknown FAILS CLOSED at every tier: unproven is
//                never read as pass. A lower tier may still prove.
//   "refused"  — a check positively failed: a track cannot be
//                resolved through the DJ path (the local-file
//                lesson: playable by the plain player is NOT the
//                same question), tempos sit outside the rates the
//                performer can sustain, or witnessed vocals
//                collide across the whole blend window. Refusal
//                at a blend tier never refuses the tiers below.
//
// Resolvability is an INPUT, not something this module fetches:
// the caller states what it knows ("resolved" when the decoded
// buffer is in hand, "unresolvable" when the DJ-path resolve
// failed, "unknown" when nobody has tried). Facts-only callers
// (the authors) pass "unknown" and read the musical proof only;
// the session passes the real state, so a track the DJ cannot
// load is unmixable BY DEFINITION at the point of decision.

import type { TrackFacts } from "./facts";
import { beatmatchRate, trackMsPerBeat } from "./kernel";

// ---------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------

export type MixTier = "phrase-blend" | "beatmatch" | "phrase-cut" | "crossfade";

/** Tiers in ladder order, strongest claim first. */
export const MIX_TIERS: readonly MixTier[] = [
  "phrase-blend",
  "beatmatch",
  "phrase-cut",
  "crossfade",
];

export type MixProof = "proven" | "unproven" | "refused";

export type Resolvability = "resolved" | "unresolvable" | "unknown";

/** Sustained beatmatch rates must sit inside this window. */
export const RATE_FEASIBILITY_MIN = 0.92;
/** Sustained beatmatch rates must sit inside this window. */
export const RATE_FEASIBILITY_MAX = 1.08;

/** Distant-key pairs may only blend across at most this many beats. */
export const DISTANT_KEY_BLEND_CAP_BEATS = 8;

/**
 * Vocal collision line: when BOTH sides' witnessed mean vocal
 * activity across the blend window clears this, the window is
 * vocal-over-vocal by measurement, not by guess.
 */
export const VOCAL_COLLISION_MIN = 0.5;

/** Default blend window length for pair-level (windowless) proofs. */
export const DEFAULT_BLEND_BEATS = 16;

export interface MixWindow {
  aStartMs: number;
  aEndMs: number;
  bStartMs: number;
  bEndMs: number;
}

export interface CanMixOptions {
  tier: MixTier;
  /** DJ-path resolvability of the outgoing track (default "unknown"). */
  resolvableA?: Resolvability;
  /** DJ-path resolvability of the incoming track (default "unknown"). */
  resolvableB?: Resolvability;
  /** The exact blend window to prove (a recipe's anchors). */
  window?: MixWindow;
  /** Blend length in beats, for the distant-key cap. */
  windowBeats?: number;
}

export interface CanMixMargins {
  /** Sustained rate that beatmatches B onto A; null when unknown. */
  tempoRatio: number | null;
  /** Facts-level key fit score; null when either key is unknown. */
  keyScore: number | null;
  /** Key relation ("same" / "relative" / …); null when unknown. */
  keyRelation: string | null;
  /** True when BOTH sides' blend-window vocals were witnessed. */
  vocalWitnessed: boolean;
  /**
   * Simultaneous vocal activity across the window: the lesser of
   * the two sides' witnessed means (both must be loud at once for
   * a collision). Null when either side is unwitnessed.
   */
  vocalOverlap: number | null;
  /** A's provable exit phrase boundary, when one exists. */
  exitPhraseAtMs: number | null;
  /** B's provable entry phrase boundary, when one exists. */
  entryPhraseAtMs: number | null;
}

export interface CanMixResult {
  tier: MixTier;
  proof: MixProof;
  /** Human-readable reasons for every non-pass; empty when proven. */
  reasons: string[];
  margins: CanMixMargins;
}

// ---------------------------------------------------------------------
// Geography helpers
// ---------------------------------------------------------------------

/**
 * A's provable exit boundary: the first phrase boundary at or
 * after the track's minimum-play floor (the DJ may not leave
 * before the floor), falling back to the outro span's start.
 */
export function exitBoundaryMs(factsA: TrackFacts): number | null {
  const floor = factsA.minimumPlayMs ?? 0;
  for (const phrase of factsA.phrases) {
    if (phrase.startMs >= floor - 1) return phrase.startMs;
  }
  if (factsA.outro && factsA.outro.startMs >= floor - 1) {
    return factsA.outro.startMs;
  }
  return null;
}

/**
 * B's provable entry boundary: its first phrase boundary, falling
 * back to the end of its intro span (entering as the intro ends
 * is entering on a boundary by construction).
 */
export function entryBoundaryMs(factsB: TrackFacts): number | null {
  if (factsB.phrases.length > 0) return factsB.phrases[0].startMs;
  if (factsB.intro) return factsB.intro.endMs;
  return null;
}

/**
 * The beatmatch sub-proof, shared verbatim with the authors'
 * pair-feasibility gate (which used to keep its own copy): both
 * grids trusted AND the sustained rate inside the feasible
 * window. Returns the rate as well so callers never recompute it.
 */
export function beatmatchProven(
  factsA: TrackFacts,
  factsB: TrackFacts,
): { proven: boolean; ratio: number | null } {
  const ratio = beatmatchRate(factsA.tempo.bpm, factsB.tempo.bpm);
  const proven =
    factsA.beatmatchTrusted &&
    factsB.beatmatchTrusted &&
    ratio !== null &&
    ratio >= RATE_FEASIBILITY_MIN &&
    ratio <= RATE_FEASIBILITY_MAX;
  return { proven, ratio };
}

function defaultWindow(
  factsA: TrackFacts,
  factsB: TrackFacts,
  exitAt: number | null,
  entryAt: number | null,
): MixWindow {
  const msA = trackMsPerBeat(factsA) ?? 500;
  const msB = trackMsPerBeat(factsB) ?? 500;
  const spanA = DEFAULT_BLEND_BEATS * msA;
  const spanB = DEFAULT_BLEND_BEATS * msB;
  const durationA = factsA.durationMs ?? 0;
  const aEnd =
    exitAt !== null ? Math.min(durationA, exitAt + spanA) : durationA;
  const aStart = Math.max(0, aEnd - spanA);
  const bStart = entryAt ?? 0;
  return {
    aStartMs: aStart,
    aEndMs: aEnd,
    bStartMs: bStart,
    bEndMs: bStart + spanB,
  };
}

// ---------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------

export function canMix(
  factsA: TrackFacts,
  factsB: TrackFacts,
  options: CanMixOptions,
): CanMixResult {
  const tier = options.tier;
  const resolvableA = options.resolvableA ?? "unknown";
  const resolvableB = options.resolvableB ?? "unknown";
  const reasons: string[] = [];
  let refused = false;
  let unproven = false;
  const refuse = (reason: string): void => {
    refused = true;
    reasons.push(reason);
  };
  const fail = (reason: string): void => {
    unproven = true;
    reasons.push(reason);
  };

  const exitAt = exitBoundaryMs(factsA);
  const entryAt = entryBoundaryMs(factsB);
  const ratio = beatmatchRate(factsA.tempo.bpm, factsB.tempo.bpm);
  const keyFit = factsA.keyFitTo(factsB);

  const margins: CanMixMargins = {
    tempoRatio: ratio,
    keyScore: keyFit ? keyFit.score : null,
    keyRelation: keyFit ? keyFit.relation : null,
    vocalWitnessed: false,
    vocalOverlap: null,
    exitPhraseAtMs: exitAt,
    entryPhraseAtMs: entryAt,
  };

  // -- The DJ-path gate (every tier) --------------------------------
  // A track the DJ path cannot fetch/decode is unmixable BY
  // DEFINITION, however good the musical evidence looks. This is
  // the split-definition behind the local-file failure, closed.
  if (resolvableA === "unresolvable") {
    refuse("the outgoing track cannot be resolved through the DJ path");
  }
  if (resolvableB === "unresolvable") {
    refuse("the incoming track cannot be resolved through the DJ path");
  }
  // Unknown resolvability fails closed at every tier: "nobody has
  // tried" is not evidence the DJ path can load the track. (The
  // guaranteed rung is only ever invoked by callers holding the
  // decoded buffer — resolved — so this never strands a session;
  // it stops a planner from treating an untried track as proven.)
  if (resolvableA === "unknown" || resolvableB === "unknown") {
    fail("DJ-path resolvability has not been established");
  }

  // -- Duration knowledge --------------------------------------------
  if (factsA.durationMs === null || factsB.durationMs === null) {
    fail("a track's duration is unknown");
  }

  if (tier === "crossfade") {
    // The weakest claim: resolvable + timed (both handled above).
    return finish(tier, refused, unproven, reasons, margins);
  }

  // -- Phrase geography (phrase-cut and phrase-blend only) -----------
  if (tier === "phrase-cut" || tier === "phrase-blend") {
    if (exitAt === null) {
      fail(
        "no phrase boundary on the outgoing track at or after its play floor",
      );
    }
    if (entryAt === null) {
      fail("no phrase entry on the incoming track");
    }
    if (tier === "phrase-cut") {
      return finish(tier, refused, unproven, reasons, margins);
    }
  }

  // -- Beatmatch proof -------------------------------------------------
  if (!factsA.beatmatchTrusted || !factsB.beatmatchTrusted) {
    fail("tempo/grid evidence is below the trust lines on one side");
  }
  if (ratio === null) {
    fail("a track's tempo is unknown");
  } else if (ratio < RATE_FEASIBILITY_MIN || ratio > RATE_FEASIBILITY_MAX) {
    refuse(
      `the sustained beatmatch rate ${ratio.toFixed(3)} sits outside the feasible window [${RATE_FEASIBILITY_MIN}, ${RATE_FEASIBILITY_MAX}]`,
    );
  }
  if (tier === "beatmatch") {
    return finish(tier, refused, unproven, reasons, margins);
  }

  // -- Phrase-blend proof (the full claim) -----------------------------
  // Key: an unknown key fails closed at this tier (never silently
  // passed); a distant key is provable only across a short window.
  if (keyFit === null) {
    fail("a track's key is unknown");
  } else if (!keyFit.compatible) {
    const beats = options.windowBeats ?? DEFAULT_BLEND_BEATS;
    if (beats > DISTANT_KEY_BLEND_CAP_BEATS) {
      fail(
        `distant keys (${keyFit.relation}) may only blend across ${DISTANT_KEY_BLEND_CAP_BEATS} beats, not ${beats}`,
      );
    }
  }

  // Vocals: the blend window must be witnessed on BOTH sides, and
  // witnessed-loud on both sides at once is a measured collision.
  const window =
    options.window ?? defaultWindow(factsA, factsB, exitAt, entryAt);
  const vocalA = factsA.vocals.vocalActivityIn(window.aStartMs, window.aEndMs);
  const vocalB = factsB.vocals.vocalActivityIn(window.bStartMs, window.bEndMs);
  margins.vocalWitnessed = vocalA.witnessed && vocalB.witnessed;
  if (!vocalA.witnessed || !vocalB.witnessed) {
    fail(
      "vocal activity across the blend window is not witnessed on both sides",
    );
  } else {
    margins.vocalOverlap = Math.min(vocalA.mean, vocalB.mean);
    if (margins.vocalOverlap >= VOCAL_COLLISION_MIN) {
      refuse(
        `vocals collide across the blend window (both sides witnessed at ≥ ${VOCAL_COLLISION_MIN} activity)`,
      );
    }
  }

  return finish(tier, refused, unproven, reasons, margins);
}

function finish(
  tier: MixTier,
  refused: boolean,
  unproven: boolean,
  reasons: string[],
  margins: CanMixMargins,
): CanMixResult {
  return {
    tier,
    proof: refused ? "refused" : unproven ? "unproven" : "proven",
    reasons,
    margins,
  };
}
