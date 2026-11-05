// Smart Shuffle facts: the flat musical facts the ordering and
// admission layers read, derived from the NEW engine's stored
// analyses, plus the pairwise fit instrument admission spends.
//
// Lineage, stated plainly: the old world kept these shapes in the
// old DJ's intelligence layer (playlistIntel's TrackFacts and
// trackFitScore, curatedSet's SHARED_LABEL_CREDIT). That layer was
// purged with the old DJ, and the new engine's own facts
// (liverave/facts TrackFacts) are a different, richer shape built
// for authoring joins — not for this feature's flat reads. So the
// feature now carries its own facts layer, exactly the way the
// For You feed carries factsFromTrackRead: the derivations and the
// fit instrument below are the old ones, weight for weight and
// component for component, re-expressed over the new engine's
// TrackRead. Nothing about the scoring semantics changed; only
// the shapes the evidence arrives in.
//
// What the new read cannot supply, the derivation says so with a
// null rather than inventing a value — the standing discipline:
// the old section-based vocal fallback has no new-world source
// (new sections carry no vocal field), so vocal density is the
// graded-window read or null.

import {
  keyFitBetween,
  type TrackRead,
  type TrackReadKey,
} from "@/features/mixer/liverave/facts";

/** The owner's label sets for a track, as curation already reads them. */
export interface SmartTrackLabels {
  playlistGenres?: string[];
  genres?: string[];
}

/** One track, as Smart Shuffle's ordering/admission layers know it. */
export interface SmartTrackIntel {
  trackId: string;
  /** Beats per minute; 0 when no read measured one. */
  bpm: number;
  key: TrackReadKey | null;
  /** 0..1 absolute peak energy (the derivation below). */
  energy: number;
  /** 0..1 — how strongly the tempo read stood out. */
  tempoConfidence: number;
  /** Whole-track vocal density 0..1, or null without vocal evidence. */
  vocalDensity: number | null;
  /** 0..1 — how well this track OPENS a slot, or null without sections. */
  introSuitability: number | null;
  /** 0..1 — how well this track CLOSES a slot, or null without sections. */
  outroSuitability: number | null;
  playlistGenres?: string[];
  genres?: string[];
}

// ---------------------------------------------------------------------
// Derivation from a TrackRead
// ---------------------------------------------------------------------

/**
 * The absolute-energy reference (the curation stack's constant,
 * carried here with the derivation): an RMS at this level reads
 * as full energy.
 */
export const ABSOLUTE_ENERGY_REFERENCE_RMS = 0.35;

/**
 * The track's absolute peak energy, the old curation derivation
 * unchanged: the mean level of its loudest kind of section — a
 * drop if it has one, else a chorus, else its single loudest
 * span — read against the absolute reference; without sections,
 * the loudest quarter of the energy contour, read the same way;
 * without a contour, the loudest quarter of the per-second curve
 * (already normalised 0..1, spent as-is, as the v1 fallback did).
 */
function energyFromRead(read: TrackRead): number {
  const sections = read.sections;
  if (sections && sections.length > 0) {
    const loudestOf = (kind: string) =>
      sections
        .filter((section) => section.kind === kind)
        .reduce((max, section) => Math.max(max, section.meanEnergy), 0);
    const peak =
      loudestOf("drop") ||
      loudestOf("chorus") ||
      sections.reduce((max, section) => Math.max(max, section.meanEnergy), 0);
    if (peak > 0) return Math.min(1, peak / ABSOLUTE_ENERGY_REFERENCE_RMS);
  }
  const contour = read.energyContour;
  if (contour && contour.length > 0) {
    const levels = contour.map((bin) => bin.rms).sort((a, b) => b - a);
    const topQuarter = levels.slice(
      0,
      Math.max(1, Math.ceil(levels.length / 4)),
    );
    const mean =
      topQuarter.reduce((sum, value) => sum + value, 0) / topQuarter.length;
    if (mean > 0) return Math.min(1, mean / ABSOLUTE_ENERGY_REFERENCE_RMS);
  }
  const perSec = read.energyCurvePerSec;
  if (perSec && perSec.length > 0) {
    const levels = [...perSec].sort((a, b) => b - a);
    const topQuarter = levels.slice(
      0,
      Math.max(1, Math.ceil(levels.length / 4)),
    );
    return topQuarter.length > 0
      ? topQuarter.reduce((sum, value) => sum + value, 0) / topQuarter.length
      : 0;
  }
  return 0;
}

/**
 * How well a track opens, the old suitability read over the new
 * sections: a declared intro is a real opening; a quiet first
 * section that builds is a usable one; a track that starts at
 * full tilt offers neither. The old analyser carried the intro as
 * separate bounds beside its sections and spent bounds of a
 * second or more at 0.85, a merely labelled intro section at 0.8;
 * the new read's sections are the only declaration it makes, so
 * an opening intro section of a second or more takes the 0.85
 * branch and a shorter one the 0.8. Null without sections —
 * unknown, never guessed.
 */
function introSuitability(read: TrackRead): number | null {
  const sections = read.sections;
  if (!sections || sections.length === 0) return null;
  const first = sections[0];
  if (first.kind === "intro") {
    return first.endMs - first.startMs >= 1000 ? 0.85 : 0.8;
  }
  const peak = sections.reduce(
    (max, section) => Math.max(max, section.meanEnergy),
    0,
  );
  if (peak > 0 && first.meanEnergy <= 0.6 * peak) return 0.55;
  return 0.35;
}

/** How well a track closes — the mirror of introSuitability. */
function outroSuitability(read: TrackRead): number | null {
  const sections = read.sections;
  if (!sections || sections.length === 0) return null;
  const last = sections[sections.length - 1];
  if (last.kind === "outro") {
    return last.endMs - last.startMs >= 1000 ? 0.85 : 0.8;
  }
  const peak = sections.reduce(
    (max, section) => Math.max(max, section.meanEnergy),
    0,
  );
  if (peak > 0 && last.meanEnergy <= 0.6 * peak) return 0.55;
  return 0.35;
}

/**
 * Whole-track vocal density 0..1, or null when the read carries
 * no vocal windows. The old read averaged its graded activity
 * curve's points; the new read carries graded windows (spans),
 * so the density is the activity-weighted share of the track —
 * the same number for the uniformly sampled curves the old
 * analyser produced, and the read the For You feed takes from
 * the same windows.
 */
function vocalDensityOf(read: TrackRead): number | null {
  const windows = read.vocalActivity;
  if (!windows || windows.length === 0) return null;
  if (!(read.durationSec > 0)) return null;
  let vocalMs = 0;
  for (const window of windows) {
    if (!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) {
      continue;
    }
    const activity = Math.min(1, Math.max(0, window.activity));
    vocalMs += Math.max(0, window.endMs - window.startMs) * activity;
  }
  const density = vocalMs / (read.durationSec * 1000);
  return Math.min(1, Math.max(0, density));
}

/** Derives Smart Shuffle's flat facts for one track from its read. */
export function factsFromRead(
  trackId: string,
  read: TrackRead,
  labels?: SmartTrackLabels,
): SmartTrackIntel {
  return {
    trackId,
    bpm:
      typeof read.bpm === "number" && Number.isFinite(read.bpm) ? read.bpm : 0,
    key: read.key ?? null,
    energy: energyFromRead(read),
    tempoConfidence:
      typeof read.tempoConfidence === "number" &&
      Number.isFinite(read.tempoConfidence)
        ? read.tempoConfidence
        : 0,
    vocalDensity: vocalDensityOf(read),
    introSuitability: introSuitability(read),
    outroSuitability: outroSuitability(read),
    ...(labels?.playlistGenres?.length
      ? { playlistGenres: [...labels.playlistGenres] }
      : {}),
    ...(labels?.genres?.length ? { genres: [...labels.genres] } : {}),
  };
}

// ---------------------------------------------------------------------
// The pairwise fit instrument (admission's gate)
// ---------------------------------------------------------------------

/**
 * The curation stack's resolved credit for sharing the owner's
 * Playlist Genre label (formerly curatedSet's constant, spent by
 * the fit instrument's genre component and passed by admission):
 * above neutral 0.5, so continuing the owner's category earns.
 */
export const SHARED_LABEL_CREDIT = 0.6;

/**
 * §14.1's candidate weights as they map onto track evidence,
 * unchanged from the instrument admission has always spent.
 * Variety (.10) is deliberately NOT a score component: it is
 * spent as probability shaping over history, not as positive
 * evidence. The weights are renormalised over their .90 sum so
 * scores live on the 0..1 scale.
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

/** The curation tempo curve: full within ±8%, zero at ≥25%. */
function tempoFit(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  const ratio = Math.max(a, b) / Math.min(a, b);
  if (ratio <= 1.08) return 1;
  if (ratio >= 1.25) return 0;
  return 1 - (ratio - 1.08) / 0.17;
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
 * exist on either side), through the resolved shared-label
 * credit: a credit above 0.5 rewards continuing the owner's
 * category, below 0.5 rewards roaming away from it. The key
 * component spends the new engine's own Camelot fit
 * (liverave/facts keyFitBetween), whose table is the old
 * keyCompatibility table exactly — same key 1, relative 0.9,
 * adjacent 0.85, diagonal 0.6, parallel 0.5, near 0.35, distant
 * 0.1 — so the component's values did not move in the re-point.
 */
export function trackFitScore(
  current: SmartTrackIntel | null,
  candidate: SmartTrackIntel,
  context: {
    /** The energy the set's arc wants the next entry to land at. */
    arcTargetEnergy: number;
    /** The resolved credit for sharing the owner's label. */
    sharedLabelCredit: number;
  },
): TrackFit {
  const w = TRACK_FIT_WEIGHTS;

  const tempo = current ? tempoFit(current.bpm, candidate.bpm) : 0.5;
  const key = current
    ? (keyFitBetween(current.key, candidate.key)?.score ?? 0.5)
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
