import { useEffect, useMemo, useRef, useState } from "react";
import { api, toClientTrack } from "@/shared/api";
import type { Track } from "@/shared/types";
import { loadWithRetry, useSessionOwner } from "./sessionAwareLoad";
import { freshFor, useCachedResource } from "@/shared/cache/useCachedResource";
import { useLikedTracks, usePlaylistsList } from "@/features/library/hooks";
import { labelsForTrack } from "@/features/genres/trackGenres";
import { linerDb } from "@/shared/storage";
import { getTasteProfile } from "@/features/mixer/engine/tasteTracker";
import {
  decayProfile,
  forYouScore,
  topArtists,
  type TasteProfile,
} from "@/features/mixer/engine/tasteProfile";
import {
  ANALYSIS_VERSION,
  type TrackAnalysis,
} from "@/features/mixer/engine/analyseTrack";
import {
  applyDailySnapshot,
  buildBecauseRows,
  buildGenreShelves,
  buildMixes,
  buildMoodRows,
  primaryArtistOf,
  type BecauseRow,
  type DailyMixSnapshot,
  type ForYouCandidate,
  type ForYouMix,
  type ForYouTrackFacts,
  type GenreShelf,
  type MoodRow,
} from "../lib/forYouFeed";

// The For You feed's data hook: gathers the listener's own evidence
// (server history, liked tracks, the taste profile, Playlist Genre
// filings and any stored track analyses) and hands it to the pure
// builders in lib/forYouFeed. Like useHeavyRotation, a surface
// exists only when the listener's own evidence supports it — there
// is no global or borrowed content anywhere in this hook, and a
// guest (no session owner) gets an empty, non-failed feed.

export interface ForYouFeedData {
  mixes: ForYouMix[];
  becauseRows: BecauseRow[];
  genreShelves: GenreShelf[];
  moodRows: MoodRow[];
  isLoading: boolean;
  hasAnyData: boolean;
  loadFailed: boolean;
}

/** One distinct track from the history window. */
export interface HeardEntry {
  track: Track;
  /** How many times it appears in the history window. */
  plays: number;
  /** Index of its most recent play (0 = most recent). */
  lastPlayIndex: number;
}

/** One track in the feed's universe: heard, liked, or both. */
export interface UniverseEntry {
  track: Track;
  plays: number;
  lastPlayIndex: number;
  liked: boolean;
}

const HISTORY_WINDOW = 100;
const FOR_YOU_POLICY = { isFresh: freshFor(60_000), revalidateOnFocus: true };
const EMPTY_HEARD: HeardEntry[] = [];

interface ForYouModel {
  mixes: ForYouMix[];
  becauseRows: BecauseRow[];
  genreShelves: GenreShelf[];
  moodRows: MoodRow[];
}

const EMPTY_MODEL: ForYouModel = {
  mixes: [],
  becauseRows: [],
  genreShelves: [],
  moodRows: [],
};

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------

async function loadForYouHistory(): Promise<HeardEntry[]> {
  const res = await loadWithRetry(
    () => api.getHistory(undefined, HISTORY_WINDOW),
    () => true,
  );
  const byId = new Map<string, HeardEntry>();
  // History arrives most-recent-first: the first sighting of a track
  // is its most recent play, so it sets lastPlayIndex; later
  // sightings only add to the play count (mirrors loadHeavyRotation).
  (res.items ?? []).forEach((entry, index) => {
    if (!entry.track?.id) return;
    const track = toClientTrack(entry.track);
    const existing = byId.get(track.id);
    if (existing) {
      existing.plays += 1;
    } else {
      byId.set(track.id, { track, plays: 1, lastPlayIndex: index });
    }
  });
  return [...byId.values()];
}

// ---------------------------------------------------------------------
// Universe + candidates (exported for tests)
// ---------------------------------------------------------------------

/**
 * Merges the heard map with the liked tracks. A liked track absent
 * from history joins with plays 0 and lastPlayIndex Infinity (never
 * played); a track present in both keeps the history Track object
 * and its play count, and is flagged liked.
 */
export function mergeUniverse(
  heard: readonly HeardEntry[],
  likedTracks: readonly Track[],
): UniverseEntry[] {
  const byId = new Map<string, UniverseEntry>();
  for (const entry of heard) {
    byId.set(entry.track.id, {
      track: entry.track,
      plays: entry.plays,
      lastPlayIndex: entry.lastPlayIndex,
      liked: false,
    });
  }
  for (const track of likedTracks) {
    if (!track?.id) continue;
    const existing = byId.get(track.id);
    if (existing) {
      existing.liked = true;
    } else {
      byId.set(track.id, {
        track,
        plays: 0,
        lastPlayIndex: Number.POSITIVE_INFINITY,
        liked: true,
      });
    }
  }
  return [...byId.values()];
}

/** Builds the pure builders' candidates from the merged universe. */
export function buildForYouCandidates(
  universe: readonly UniverseEntry[],
  agedProfile: TasteProfile,
  factsById: ReadonlyMap<string, ForYouTrackFacts | null>,
): ForYouCandidate[] {
  return universe.map((entry) => {
    const labels = labelsForTrack(entry.track.id);
    return {
      track: entry.track,
      plays: entry.plays,
      lastPlayIndex: entry.lastPlayIndex,
      liked: entry.liked,
      tasteScore: forYouScore(
        {
          trackId: entry.track.id,
          artist: primaryArtistOf(entry.track),
          playlistGenres: labels.playlistGenres,
          genres: labels.genres,
        },
        agedProfile,
      ),
      playlistGenres: labels.playlistGenres,
      genres: labels.genres,
      facts: factsById.get(entry.track.id) ?? null,
    };
  });
}

/** Runs the four pure builders over a candidate list. */
export function assembleForYouFeed(
  candidates: readonly ForYouCandidate[],
  seedKey: string,
  topArtistNames: string[],
): ForYouModel {
  return {
    mixes: buildMixes(candidates, {
      seedKey,
      topArtists: topArtistNames,
    }),
    becauseRows: buildBecauseRows(candidates, {
      topArtists: topArtistNames,
    }),
    genreShelves: buildGenreShelves(candidates),
    moodRows: buildMoodRows(candidates),
  };
}

// ---------------------------------------------------------------------
// Stored-analysis facts
// ---------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Extracts the feed's coarse facts from a stored analysis record,
 * or returns null when the record cannot be trusted for even that.
 *
 * HONESTY NOTE — why this does NOT go through getCachedAnalysis:
 * the engine's getCachedAnalysis additionally demands the audio
 * fingerprint, which only decoded audio can provide; the feed
 * cannot decode audio, so it reads the store record directly here
 * instead. That is a deliberately weaker trust rule — the outer and
 * inner analysis versions must both match ANALYSIS_VERSION and the
 * analysis must still carry its sections and its beat grid (the
 * same structural checks analysisCache makes) — and the facts taken
 * under it are used ONLY for coarse, labelled-derived clustering
 * (mood bands, compatibility hints), never for playback or DJ
 * decisions, where only the fingerprint-checked cache may speak.
 */
export function factsFromAnalysisRecord(
  record: { analysisVersion: number; analysis: unknown } | null | undefined,
): ForYouTrackFacts | null {
  try {
    if (!record) return null;
    if (record.analysisVersion !== ANALYSIS_VERSION) return null;
    const analysis = record.analysis as TrackAnalysis | null | undefined;
    if (!analysis) return null;
    if (analysis.analysisVersion !== ANALYSIS_VERSION) return null;
    if (!analysis.sections || !analysis.beatMap?.grid) return null;

    const bpm =
      typeof analysis.beatMap.bpm === "number" && analysis.beatMap.bpm > 0
        ? analysis.beatMap.bpm
        : null;

    let meanEnergy: number | null = null;
    if (
      Array.isArray(analysis.energyCurve) &&
      analysis.energyCurve.length > 0
    ) {
      let sum = 0;
      let count = 0;
      for (const entry of analysis.energyCurve) {
        if (
          typeof entry?.energy === "number" &&
          Number.isFinite(entry.energy)
        ) {
          sum += entry.energy;
          count += 1;
        }
      }
      meanEnergy = count > 0 ? sum / count : null;
    }

    let vocalShare: number | null = null;
    if (
      Array.isArray(analysis.vocalRanges) &&
      typeof analysis.beatMap.durationSec === "number" &&
      analysis.beatMap.durationSec > 0
    ) {
      let vocalSec = 0;
      for (const range of analysis.vocalRanges) {
        if (
          typeof range?.startSec === "number" &&
          typeof range?.endSec === "number" &&
          Number.isFinite(range.startSec) &&
          Number.isFinite(range.endSec)
        ) {
          vocalSec += Math.max(0, range.endSec - range.startSec);
        }
      }
      vocalShare = clamp01(vocalSec / analysis.beatMap.durationSec);
    }

    const camelot = analysis.key?.camelot;
    return {
      bpm,
      meanEnergy,
      vocalShare,
      camelot: typeof camelot === "string" ? camelot : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Candidate assembly (shared by the feed and the Home daily-mix rail)
// ---------------------------------------------------------------------

export interface ForYouCandidatesData {
  candidates: ForYouCandidate[];
  byId: ReadonlyMap<string, Track>;
  topArtists: string[];
  seedKey: string;
  dateKey: string;
  isLoading: boolean;
  settled: boolean;
  likedError: unknown;
  playlistsError: unknown;
}

const EMPTY_CANDIDATES: ForYouCandidate[] = [];

/**
 * Gathers the listener's own evidence (server history, liked
 * tracks, the taste profile, Playlist Genre filings and any stored
 * track analyses) and assembles the pure builders' candidates.
 *
 * Candidates are assembled only once every source has settled AND
 * the analysis pass for the current universe has finished (or the
 * universe is empty) — until then `candidates` is empty, `settled`
 * is false and `isLoading` reports the outstanding work. That is
 * exactly the gating the feed has always applied before building
 * its model, now shared so the Home rail and the feed page run on
 * one engine with one candidate set.
 */
export function useForYouCandidates(): ForYouCandidatesData {
  const owner = useSessionOwner();
  const { data: historyData, isLoading: historyLoading } = useCachedResource(
    `home:for-you-history:${owner}`,
    // Guests have no listening history on the server — skip the call
    // entirely and resolve an empty heard map.
    () => (owner ? loadForYouHistory() : Promise.resolve(EMPTY_HEARD)),
    FOR_YOU_POLICY,
  );
  const {
    data: likedData,
    isLoading: likedLoading,
    error: likedError,
  } = useLikedTracks();
  const { error: playlistsError, isLoading: playlistsLoading } =
    usePlaylistsList();

  const heard = historyData ?? EMPTY_HEARD;
  const likedTracks = likedData?.tracks ?? [];

  const universe = useMemo(
    () => mergeUniverse(heard, likedTracks),
    [heard, likedTracks],
  );
  const universeIds = useMemo(
    () => universe.map((entry) => entry.track.id),
    [universe],
  );
  const sortedUniverseIds = useMemo(
    () => [...universeIds].sort(),
    [universeIds],
  );
  const universeKey = sortedUniverseIds.join(",");

  const byId = useMemo<ReadonlyMap<string, Track>>(() => {
    const map = new Map<string, Track>();
    for (const entry of universe) map.set(entry.track.id, entry.track);
    return map;
  }, [universe]);

  // Analysis pass: an effect keyed by the sorted universe id list.
  // Each stored record is read directly (see the honesty note on
  // factsFromAnalysisRecord) and reduced to coarse facts; a failed
  // read is a null fact, never a throw.
  const [analysisState, setAnalysisState] = useState<{
    key: string;
    facts: ReadonlyMap<string, ForYouTrackFacts | null>;
  } | null>(null);

  useEffect(() => {
    if (sortedUniverseIds.length === 0) return;
    let alive = true;
    const key = universeKey;
    void (async () => {
      const facts = new Map<string, ForYouTrackFacts | null>();
      for (const id of sortedUniverseIds) {
        if (!alive) return;
        let factsForTrack: ForYouTrackFacts | null = null;
        try {
          const record = await linerDb.getAnalysis(id);
          factsForTrack = factsFromAnalysisRecord(record);
        } catch {
          factsForTrack = null;
        }
        facts.set(id, factsForTrack);
      }
      if (!alive) return;
      setAnalysisState({ key, facts });
    })();
    return () => {
      alive = false;
    };
  }, [universeKey, sortedUniverseIds]);

  const analysisPending =
    universe.length > 0 && analysisState?.key !== universeKey;
  const isLoading =
    historyLoading || likedLoading || playlistsLoading || analysisPending;
  const settled =
    !historyLoading && !likedLoading && !playlistsLoading && !analysisPending;

  const now = Date.now();
  const dateKey = new Date(now).toDateString();
  const agedProfile = decayProfile(getTasteProfile(), now);
  const seedKey = `${dateKey}|${agedProfile.updatedAtMs}|${universe.length}`;
  const topArtistNames = topArtists(agedProfile, now, 10).map(
    (entry) => entry.artist,
  );

  let candidates: ForYouCandidate[] = EMPTY_CANDIDATES;
  if (settled && universe.length > 0) {
    const factsById =
      analysisState?.key === universeKey
        ? analysisState.facts
        : new Map<string, ForYouTrackFacts | null>();
    candidates = buildForYouCandidates(universe, agedProfile, factsById);
  }

  return {
    candidates,
    byId,
    topArtists: topArtistNames,
    seedKey,
    dateKey,
    isLoading,
    settled,
    likedError,
    playlistsError,
  };
}

// ---------------------------------------------------------------------
// Daily mix snapshot
// ---------------------------------------------------------------------

const DAILY_MIX_SNAPSHOT_KEY = "liner_foryou_mixes_v1";

function readStoredDailySnapshot(): DailyMixSnapshot | null {
  try {
    const raw = localStorage.getItem(DAILY_MIX_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { dateKey?: unknown }).dateKey !== "string" ||
      !Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return null;
    }
    return parsed as DailyMixSnapshot;
  } catch {
    return null;
  }
}

function dailyMixSignature(dateKey: string, mixes: ForYouMix[]): string {
  return [
    dateKey,
    ...mixes.map(
      (mix) => `${mix.id}:${mix.tracks.map((track) => track.id).join(",")}`,
    ),
  ].join("|");
}

/**
 * Freezes the day's mixes to the first generation of the day.
 *
 * One engine, one snapshot: the Home rail and the feed page share
 * the localStorage key below, so the first surface to generate on
 * a new day writes the snapshot and every other surface that day
 * reads its mixes back from it — the rail and the feed can never
 * show different "daily" mixes.
 *
 * Stabilisation: callers compute `generated` at render time, so
 * its identity churns on every render. The applied result is
 * memoised in a ref keyed by a signature (the dateKey plus each
 * generated mix's id and track ids); while the signature is
 * unchanged the last applied mixes are returned untouched. When a
 * fresh snapshot is regenerated it is persisted from an effect,
 * and the ref entry is claimed (regenerated flipped to false) as
 * it is written, so the next render takes the stable snapshot-hit
 * path and the write happens at most once per signature — no
 * render/effect loop.
 */
export function useDailyMixSnapshot(
  generated: ForYouMix[],
  byId: ReadonlyMap<string, Track>,
  dateKey: string,
  ready: boolean,
): ForYouMix[] {
  const [stored, setStored] = useState<DailyMixSnapshot | null>(
    readStoredDailySnapshot,
  );
  const appliedRef = useRef<{
    signature: string;
    mixes: ForYouMix[];
    snapshot: DailyMixSnapshot;
    regenerated: boolean;
  } | null>(null);

  const signature = dailyMixSignature(dateKey, generated);

  let applied: typeof appliedRef.current = null;
  if (ready) {
    if (appliedRef.current && appliedRef.current.signature === signature) {
      applied = appliedRef.current;
    } else {
      const result = applyDailySnapshot(generated, stored, dateKey, byId);
      applied = {
        signature,
        mixes: result.mixes,
        snapshot: result.snapshot,
        regenerated: result.regenerated,
      };
      appliedRef.current = applied;
    }
  }

  const pendingSnapshot = applied?.snapshot ?? null;
  const pendingRegenerated = applied?.regenerated ?? false;

  useEffect(() => {
    if (!pendingRegenerated || !pendingSnapshot) return;
    // Claim this regeneration before writing: flipping the ref
    // entry to the stable path means a re-run of this effect (or
    // the re-render setStored triggers) cannot write twice.
    if (appliedRef.current && appliedRef.current.snapshot === pendingSnapshot) {
      appliedRef.current = { ...appliedRef.current, regenerated: false };
    }
    try {
      localStorage.setItem(
        DAILY_MIX_SNAPSHOT_KEY,
        JSON.stringify(pendingSnapshot),
      );
    } catch {
      // Storage unavailable (quota, private mode): the in-memory
      // snapshot below still freezes the mixes for this mount.
    }
    setStored(pendingSnapshot);
  }, [pendingRegenerated, pendingSnapshot]);

  return ready && applied ? applied.mixes : generated;
}

// ---------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------

export function useForYouFeed(): ForYouFeedData {
  const {
    candidates,
    byId,
    topArtists: topArtistNames,
    seedKey,
    dateKey,
    isLoading,
    settled,
    likedError,
    playlistsError,
  } = useForYouCandidates();

  // The model is built only once the candidate assembly has
  // settled (candidates are empty until then, mirroring the
  // original gating exactly).
  let model: ForYouModel = EMPTY_MODEL;
  if (settled && candidates.length > 0) {
    model = assembleForYouFeed(candidates, seedKey, topArtistNames);
  }

  // The day's mixes are frozen through the shared daily snapshot;
  // hasAnyData is judged on these final mixes, not the freshly
  // generated ones.
  const mixes = useDailyMixSnapshot(model.mixes, byId, dateKey, settled);

  const hasAnyData =
    mixes.length > 0 ||
    model.becauseRows.length > 0 ||
    model.genreShelves.length > 0 ||
    model.moodRows.length > 0;
  // Home's rule: empty is a failure only when a personal source
  // actually errored.
  const loadFailed =
    !isLoading && !hasAnyData && Boolean(likedError || playlistsError);

  return {
    mixes,
    becauseRows: model.becauseRows,
    genreShelves: model.genreShelves,
    moodRows: model.moodRows,
    isLoading,
    hasAnyData,
    loadFailed,
  };
}
