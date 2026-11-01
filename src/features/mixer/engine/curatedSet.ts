import type { TrackAnalysis } from "./analyseTrack";
import { keyCompatibility } from "./keyCompatibility";

// Curated sets: the difference between a playlist and a DJ set is the
// ORDER. A playlist is a list someone made; a set is a journey a DJ
// planned — it opens gently, builds, peaks, breathes and lands, and
// each join is chosen so the next track sits musically well against
// the one before it (key and tempo), not just thematically.
//
// This assembler builds that journey from a pool of analysed tracks:
// for each slot in the set it knows the energy the arc wants there,
// and greedily picks the unused track that best matches that energy
// while joining compatibly with the previous pick. It is how a
// curated set can be generated from the user's own library/playlists
// today, and how hand-curated pools get their professional shape.
//
// Playlist Genre note: curation draws from a pool the owner chose
// (one of their playlists, their library), so the owner's own
// categorisation is respected by construction — the assembler only
// re-orders within the pool it is given, never reaches outside it.

export interface SetCandidate {
  trackId: string;
  bpm: number;
  key: TrackAnalysis["key"];
  /** 0..1 — the track's peak energy: the mean of its loudest quarter. */
  energy: number;
}

/** Derives a curation candidate from a track's analysis. */
export function candidateFromAnalysis(
  trackId: string,
  analysis: TrackAnalysis,
): SetCandidate {
  const energies = analysis.energyCurve
    .map((point) => point.energy)
    .sort((a, b) => b - a);
  const topQuarter = energies.slice(
    0,
    Math.max(1, Math.ceil(energies.length / 4)),
  );
  const energy =
    topQuarter.length > 0
      ? topQuarter.reduce((sum, value) => sum + value, 0) / topQuarter.length
      : 0;
  return {
    trackId,
    bpm: analysis.beatMap.bpm,
    key: analysis.key,
    energy,
  };
}

// The arc: energy targets along the set, as (position 0..1, energy).
// Opens low, builds through the first half, peaks just past the
// middle, releases, and lands where it started.
const ARC_POINTS: [number, number][] = [
  [0, 0.3],
  [0.25, 0.55],
  [0.55, 0.9],
  [0.8, 0.6],
  [1, 0.3],
];

/** The energy the arc wants at a position in the set (0..1). */
export function arcTarget(position: number): number {
  const t = Math.min(1, Math.max(0, position));
  for (let i = 1; i < ARC_POINTS.length; i += 1) {
    const [x1, y1] = ARC_POINTS[i];
    if (t <= x1) {
      const [x0, y0] = ARC_POINTS[i - 1];
      return y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
    }
  }
  return ARC_POINTS[ARC_POINTS.length - 1][1];
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

/**
 * Orders a pool of candidates into a curated set: arc-shaped energy,
 * compatible joins. Deterministic — the same pool always yields the
 * same set. Returns track ids in playing order (at most `length`,
 * defaulting to the whole pool).
 */
export function assembleSet(
  candidates: SetCandidate[],
  length?: number,
): string[] {
  const target = Math.min(length ?? candidates.length, candidates.length);
  if (target <= 0) return [];

  const remaining = [...candidates];
  const chosen: SetCandidate[] = [];
  for (let slot = 0; slot < target; slot += 1) {
    const position = target === 1 ? 0 : slot / (target - 1);
    const wanted = arcTarget(position);
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      const energyFit = 1 - Math.abs(candidate.energy - wanted);
      const score =
        chosen.length === 0
          ? 2 * energyFit
          : 2 * energyFit + joinScore(chosen[chosen.length - 1], candidate);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    chosen.push(remaining.splice(bestIndex, 1)[0]);
  }
  return chosen.map((candidate) => candidate.trackId);
}
