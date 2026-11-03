import type { Track } from "@/shared/types";

// The personal For You feed: mixes, "because you play" rows, genre
// shelves and mood rows assembled from the listener's own evidence.
//
// This module is pure — no React, no storage, no network. The hook
// that feeds it does the gathering (history, likes, the taste
// profile, Playlist Genre filings, derived audio facts) and passes
// everything in as plain candidate data; this module only decides
// what the feed looks like. That keeps the honesty discipline of
// useHeavyRotation: a surface exists only when the listener's own
// evidence supports it, and every ordering is deterministic — the
// same inputs and seed always produce the same feed. The feed's
// only variety mechanism is a seeded rotation (see
// rotateDeterministic); there is no Math.random anywhere here.

export interface ForYouTrackFacts {
  bpm: number | null;
  meanEnergy: number | null; // 0..1
  vocalShare: number | null; // 0..1
  camelot: string | null; // e.g. "8A"
}

export interface ForYouCandidate {
  track: Track;
  plays: number; // history plays in window; 0 when not from history
  lastPlayIndex: number; // 0 = most recent play; Number.POSITIVE_INFINITY when never in history
  liked: boolean;
  tasteScore: number; // precomputed taste pull; 0 when the profile has nothing to say
  playlistGenres: string[]; // owner's own Playlist Genre labels for this track
  genres: string[]; // basic Genre labels (empty in practice today — a socket)
  facts: ForYouTrackFacts | null;
}

export type ForYouMixBasis =
  | { kind: "playlistGenre"; label: string }
  | { kind: "artistFamily"; label: string } // label = the seed artist, as given in topArtists
  | { kind: "era"; label: string } // label = decade, e.g. "2010s"
  | { kind: "derivedEnergy"; label: "high" | "low" }
  | { kind: "derivedTempo"; label: "slow" | "driving" };

/** The stable mix id for a basis. */
export function forYouMixId(basis: ForYouMixBasis): string {
  switch (basis.kind) {
    case "playlistGenre":
      return `mix:playlistGenre:${basis.label.trim().toLowerCase()}`;
    case "artistFamily":
      return `mix:artistFamily:${basis.label.trim().toLowerCase()}`;
    case "era":
      return `mix:era:${basis.label}`;
    case "derivedEnergy":
      return `mix:derivedEnergy:${basis.label}`;
    case "derivedTempo":
      return `mix:derivedTempo:${basis.label}`;
  }
}

export interface ForYouMix {
  id: string; // stable, e.g. "mix:playlistGenre:amapiano"
  basis: ForYouMixBasis;
  tracks: Track[];
}

export interface BecauseRow {
  seed: { kind: "track"; track: Track } | { kind: "artist"; artist: string };
  tracks: Track[];
}

export interface GenreShelf {
  kind: "playlistGenre" | "genre";
  label: string; // display label as filed
  tracks: Track[];
}

export type MoodKind = "lowEnergy" | "highEnergy" | "vocalLed" | "instrumental";
export interface MoodRow {
  kind: MoodKind;
  tracks: Track[];
}

export const FOR_YOU_LIMITS = {
  minMixTracks: 5,
  maxMixTracks: 20,
  maxMixes: 10,
  minRowTracks: 4,
  maxBecauseRows: 3,
  maxRowTracks: 12,
  minShelfTracks: 4,
  maxShelfTracks: 20,
  maxShelves: 6,
  minMoodTracks: 5,
  maxMoodTracks: 20,
} as const;

// ---------------------------------------------------------------------
// Deterministic seed plumbing
// ---------------------------------------------------------------------

/** FNV-1a 32-bit over the string, returned as an unsigned int. */
export function hashSeedKey(seedKey: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seedKey.length; i++) {
    hash ^= seedKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Returns a copy of `items` rotated left by `offset mod length`;
 * length 0/1 → copy unchanged. This is the feed's ONLY variety
 * mechanism: deterministic per seedKey.
 */
export function rotateDeterministic<T>(
  items: readonly T[],
  offset: number,
): T[] {
  const copy = [...items];
  if (copy.length <= 1) return copy;
  const shift = ((offset % copy.length) + copy.length) % copy.length;
  if (shift === 0) return copy;
  return [...copy.slice(shift), ...copy.slice(0, shift)];
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

/**
 * The standard ranking comparator: tasteScore desc, plays desc,
 * lastPlayIndex asc, track.id asc (lexicographic). A total order,
 * always deterministic. Written with explicit comparisons rather
 * than subtraction so two never-played candidates (lastPlayIndex
 * Infinity on both sides) cannot produce a NaN ordering.
 */
function compareCandidates(a: ForYouCandidate, b: ForYouCandidate): number {
  if (a.tasteScore !== b.tasteScore) return b.tasteScore - a.tasteScore;
  if (a.plays !== b.plays) return b.plays - a.plays;
  if (a.lastPlayIndex !== b.lastPlayIndex) {
    return a.lastPlayIndex - b.lastPlayIndex;
  }
  if (a.track.id < b.track.id) return -1;
  if (a.track.id > b.track.id) return 1;
  return 0;
}

function ranked(candidates: readonly ForYouCandidate[]): ForYouCandidate[] {
  return [...candidates].sort(compareCandidates);
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Weighted in-cluster ordering for mixes only: score =
 * 0.7 * tasteNorm + 0.3 * fit, where tasteNorm is the candidate's
 * tasteScore normalised by the pool's maximum tasteScore (0 for
 * everyone when that maximum is not positive). Ties fall back to
 * plays desc, lastPlayIndex asc, track.id asc.
 */
function weightedRanked(
  candidates: readonly ForYouCandidate[],
  maxTaste: number,
  fitOf: (candidate: ForYouCandidate) => number,
): ForYouCandidate[] {
  const scored = candidates.map((candidate) => {
    const tasteNorm = maxTaste > 0 ? candidate.tasteScore / maxTaste : 0;
    return {
      candidate,
      score: 0.7 * tasteNorm + 0.3 * fitOf(candidate),
    };
  });
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.candidate.plays !== b.candidate.plays) {
      return b.candidate.plays - a.candidate.plays;
    }
    if (a.candidate.lastPlayIndex !== b.candidate.lastPlayIndex) {
      return a.candidate.lastPlayIndex - b.candidate.lastPlayIndex;
    }
    if (a.candidate.track.id < b.candidate.track.id) return -1;
    if (a.candidate.track.id > b.candidate.track.id) return 1;
    return 0;
  });
  return scored.map((entry) => entry.candidate);
}

/** Decade label for a track's releaseDate, or null when unusable. */
function decadeOf(track: Track): string | null {
  const raw = track.releaseDate;
  if (raw == null) return null;
  const head = raw.slice(0, 4);
  if (!/^\d{4}$/.test(head)) return null;
  const year = Number.parseInt(head, 10);
  if (year < 1900 || year > 2029) return null;
  return `${Math.floor(year / 10) * 10}s`;
}

function toTracks(candidates: readonly ForYouCandidate[]): Track[] {
  return candidates.map((candidate) => candidate.track);
}

/** The track's primary artist, for display and artist matching. */
export function primaryArtistOf(track: Track): string {
  const listed = track.artistList?.[0]?.name;
  if (listed != null && listed.trim() !== "") return listed;
  const first = (track.artists ?? "").split(",")[0]?.trim() ?? "";
  if (first !== "") return first;
  return (track.artists ?? "").trim();
}

function artistKeyOf(track: Track): string {
  return primaryArtistOf(track).trim().toLowerCase();
}

function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

/** A candidate's label keys for one label list, deduped per candidate. */
function labelKeysOf(labels: readonly string[]): string[] {
  const keys: string[] = [];
  for (const label of labels) {
    const key = labelKey(label);
    if (key !== "" && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

interface LabelGroup {
  key: string;
  displayLabel: string;
  members: ForYouCandidate[];
}

/**
 * Groups candidates by a label list. Grouping key = label trimmed +
 * lowercased; display label = the first-seen original casing (of the
 * trimmed label) in candidate order. Groups are ordered by size
 * desc, then key asc.
 */
function groupByLabels(
  candidates: readonly ForYouCandidate[],
  labelsOf: (candidate: ForYouCandidate) => readonly string[],
): LabelGroup[] {
  const groups = new Map<string, LabelGroup>();
  for (const candidate of candidates) {
    for (const label of labelsOf(candidate)) {
      const key = labelKey(label);
      if (key === "") continue;
      let group = groups.get(key);
      if (!group) {
        group = { key, displayLabel: label.trim(), members: [] };
        groups.set(key, group);
      }
      if (!group.members.includes(candidate)) group.members.push(candidate);
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.members.length - a.members.length ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

// ---------------------------------------------------------------------
// Camelot compatibility
// ---------------------------------------------------------------------

function parseCamelot(
  value: string | null,
): { number: number; letter: "A" | "B" } | null {
  if (value == null) return null;
  const match = /^(\d{1,2})([AB])$/i.exec(value.trim());
  if (!match) return null;
  return {
    number: Number.parseInt(match[1], 10),
    letter: match[2].toUpperCase() as "A" | "B",
  };
}

/**
 * How well two Camelot keys sit together, 0..1, or null when either
 * side is unparseable. Same label → 1; relative (same number, other
 * letter) → 0.9; one step around the wheel, same letter → 0.85; one
 * step, other letter → 0.6; further away → 0.3 same letter, 0.1
 * other letter.
 */
export function camelotCompatibility(
  a: string | null,
  b: string | null,
): number | null {
  const parsedA = parseCamelot(a);
  const parsedB = parseCamelot(b);
  if (!parsedA || !parsedB) return null;
  const sameLetter = parsedA.letter === parsedB.letter;
  if (parsedA.number === parsedB.number) return sameLetter ? 1 : 0.9;
  const rawDistance = Math.abs(parsedA.number - parsedB.number) % 12;
  const distance = Math.min(rawDistance, 12 - rawDistance);
  if (distance === 1) return sameLetter ? 0.85 : 0.6;
  return sameLetter ? 0.3 : 0.1;
}

// ---------------------------------------------------------------------
// Mixes
// ---------------------------------------------------------------------

export function buildMixes(
  candidates: readonly ForYouCandidate[],
  options: { seedKey: string; topArtists: string[] },
): ForYouMix[] {
  const { seedKey, topArtists } = options;
  // Mixes are built only from tracks the listener demonstrably
  // leans toward: a taste pull, repeat plays, or an explicit like.
  const pool = candidates.filter(
    (candidate) =>
      candidate.tasteScore > 0 || candidate.plays >= 2 || candidate.liked,
  );

  const maxTaste = pool.reduce(
    (max, candidate) => Math.max(max, candidate.tasteScore),
    0,
  );

  const mixes: ForYouMix[] = [];
  const keptSets: Set<string>[] = [];
  const consider = (mix: ForYouMix): void => {
    if (mixes.length >= FOR_YOU_LIMITS.maxMixes) return;
    const ids = new Set(mix.tracks.map((track) => track.id));
    for (const kept of keptSets) {
      const sameSet =
        ids.size === kept.size && [...ids].every((id) => kept.has(id));
      const contained = [...ids].every((id) => kept.has(id));
      if (sameSet || contained) return;
    }
    mixes.push(mix);
    keptSets.push(ids);
  };

  const assemble = (
    members: readonly ForYouCandidate[],
    rotationKey: string,
    fitOf: (candidate: ForYouCandidate) => number,
  ): Track[] => {
    const ordered = weightedRanked(members, maxTaste, fitOf);
    const rotated = rotateDeterministic(
      ordered,
      ordered.length === 0 ? 0 : hashSeedKey(rotationKey) % ordered.length,
    );
    return toTracks(rotated.slice(0, FOR_YOU_LIMITS.maxMixTracks));
  };

  const membershipFit = (): number => 1;

  // Playlist Genre mixes first.
  for (const group of groupByLabels(pool, (c) => c.playlistGenres)) {
    if (mixes.length >= FOR_YOU_LIMITS.maxMixes) break;
    if (group.members.length < FOR_YOU_LIMITS.minMixTracks) continue;
    const basis: ForYouMixBasis = {
      kind: "playlistGenre",
      label: group.displayLabel,
    };
    consider({
      id: forYouMixId(basis),
      basis,
      tracks: assemble(
        group.members,
        `${seedKey}:genre:${group.key}`,
        membershipFit,
      ),
    });
  }

  // Then artist-family mixes, in topArtists order: a seed artist
  // plus every artist sharing a Playlist Genre label with the seed.
  for (const artist of topArtists) {
    if (mixes.length >= FOR_YOU_LIMITS.maxMixes) break;
    const artistLower = artist.trim().toLowerCase();
    if (artistLower === "") continue;
    const seedTracks = pool.filter(
      (candidate) => artistKeyOf(candidate.track) === artistLower,
    );
    if (seedTracks.length === 0) continue;
    const seedLabels = new Set<string>();
    for (const candidate of seedTracks) {
      for (const key of labelKeysOf(candidate.playlistGenres)) {
        seedLabels.add(key);
      }
    }
    const familyArtists = new Set<string>([artistLower]);
    for (const candidate of pool) {
      const shares = labelKeysOf(candidate.playlistGenres).some((key) =>
        seedLabels.has(key),
      );
      if (shares) familyArtists.add(artistKeyOf(candidate.track));
    }
    const familyPool = pool.filter((candidate) =>
      familyArtists.has(artistKeyOf(candidate.track)),
    );
    if (familyPool.length < FOR_YOU_LIMITS.minMixTracks) continue;
    const basis: ForYouMixBasis = { kind: "artistFamily", label: artist };
    consider({
      id: forYouMixId(basis),
      basis,
      tracks: assemble(
        familyPool,
        `${seedKey}:artist:${artistLower}`,
        membershipFit,
      ),
    });
  }

  // Then era mixes, biggest decade first, then label asc.
  {
    const byDecade = new Map<string, ForYouCandidate[]>();
    for (const candidate of pool) {
      const label = decadeOf(candidate.track);
      if (label == null) continue;
      const group = byDecade.get(label);
      if (group) group.push(candidate);
      else byDecade.set(label, [candidate]);
    }
    const eraGroups = [...byDecade.entries()].sort(
      (a, b) =>
        b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    for (const [label, members] of eraGroups) {
      if (mixes.length >= FOR_YOU_LIMITS.maxMixes) break;
      if (members.length < FOR_YOU_LIMITS.minMixTracks) continue;
      const basis: ForYouMixBasis = { kind: "era", label };
      consider({
        id: forYouMixId(basis),
        basis,
        tracks: assemble(members, `${seedKey}:era:${label}`, membershipFit),
      });
    }
  }

  // Then derived-energy mixes, high band before low band.
  const withEnergy = pool.filter(
    (candidate) => candidate.facts?.meanEnergy != null,
  );
  const bands: { band: "high" | "low"; members: ForYouCandidate[] }[] = [
    {
      band: "high",
      members: withEnergy.filter(
        (candidate) => (candidate.facts?.meanEnergy ?? 0) >= 0.66,
      ),
    },
    {
      band: "low",
      members: withEnergy.filter(
        (candidate) => (candidate.facts?.meanEnergy ?? 1) <= 0.4,
      ),
    },
  ];
  for (const { band, members } of bands) {
    if (mixes.length >= FOR_YOU_LIMITS.maxMixes) break;
    if (members.length < FOR_YOU_LIMITS.minMixTracks) continue;
    const basis: ForYouMixBasis = { kind: "derivedEnergy", label: band };
    consider({
      id: forYouMixId(basis),
      basis,
      tracks: assemble(members, `${seedKey}:energy:${band}`, (candidate) => {
        const energy = candidate.facts?.meanEnergy ?? 0;
        return band === "high" ? energy : 1 - energy;
      }),
    });
  }

  // Then derived-tempo mixes, slow band before driving band.
  const withBpm = pool.filter((candidate) => candidate.facts?.bpm != null);
  const tempoBands: { band: "slow" | "driving"; members: ForYouCandidate[] }[] =
    [
      {
        band: "slow",
        members: withBpm.filter(
          (candidate) =>
            (candidate.facts?.bpm ?? Number.POSITIVE_INFINITY) <= 100,
        ),
      },
      {
        band: "driving",
        members: withBpm.filter(
          (candidate) =>
            (candidate.facts?.bpm ?? Number.NEGATIVE_INFINITY) >= 122,
        ),
      },
    ];
  for (const { band, members } of tempoBands) {
    if (mixes.length >= FOR_YOU_LIMITS.maxMixes) break;
    if (members.length < FOR_YOU_LIMITS.minMixTracks) continue;
    const basis: ForYouMixBasis = { kind: "derivedTempo", label: band };
    consider({
      id: forYouMixId(basis),
      basis,
      tracks: assemble(members, `${seedKey}:tempo:${band}`, (candidate) => {
        const bpm = candidate.facts?.bpm ?? 0;
        return band === "slow"
          ? clamp01((100 - bpm) / 40)
          : clamp01((bpm - 122) / 40);
      }),
    });
  }

  return mixes;
}

// ---------------------------------------------------------------------
// Daily snapshot
// ---------------------------------------------------------------------

export interface DailyMixSnapshotEntry {
  basis: ForYouMixBasis;
  trackIds: string[];
}

export interface DailyMixSnapshot {
  dateKey: string;
  entries: DailyMixSnapshotEntry[];
}

export function applyDailySnapshot(
  generated: ForYouMix[],
  snapshot: DailyMixSnapshot | null,
  dateKey: string,
  byId: ReadonlyMap<string, Track>,
): { mixes: ForYouMix[]; snapshot: DailyMixSnapshot; regenerated: boolean } {
  if (snapshot && snapshot.dateKey === dateKey) {
    const rebuilt: ForYouMix[] = [];
    for (const entry of snapshot.entries) {
      const tracks: Track[] = [];
      for (const id of entry.trackIds) {
        const track = byId.get(id);
        if (track) tracks.push(track);
      }
      if (tracks.length < FOR_YOU_LIMITS.minMixTracks) continue;
      rebuilt.push({
        id: forYouMixId(entry.basis),
        basis: entry.basis,
        tracks,
      });
    }
    return { mixes: rebuilt, snapshot, regenerated: false };
  }
  const fresh: DailyMixSnapshot = {
    dateKey,
    entries: generated.map((mix) => ({
      basis: mix.basis,
      trackIds: mix.tracks.map((track) => track.id),
    })),
  };
  return { mixes: generated, snapshot: fresh, regenerated: true };
}

// ---------------------------------------------------------------------
// Because rows
// ---------------------------------------------------------------------

function sharedLabel(a: ForYouCandidate, b: ForYouCandidate): boolean {
  const bKeys = new Set(labelKeysOf(b.playlistGenres));
  return labelKeysOf(a.playlistGenres).some((key) => bKeys.has(key));
}

function sameArtist(a: ForYouCandidate, b: ForYouCandidate): boolean {
  return artistKeyOf(a.track) === artistKeyOf(b.track);
}

/**
 * How alike two tracks measure, from their derived facts: the mean
 * of whichever components (tempo, key, energy) both sides can
 * supply. Null unless both facts are non-null and at least one
 * component is computable.
 */
function analysisScore(a: ForYouCandidate, b: ForYouCandidate): number | null {
  if (!a.facts || !b.facts) return null;
  const components: number[] = [];
  if (a.facts.bpm != null && b.facts.bpm != null) {
    components.push(1 - Math.min(1, Math.abs(a.facts.bpm - b.facts.bpm) / 30));
  }
  const key = camelotCompatibility(a.facts.camelot, b.facts.camelot);
  if (key != null) components.push(key);
  if (a.facts.meanEnergy != null && b.facts.meanEnergy != null) {
    components.push(1 - Math.abs(a.facts.meanEnergy - b.facts.meanEnergy));
  }
  if (components.length === 0) return null;
  return components.reduce((sum, value) => sum + value, 0) / components.length;
}

function compatible(a: ForYouCandidate, b: ForYouCandidate): boolean {
  if (sharedLabel(a, b) || sameArtist(a, b)) return true;
  const score = analysisScore(a, b);
  return score != null && score >= 0.6;
}

export function buildBecauseRows(
  candidates: readonly ForYouCandidate[],
  options: { topArtists: string[] },
): BecauseRow[] {
  const rows: BecauseRow[] = [];

  // Track seeds: the listener's own played tracks, best first.
  const seeds = ranked(candidates.filter((c) => c.plays >= 1)).slice(0, 2);
  for (const seed of seeds) {
    if (rows.length >= FOR_YOU_LIMITS.maxBecauseRows) break;
    const fill = candidates
      .filter(
        (candidate) =>
          candidate.track.id !== seed.track.id && compatible(seed, candidate),
      )
      .map((candidate) => ({
        candidate,
        affinity:
          (sharedLabel(seed, candidate) ? 1 : 0) +
          (sameArtist(seed, candidate) ? 1 : 0),
        score: analysisScore(seed, candidate),
      }))
      .sort(
        (a, b) =>
          b.affinity - a.affinity ||
          (b.score ?? -1) - (a.score ?? -1) ||
          compareCandidates(a.candidate, b.candidate),
      )
      .slice(0, FOR_YOU_LIMITS.maxRowTracks)
      .map((entry) => entry.candidate);
    if (fill.length < FOR_YOU_LIMITS.minRowTracks) continue;
    rows.push({
      seed: { kind: "track", track: seed.track },
      tracks: toTracks(fill),
    });
  }

  // One artist seed: the first top artist with a real footprint in
  // the universe. The artist's own tracks belong in the row — it is
  // a "because you play X" row.
  if (rows.length < FOR_YOU_LIMITS.maxBecauseRows) {
    for (const artist of options.topArtists) {
      const artistLower = artist.trim().toLowerCase();
      if (artistLower === "") continue;
      const own = candidates.filter(
        (candidate) => artistKeyOf(candidate.track) === artistLower,
      );
      if (own.length < 2) continue;
      const ownLabels = new Set<string>();
      for (const candidate of own) {
        for (const key of labelKeysOf(candidate.playlistGenres)) {
          ownLabels.add(key);
        }
      }
      const fill = ranked(
        candidates.filter(
          (candidate) =>
            artistKeyOf(candidate.track) === artistLower ||
            labelKeysOf(candidate.playlistGenres).some((key) =>
              ownLabels.has(key),
            ),
        ),
      ).slice(0, FOR_YOU_LIMITS.maxRowTracks);
      if (fill.length >= FOR_YOU_LIMITS.minRowTracks) {
        rows.push({
          seed: { kind: "artist", artist },
          tracks: toTracks(fill),
        });
      }
      break;
    }
  }

  return rows.slice(0, FOR_YOU_LIMITS.maxBecauseRows);
}

// ---------------------------------------------------------------------
// Genre shelves
// ---------------------------------------------------------------------

export function buildGenreShelves(
  candidates: readonly ForYouCandidate[],
): GenreShelf[] {
  const shelves: GenreShelf[] = [];
  const collect = (
    kind: GenreShelf["kind"],
    labelsOf: (candidate: ForYouCandidate) => readonly string[],
  ): void => {
    for (const group of groupByLabels(candidates, labelsOf)) {
      if (shelves.length >= FOR_YOU_LIMITS.maxShelves) return;
      if (group.members.length < FOR_YOU_LIMITS.minShelfTracks) continue;
      shelves.push({
        kind,
        label: group.displayLabel,
        tracks: toTracks(
          ranked(group.members).slice(0, FOR_YOU_LIMITS.maxShelfTracks),
        ),
      });
    }
  };
  // The owner's own Playlist Genre filings first, then basic Genre.
  collect("playlistGenre", (c) => c.playlistGenres);
  collect("genre", (c) => c.genres);
  return shelves;
}

// ---------------------------------------------------------------------
// Mood rows
// ---------------------------------------------------------------------

export function buildMoodRows(
  candidates: readonly ForYouCandidate[],
): MoodRow[] {
  const withFacts = candidates.filter((candidate) => candidate.facts != null);
  const rows: MoodRow[] = [];
  const consider = (
    kind: MoodKind,
    members: ForYouCandidate[],
    order?: (a: ForYouCandidate, b: ForYouCandidate) => number,
  ): void => {
    if (members.length < FOR_YOU_LIMITS.minMoodTracks) return;
    const ordered = [...members].sort(
      order
        ? (a, b) => order(a, b) || compareCandidates(a, b)
        : compareCandidates,
    );
    rows.push({
      kind,
      tracks: toTracks(ordered.slice(0, FOR_YOU_LIMITS.maxMoodTracks)),
    });
  };

  // Fixed row order: lowEnergy, highEnergy, vocalLed, instrumental.
  // A track may appear in several rows — they are different axes.
  consider(
    "lowEnergy",
    withFacts.filter(
      (c) => c.facts?.meanEnergy != null && c.facts.meanEnergy <= 0.4,
    ),
    (a, b) => (a.facts?.meanEnergy ?? 0) - (b.facts?.meanEnergy ?? 0),
  );
  consider(
    "highEnergy",
    withFacts.filter(
      (c) => c.facts?.meanEnergy != null && c.facts.meanEnergy >= 0.66,
    ),
  );
  consider(
    "vocalLed",
    withFacts.filter(
      (c) => c.facts?.vocalShare != null && c.facts.vocalShare >= 0.45,
    ),
    (a, b) => (b.facts?.vocalShare ?? 0) - (a.facts?.vocalShare ?? 0),
  );
  consider(
    "instrumental",
    withFacts.filter(
      (c) => c.facts?.vocalShare != null && c.facts.vocalShare <= 0.12,
    ),
  );
  return rows;
}
