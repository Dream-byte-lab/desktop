import type { TrackAnalysis } from "./analyseTrack";
import { keyCompatibility } from "./keyCompatibility";

// Curated sets: the difference between a playlist and a DJ set is the
// ORDER. A playlist is a list someone made; a set is a journey a DJ
// planned — it opens gently, builds, peaks, breathes and lands, and
// each join is chosen so the next track sits musically well against
// the one before it (key and tempo), not just thematically.
//
// v2 (Step 5, blueprint §3.5) keeps the assembler's judgement and
// widens its context:
//
//   - The arc is a SHAPE CHOSEN FOR THE NIGHT from the pool's own
//     energy and the owner's labels — the v1 arc survives as the
//     "classic" shape, the default, not the only one.
//   - Energy is read ABSOLUTELY where v2 analysis exists: a
//     section's mean RMS is comparable between tracks by
//     construction, where the v1 energy curve was peak-normalised
//     per track (a whisper-quiet track's loudest moment read 1.0).
//     The v1 derivation remains the fallback for v1-shaped
//     analyses, unchanged.
//   - Per-slot choice is among scored NEAR-EQUALS with the brain's
//     anti-repetition discipline: repeating the previous slot's join
//     relation is charged, sharing the owner's Playlist Genre with
//     the previous pick is credited, and a rotation seed (the night
//     so far) can turn the band — so the same pool under a different
//     context may yield a different set, while the same pool under
//     the same context always yields the same one.
//
// Playlist Genre note: curation draws from a pool the owner chose
// (one of their playlists, their library), so the owner's own
// categorisation is respected by construction — the assembler only
// re-orders within the pool it is given, never reaches outside it.

export interface SetCandidate {
  trackId: string;
  bpm: number;
  key: TrackAnalysis["key"];
  /** 0..1 — the track's peak energy (see candidateFromAnalysis). */
  energy: number;
  /** The owner's Playlist Genre labels for this track, when known. */
  playlistGenres?: string[];
  /** Basic Genre labels from source enrichment, when known. */
  genres?: string[];
}

/**
 * The absolute reference a section's mean RMS is read against: a
 * loud mastered section sits around 0.35 RMS. Energies stay on the
 * arc's 0..1 scale, but two tracks' energies are now honestly
 * comparable — a quiet track reads quiet.
 */
export const ABSOLUTE_ENERGY_REFERENCE_RMS = 0.35;

/** Derives a curation candidate from a track's analysis. */
export function candidateFromAnalysis(
  trackId: string,
  analysis: TrackAnalysis,
  labels?: { playlistGenres?: string[]; genres?: string[] },
): SetCandidate {
  return {
    trackId,
    bpm: analysis.beatMap.bpm,
    key: analysis.key,
    energy: candidateEnergy(analysis),
    ...(labels?.playlistGenres?.length
      ? { playlistGenres: [...labels.playlistGenres] }
      : {}),
    ...(labels?.genres?.length ? { genres: [...labels.genres] } : {}),
  };
}

function candidateEnergy(analysis: TrackAnalysis): number {
  // v2: absolute section energy. The peak a track reaches is the
  // mean level of its loudest kind of section — a drop if it has
  // one, else a chorus, else its single loudest span.
  const sections = analysis.sections;
  if (sections && sections.length > 0) {
    const loudestOf = (kind: string) =>
      sections
        .filter((section) => section.kind === kind)
        .reduce((max, section) => Math.max(max, section.meanRms), 0);
    const peakRms =
      loudestOf("drop") ||
      loudestOf("chorus") ||
      sections.reduce((max, section) => Math.max(max, section.meanRms), 0);
    if (peakRms > 0) {
      return Math.min(1, peakRms / ABSOLUTE_ENERGY_REFERENCE_RMS);
    }
  }
  // v2 contour without sections: the loudest quarter, read absolutely.
  const contour = analysis.energyContour;
  if (contour && contour.length > 0) {
    const levels = contour.map((point) => point.rms).sort((a, b) => b - a);
    const topQuarter = levels.slice(
      0,
      Math.max(1, Math.ceil(levels.length / 4)),
    );
    const mean =
      topQuarter.reduce((sum, value) => sum + value, 0) / topQuarter.length;
    if (mean > 0) return Math.min(1, mean / ABSOLUTE_ENERGY_REFERENCE_RMS);
  }
  // v1 fallback, unchanged: peak-normalised curve, loudest quarter.
  const energies = analysis.energyCurve
    .map((point) => point.energy)
    .sort((a, b) => b - a);
  const topQuarter = energies.slice(
    0,
    Math.max(1, Math.ceil(energies.length / 4)),
  );
  return topQuarter.length > 0
    ? topQuarter.reduce((sum, value) => sum + value, 0) / topQuarter.length
    : 0;
}

// ---------------------------------------------------------------------
// Arc shapes: energy targets along the set, (position 0..1, energy).
// ---------------------------------------------------------------------

export type ArcShapeName = "classic" | "front-peak" | "slow-burn";

export const ARC_SHAPES: Record<ArcShapeName, [number, number][]> = {
  // The v1 arc: opens low, builds through the first half, peaks just
  // past the middle, releases, lands where it started.
  classic: [
    [0, 0.3],
    [0.25, 0.55],
    [0.55, 0.9],
    [0.8, 0.6],
    [1, 0.3],
  ],
  // A pool of hot material: arrive early, peak before the middle,
  // spend the second half landing with control.
  "front-peak": [
    [0, 0.35],
    [0.2, 0.85],
    [0.45, 0.9],
    [0.75, 0.55],
    [1, 0.3],
  ],
  // A pool of warm material: patience — a long build to one late peak.
  "slow-burn": [
    [0, 0.25],
    [0.35, 0.45],
    [0.7, 0.7],
    [0.88, 0.92],
    [1, 0.35],
  ],
};

/** The energy the arc wants at a position in the set (0..1). */
export function arcTarget(
  position: number,
  shape: ArcShapeName = "classic",
): number {
  const points = ARC_SHAPES[shape];
  const t = Math.min(1, Math.max(0, position));
  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    if (t <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/**
 * Chooses the night's arc shape from the pool itself (blueprint
 * §3.5: the shape is chosen for the night from set context). A pool
 * dominated by peak material peaks early; a pool of warm material
 * burns slow; anything mixed — or too small to judge — gets the
 * classic shape. Deterministic in the pool.
 */
export function chooseArcShape(candidates: SetCandidate[]): ArcShapeName {
  if (candidates.length < 4) return "classic";
  const meanEnergy =
    candidates.reduce((sum, candidate) => sum + candidate.energy, 0) /
    candidates.length;
  const peakShare =
    candidates.filter((candidate) => candidate.energy >= 0.7).length /
    candidates.length;
  if (meanEnergy >= 0.62 && peakShare >= 0.4) return "front-peak";
  if (meanEnergy <= 0.45) return "slow-burn";
  return "classic";
}

function tempoScore(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  const ratio = Math.max(a, b) / Math.min(a, b);
  // Within the mixer's ±8% comfort counts fully; beyond that the
  // score falls away to nothing at a 25% gap.
  if (ratio <= 1.08) return 1;
  if (ratio >= 1.25) return 0;
  return 1 - (ratio - 1.08) / 0.17;
}

function joinScore(previous: SetCandidate, candidate: SetCandidate): number {
  const key = keyCompatibility(previous.key, candidate.key);
  const keyScore = key ? key.score : 0.5; // unknown key: neutral
  return 0.6 * keyScore + 0.4 * tempoScore(previous.bpm, candidate.bpm);
}

/** The join relation between two picks, categorised for repetition. */
function relationKey(previous: SetCandidate, candidate: SetCandidate): string {
  const key = keyCompatibility(previous.key, candidate.key);
  const keyScore = key ? key.score : 0.5;
  const keyBand = keyScore >= 0.75 ? "close" : keyScore >= 0.4 ? "mid" : "far";
  const tempoBand =
    tempoScore(previous.bpm, candidate.bpm) >= 1 ? "matched" : "stretched";
  return `${keyBand}/${tempoBand}`;
}

export interface AssembleOptions {
  /** The night's arc shape; classic unless chosen. */
  shape?: ArcShapeName;
  /**
   * A rotation seed from the night's context (the session passes
   * the number of joins already played): among a slot's near-equal
   * candidates the band is turned by it, so the same pool under a
   * different night may order differently. Absent = no rotation.
   */
  rotationSeed?: number;
  /**
   * Score distance within which candidates count as near-equals.
   * Absent = NEAR_EQUAL_EPSILON, the shipped default.
   */
  nearEqualEpsilon?: number;
  /**
   * Credit for continuing the owner's shared Playlist Genre label.
   * Absent = SHARED_LABEL_CREDIT, the shipped default.
   */
  sharedLabelCredit?: number;
  /**
   * Penalty the pure-score leader's rivals must overcome.
   * Absent = 0.1, the shipped default.
   */
  incumbencyPenalty?: number;
}

/** Score distance within which candidates count as near-equals. */
export const NEAR_EQUAL_EPSILON = 0.05;

/** Credit for continuing the owner's shared Playlist Genre label. */
export const SHARED_LABEL_CREDIT = 0.6;

/**
 * Orders a pool of candidates into a curated set: arc-shaped energy,
 * compatible joins, near-equal slots decided by context. The same
 * pool under the same options always yields the same set; the same
 * pool under a different arc shape, labels or rotation seed may not.
 * Returns track ids in playing order (at most `length`, defaulting
 * to the whole pool). The pool is respected absolutely: every id in
 * the result comes from the pool, and nothing outside it is reached.
 */
export function assembleSet(
  candidates: SetCandidate[],
  length?: number,
  options: AssembleOptions = {},
): string[] {
  const target = Math.min(length ?? candidates.length, candidates.length);
  if (target <= 0) return [];
  const shape = options.shape ?? "classic";
  const nearEqualEpsilon = options.nearEqualEpsilon ?? NEAR_EQUAL_EPSILON;
  const sharedLabelCredit = options.sharedLabelCredit ?? SHARED_LABEL_CREDIT;
  const incumbencyPenalty = options.incumbencyPenalty ?? 0.1;

  const remaining = [...candidates];
  const chosen: SetCandidate[] = [];
  let previousRelation: string | null = null;
  for (let slot = 0; slot < target; slot += 1) {
    const position = target === 1 ? 0 : slot / (target - 1);
    const wanted = arcTarget(position, shape);
    const previous = chosen[chosen.length - 1] as SetCandidate | undefined;
    const scored = remaining.map((candidate, index) => {
      const energyFit = 1 - Math.abs(candidate.energy - wanted);
      const score = previous
        ? 2 * energyFit + joinScore(previous, candidate)
        : 2 * energyFit;
      return { candidate, index, score };
    });
    let bestScore = -Infinity;
    for (const entry of scored) bestScore = Math.max(bestScore, entry.score);
    const band = scored.filter(
      (entry) => entry.score >= bestScore - nearEqualEpsilon,
    );
    let pick = band[0];
    if (band.length > 1) {
      // Decide among near-equals by context. The pure-score leader
      // holds a small incumbency: context must have a reason to
      // move off it (a repeated relation to avoid, an owner's label
      // to continue), or the rotation seed turns the whole band.
      const ordered = [...band];
      if (options.rotationSeed !== undefined) {
        const turn =
          (((options.rotationSeed + slot) % ordered.length) + ordered.length) %
          ordered.length;
        ordered.push(...ordered.splice(0, turn));
      }
      const penalty = (entry: (typeof band)[number]): number => {
        // Without a rotation seed the pure-score leader holds a
        // small incumbency; with one, the seed itself is the context
        // that decides among near-equals and no incumbency applies.
        let value =
          options.rotationSeed === undefined
            ? entry.score >= bestScore
              ? 0
              : incumbencyPenalty
            : 0;
        if (previous) {
          if (
            previousRelation !== null &&
            relationKey(previous, entry.candidate) === previousRelation
          ) {
            value += 1;
          }
          const sharedLabel = (entry.candidate.playlistGenres ?? []).some(
            (label) => (previous.playlistGenres ?? []).includes(label),
          );
          if (sharedLabel) value -= sharedLabelCredit;
        }
        return value;
      };
      pick = ordered.reduce((winner, entry) =>
        penalty(entry) < penalty(winner) ? entry : winner,
      );
    }
    if (previous) previousRelation = relationKey(previous, pick.candidate);
    chosen.push(remaining.splice(pick.index, 1)[0]);
  }
  return chosen.map((candidate) => candidate.trackId);
}
