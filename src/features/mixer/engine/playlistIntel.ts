import type { TrackAnalysis } from "./analyseTrack";
import { candidateFromAnalysis, type SetCandidate } from "./curatedSet";
import { vocalDensityOf } from "./joinHistory";
import { keyCompatibility } from "./keyCompatibility";
import type { PreparedTrack } from "./trackSource";

// Playlist intelligence (revamp R6): the whole-playlist musical
// picture Addendum A asks liveRave to build of the ACTIVE playlist
// — "tempo compatibility, harmonic compatibility, intro and outro
// suitability, vocal and instrumental sections, energy progression,
// genre relationships, transition opportunities" — built
// PROGRESSIVELY from the analysis cache (the reconciliation's
// standing reading of blueprint §30): a fast pass over whatever
// analyses exist right now, deepening as preparation lands more of
// the playlist. It never blocks and never analyses anything
// itself; tracks whose analysis is not yet known are counted as
// pending, not guessed at.
//
// The picture has three consumers:
//
//   - Track choice (the brain's chooseNextTrack): per-candidate
//     fit scores against the playing track and the set's arc
//     target — the ruled HYBRID set-level view (Note 19, ruling
//     3): this layer's arc targets steer WHICH track comes next;
//     the joins themselves are still decided and performed pair
//     by pair underneath.
//   - The minimum-play floor (Note 19, ruling 1): each fact
//     carries the end of the track's first big section.
//   - The buy-time loop (Note 19, ruling 2): each analysis can
//     name a grid-true loop span at its tail.
//
// Everything here is pure: callers supply the prepared tracks the
// cache currently holds; the module owns no storage and no clock.

/** The owner's label sets for a track, as curation already reads them. */
export interface TrackLabels {
  playlistGenres?: string[];
  genres?: string[];
}

/** One track of the playlist, as the intelligence layer knows it. */
export interface TrackFacts {
  trackId: string;
  /** Analysis fingerprint of the exact audio (null when unhashed). */
  audioHash: string | null;
  bpm: number;
  key: TrackAnalysis["key"];
  /** 0..1 absolute peak energy (candidateFromAnalysis's read). */
  energy: number;
  /** 0..1 — how strongly the tempo read stood out. */
  tempoConfidence: number;
  /** Whole-track vocal density 0..1, or null without vocal evidence. */
  vocalDensity: number | null;
  /** 0..1 — how well this track OPENS a slot, or null without sections. */
  introSuitability: number | null;
  /** 0..1 — how well this track CLOSES a slot, or null without sections. */
  outroSuitability: number | null;
  /**
   * The minimum-play floor (Note 19, ruling 1): the second until
   * which a started song is owed before the DJ may move on — the
   * end of its first big section (see minimumPlayEndSec). Null
   * when the analysis carries no usable section data; the floor
   * abstains then rather than inventing a number.
   */
  minimumPlayEndSec: number | null;
  durationSec: number;
  playlistGenres?: string[];
  genres?: string[];
}

/** The section classes that count as a song's first BIG section. */
const BIG_SECTION_KINDS: ReadonlySet<string> = new Set(["chorus", "drop"]);

/**
 * The minimum-play floor, exactly as ruled (Note 19, ruling 1):
 * a started song is owed at least through its first big section.
 * "First big section" is read from analysis v2's sections as the
 * first section whose kind is chorus or drop — the first major
 * arrival a listener is waiting for, sung or instrumental. A
 * track whose sections hold no chorus/drop still has a floor:
 * the end of its first section (the DJ owes the song its opening
 * statement, whatever shape it takes). A track with NO usable
 * section data — an unanalysed shell, a legacy analysis — has no
 * floor: null, and the session plays it under the standing rules
 * (a shell is never blended anyway; the floor binds joins, and
 * there are no joins into or out of a shell).
 */
export function minimumPlayEndSec(analysis: TrackAnalysis): number | null {
  const sections = analysis.sections;
  if (!sections || sections.length === 0) return null;
  const first =
    sections.find((section) => BIG_SECTION_KINDS.has(section.kind)) ??
    sections[0];
  if (!first || !(first.endSec > 0)) return null;
  const duration = analysis.beatMap.durationSec;
  return duration > 0 ? Math.min(first.endSec, duration) : first.endSec;
}

function peakSectionRms(analysis: TrackAnalysis): number {
  return (analysis.sections ?? []).reduce(
    (max, section) => Math.max(max, section.meanRms),
    0,
  );
}

/**
 * How well a track opens: a declared intro (or an opening section
 * the analyser labelled intro) is a real opening; a quiet first
 * section that builds is a usable one; a track that starts at
 * full tilt offers neither. Null without sections or intro bounds
 * — unknown, never guessed.
 */
export function introSuitability(analysis: TrackAnalysis): number | null {
  if (analysis.intro && analysis.intro.endSec - analysis.intro.startSec >= 1) {
    return 0.85;
  }
  const sections = analysis.sections;
  if (!sections || sections.length === 0) return null;
  const first = sections[0];
  if (first.kind === "intro") return 0.8;
  const peak = peakSectionRms(analysis);
  if (peak > 0 && first.meanRms <= 0.6 * peak) return 0.55;
  return 0.35;
}

/** How well a track closes — the mirror of introSuitability. */
export function outroSuitability(analysis: TrackAnalysis): number | null {
  if (analysis.outro && analysis.outro.endSec - analysis.outro.startSec >= 1) {
    return 0.85;
  }
  const sections = analysis.sections;
  if (!sections || sections.length === 0) return null;
  const last = sections[sections.length - 1];
  if (last.kind === "outro") return 0.8;
  const peak = peakSectionRms(analysis);
  if (peak > 0 && last.meanRms <= 0.6 * peak) return 0.55;
  return 0.35;
}

/** Derives the intelligence layer's facts for one analysed track. */
export function factsFromAnalysis(
  trackId: string,
  analysis: TrackAnalysis,
  labels?: TrackLabels,
): TrackFacts {
  const candidate: SetCandidate = candidateFromAnalysis(
    trackId,
    analysis,
    labels,
  );
  return {
    trackId,
    audioHash: analysis.audioHash ?? null,
    bpm: candidate.bpm,
    key: candidate.key,
    energy: candidate.energy,
    tempoConfidence: analysis.tempoConfidence,
    vocalDensity: vocalDensityOf(analysis),
    introSuitability: introSuitability(analysis),
    outroSuitability: outroSuitability(analysis),
    minimumPlayEndSec: minimumPlayEndSec(analysis),
    durationSec: analysis.beatMap.durationSec,
    ...(candidate.playlistGenres
      ? { playlistGenres: candidate.playlistGenres }
      : {}),
    ...(candidate.genres ? { genres: candidate.genres } : {}),
  };
}

/** Facts for a prepared track, when it carries a real analysis. */
export function factsFromPrepared(
  prepared: PreparedTrack,
  labels?: TrackLabels,
): TrackFacts {
  return factsFromAnalysis(prepared.track.id, prepared.analysis, labels);
}

// ---------------------------------------------------------------------
// The whole-playlist picture
// ---------------------------------------------------------------------

/** Energy group boundaries on the absolute energy scale. */
export const ENERGY_GROUP_EDGES = { low: 0.35, mid: 0.6, peak: 0.8 } as const;

export type EnergyGroupName = "low" | "mid" | "high" | "peak";

export function energyGroupOf(energy: number): EnergyGroupName {
  if (energy >= ENERGY_GROUP_EDGES.peak) return "peak";
  if (energy >= ENERGY_GROUP_EDGES.mid) return "high";
  if (energy >= ENERGY_GROUP_EDGES.low) return "mid";
  return "low";
}

/** Pairwise fit at or above which two tracks share a transition cluster. */
export const CLUSTER_FIT_THRESHOLD = 0.75;

export interface PlaylistIntel {
  /** Facts for every track whose analysis is known, by track id. */
  factsById: ReadonlyMap<string, TrackFacts>;
  /** Track ids with a known (mixable) analysis, in playlist order. */
  knownTrackIds: string[];
  /** Track ids not yet analysed, in playlist order. */
  pendingTrackIds: string[];
  /** Known tracks grouped by absolute energy. */
  energyGroups: Record<EnergyGroupName, string[]>;
  /**
   * Transition clusters: groups of two or more known tracks that
   * can carry a run (tempo + key compatible pairwise through the
   * cluster's links) — Addendum A's "transition opportunities".
   */
  clusters: string[][];
  meanBpm: number | null;
  meanEnergy: number | null;
}

/** The curation tempo curve (curatedSet's shape): full within ±8%. */
function tempoFit(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  const ratio = Math.max(a, b) / Math.min(a, b);
  if (ratio <= 1.08) return 1;
  if (ratio >= 1.25) return 0;
  return 1 - (ratio - 1.08) / 0.17;
}

/** Tempo + key compatibility alone — the cluster relation. */
export function clusterFit(a: TrackFacts, b: TrackFacts): number {
  const key = keyCompatibility(a.key, b.key);
  const keyScore = key ? key.score : 0.5;
  return 0.5 * tempoFit(a.bpm, b.bpm) + 0.5 * keyScore;
}

/**
 * Builds the picture from what the cache holds RIGHT NOW. The
 * caller supplies, per playlist entry, the prepared track when
 * one is known (mixable only — a shell has no musical facts to
 * build from) or nothing. Rebuilding after preparation lands is
 * how the picture deepens; the build itself is cheap and pure.
 */
export function buildPlaylistIntel(
  entries: readonly {
    trackId: string;
    prepared?: PreparedTrack | null;
    labels?: TrackLabels;
  }[],
): PlaylistIntel {
  const factsById = new Map<string, TrackFacts>();
  const knownTrackIds: string[] = [];
  const pendingTrackIds: string[] = [];
  for (const entry of entries) {
    if (entry.prepared && entry.prepared.mixable !== false) {
      factsById.set(
        entry.trackId,
        factsFromPrepared(entry.prepared, entry.labels),
      );
      knownTrackIds.push(entry.trackId);
    } else {
      pendingTrackIds.push(entry.trackId);
    }
  }
  const known = knownTrackIds
    .map((id) => factsById.get(id))
    .filter((facts) => facts !== undefined);

  const energyGroups: Record<EnergyGroupName, string[]> = {
    low: [],
    mid: [],
    high: [],
    peak: [],
  };
  for (const facts of known) {
    energyGroups[energyGroupOf(facts.energy)].push(facts.trackId);
  }

  // Transition clusters by union-find over the cluster relation.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  for (const facts of known) parent.set(facts.trackId, facts.trackId);
  for (let i = 0; i < known.length; i += 1) {
    for (let j = i + 1; j < known.length; j += 1) {
      if (clusterFit(known[i], known[j]) >= CLUSTER_FIT_THRESHOLD) {
        const ri = find(known[i].trackId);
        const rj = find(known[j].trackId);
        if (ri !== rj) parent.set(ri, rj);
      }
    }
  }
  const byRoot = new Map<string, string[]>();
  for (const facts of known) {
    const root = find(facts.trackId);
    const group = byRoot.get(root) ?? [];
    group.push(facts.trackId);
    byRoot.set(root, group);
  }
  const clusters = [...byRoot.values()].filter((group) => group.length >= 2);

  return {
    factsById,
    knownTrackIds,
    pendingTrackIds,
    energyGroups,
    clusters,
    meanBpm:
      known.length > 0
        ? known.reduce((sum, f) => sum + f.bpm, 0) / known.length
        : null,
    meanEnergy:
      known.length > 0
        ? known.reduce((sum, f) => sum + f.energy, 0) / known.length
        : null,
  };
}

// ---------------------------------------------------------------------
// Track-candidate scoring — blueprint §14.1, spent on tracks
// ---------------------------------------------------------------------

/**
 * §14.1's candidate weights as they map onto track evidence.
 * Variety (.10) is deliberately NOT a score component: exactly
 * as R5's mapping recorded for joins, variety is spent as §15's
 * probability shaping over history, not as positive evidence.
 * The remaining weights are renormalised over their .90 sum so
 * scores live on the same 0..1 scale the epsilon band expects.
 */
export const TRACK_FIT_WEIGHTS = {
  tempo: 0.15,
  key: 0.15,
  energy: 0.2,
  genre: 0.1,
  structure: 0.15,
  rhythm: 0.1,
  vocal: 0.05,
} as const;

const TRACK_FIT_WEIGHT_SUM = Object.values(TRACK_FIT_WEIGHTS).reduce(
  (sum, w) => sum + w,
  0,
);

export interface TrackFitParts {
  tempo: number;
  key: number;
  energy: number;
  genre: number;
  structure: number;
  rhythm: number;
  vocal: number;
}

export interface TrackFit {
  /** 0..1 — higher is a better next track from here. */
  score: number;
  parts: TrackFitParts;
}

function sharedLabel(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean | null {
  if (!a || a.length === 0 || !b || b.length === 0) return null;
  return a.some((label) => b.includes(label));
}

/**
 * Scores one candidate track against the playing track (or, for
 * the set's opener, against nothing — pair components read their
 * neutral 0.5 and the score is carried by energy-to-arc and
 * opening structure). Every component falls back to neutral on
 * missing evidence rather than inventing a signal; in particular
 * the genre component is served by the owner's Playlist Genre
 * labels (basic Genre labels only when no Playlist Genre labels
 * exist on either side), through R4's resolved shared-label
 * credit: a credit above 0.5 rewards continuing the owner's
 * category, below 0.5 (Open Format, or genre flexibility bent
 * down) rewards roaming away from it — §14.1's genre weight and
 * R4's genre-flexibility track-candidate half, spent in one
 * number.
 */
export function trackFitScore(
  current: TrackFacts | null,
  candidate: TrackFacts,
  context: {
    /** The energy the set's arc wants the next entry to land at. */
    arcTargetEnergy: number;
    /** R4's resolved credit for sharing the owner's label. */
    sharedLabelCredit: number;
  },
): TrackFit {
  const w = TRACK_FIT_WEIGHTS;

  const tempo = current ? tempoFit(current.bpm, candidate.bpm) : 0.5;
  const key = current
    ? (keyCompatibility(current.key, candidate.key)?.score ?? 0.5)
    : 0.5;
  const energy = 1 - Math.abs(candidate.energy - context.arcTargetEnergy);

  let genre = 0.5;
  if (current) {
    const shared =
      sharedLabel(current.playlistGenres, candidate.playlistGenres) ??
      sharedLabel(current.genres, candidate.genres);
    if (shared !== null) {
      genre = shared
        ? context.sharedLabelCredit
        : 1 - context.sharedLabelCredit;
    }
  }

  let structure: number;
  if (!current) {
    structure = candidate.introSuitability ?? 0.5;
  } else if (
    candidate.introSuitability !== null &&
    current.outroSuitability !== null
  ) {
    structure = (candidate.introSuitability + current.outroSuitability) / 2;
  } else {
    structure = candidate.introSuitability ?? current.outroSuitability ?? 0.5;
  }

  const rhythm = current
    ? Math.min(current.tempoConfidence, candidate.tempoConfidence)
    : candidate.tempoConfidence;

  let vocal = 0.5;
  if (
    current &&
    current.vocalDensity !== null &&
    candidate.vocalDensity !== null
  ) {
    const currentSings = current.vocalDensity > 0.25;
    const candidateSings = candidate.vocalDensity > 0.25;
    vocal =
      currentSings && candidateSings
        ? 0.3
        : currentSings || candidateSings
          ? 0.75
          : 1;
  }

  const parts: TrackFitParts = {
    tempo,
    key,
    energy,
    genre,
    structure,
    rhythm,
    vocal,
  };
  const score =
    (w.tempo * parts.tempo +
      w.key * parts.key +
      w.energy * parts.energy +
      w.genre * parts.genre +
      w.structure * parts.structure +
      w.rhythm * parts.rhythm +
      w.vocal * parts.vocal) /
    TRACK_FIT_WEIGHT_SUM;
  return { score, parts };
}

// ---------------------------------------------------------------------
// The buy-time loop span (Note 19, ruling 2)
// ---------------------------------------------------------------------

/** A loop shorter than this is a stutter, not a musical repeat. */
export const BUY_TIME_MIN_SPAN_SEC = 2;
/** A loop longer than this stops being "briefly". */
export const BUY_TIME_MAX_SPAN_SEC = 20;
/** The span the loop aims for: four bars, sixteen beats. */
export const BUY_TIME_SPAN_BEATS = 16;
/** A track shorter than this has no tail worth looping. */
export const BUY_TIME_MIN_TRACK_SEC = 8;

export interface BuyTimeLoopSpan {
  startSec: number;
  endSec: number;
}

/**
 * The grid-true loop span at a track's tail: the final
 * BUY_TIME_SPAN_BEATS beats, placed on the analysis's beat grid
 * (the same anchors recipe loops are authored from), ending at
 * the track's end. Null when the analysis cannot name an honest
 * loop point — no grid, no anchors in range, a track too short
 * to have a tail — in which case the buy-time loop does not
 * exist for this track and the end-of-track floor stands as it
 * always has. Looping is a musical move; without the grid there
 * is no musical place to put it.
 */
export function buyTimeLoopSpan(
  analysis: TrackAnalysis,
): BuyTimeLoopSpan | null {
  const duration = analysis.beatMap.durationSec;
  if (!(duration >= BUY_TIME_MIN_TRACK_SEC)) return null;
  const grid = analysis.beatMap.grid;
  if (!grid || grid.anchors.length === 0) return null;
  const bpm = analysis.beatMap.bpm;
  if (!(bpm > 0)) return null;
  const targetSpanSec = (BUY_TIME_SPAN_BEATS * 60) / bpm;
  let best: BuyTimeLoopSpan | null = null;
  let bestDistance = Infinity;
  for (const anchor of grid.anchors) {
    const span = duration - anchor.timeSec;
    if (span < BUY_TIME_MIN_SPAN_SEC || span > BUY_TIME_MAX_SPAN_SEC) {
      continue;
    }
    const distance = Math.abs(span - targetSpanSec);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { startSec: anchor.timeSec, endSec: duration };
    }
  }
  return best;
}
