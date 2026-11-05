// Smart Shuffle context: the impure wiring around the pure
// ordering/admission modules — everything that touches storage,
// the catalogue, or the clock lives here so smartShuffle.ts and
// smartShuffleAdmission.ts stay pure.
//
// Three supplies:
//
//   - RECENCY: a small local ring of recently played track ids
//     (liner_smart_shuffle_recent_v1, most recent first). The
//     player engine notes every track that becomes current —
//     plain plays, skips and DJ-presented tracks alike, since
//     heard is heard. Session plays ride the same ring; the ring
//     persisting across restarts is what lets a track heard an
//     hour ago still rest after a relaunch.
//
//   - FACTS: per-track musical facts read from analyses that
//     ALREADY exist in the new engine's store — the same read the
//     For You feed performs: the store's reads enumerated through
//     liverave/storage (which applies its own fingerprint and
//     version gates), attributed to tracks through the engine's
//     trackId → audioHash bridge, then version-checked and
//     structure-checked here; a failed read is a null fact, never
//     a throw. This module NEVER analyses anything: ordering a
//     queue is not a reason to decode audio. Facts are cached per
//     session; misses are re-checked after a minute, so a track
//     the DJ prepares later can still light up.
//
//   - GUESTS: the recommendation rails, in the For You assembly's
//     shape — radio seeded by the listener's strongest track,
//     catalogue tracks by their top artists, catalogue search by
//     the playlist's own Playlist Genre labels — deduped against
//     the playlist, the current track and the recent ring, then
//     passed through smartShuffleAdmission's gate. Rails fail
//     silently and separately: no rail, no guests, never an error
//     in the playback path.

import { api, toClientTrack } from "@/shared/api";
import type { Track } from "@/shared/types";
import { isLocalTrackId } from "@/shared/media/local";
import { labelsForTrack } from "@/features/genres/trackGenres";
import { ANALYSIS_VERSION } from "@/features/mixer/liverave/analyse";
import type { TrackRead } from "@/features/mixer/liverave/facts";
import { listReads, listTrackHashes } from "@/features/mixer/liverave/storage";
import { factsFromRead, type SmartTrackIntel } from "./smartShuffleFacts";
import {
  decayProfile,
  topArtists,
  type TasteProfile,
} from "@/features/mixer/engine/tasteProfile";
import { getTasteProfile } from "@/features/mixer/engine/tasteTracker";
import {
  admitGuests,
  hasInsertionTaste,
  type GuestCandidate,
} from "./smartShuffleAdmission";
import type { SmartCandidateInput, SmartTrackFacts } from "./smartShuffle";

// ---------------------------------------------------------------------
// Recency ring
// ---------------------------------------------------------------------

const RECENT_KEY = "liner_smart_shuffle_recent_v1";
const RECENT_MAX = 80;

let recentCache: string[] | null = null;

function loadRecent(): string[] {
  if (recentCache) return recentCache;
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    recentCache = Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && !!id)
      : [];
  } catch {
    recentCache = [];
  }
  return recentCache;
}

/** Notes that a track became the playing track. Cheap; never throws. */
export function noteSmartShufflePlay(trackId: string): void {
  if (!trackId) return;
  const recent = loadRecent();
  if (recent[0] === trackId) return;
  recentCache = [trackId, ...recent].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentCache));
  } catch {
    // Storage refused: the ring still serves this session.
  }
}

/** Recently played track ids, most recent first. */
export function getSmartRecentPlays(): readonly string[] {
  return loadRecent();
}

// ---------------------------------------------------------------------
// Facts from stored analyses
// ---------------------------------------------------------------------

const MISS_RECHECK_MS = 60_000;

const intelCache = new Map<string, SmartTrackIntel>();
const missAtById = new Map<string, number>();

/** The ordering-shaped facts for a track, when its analysis is known. */
export function getSmartFacts(trackId: string): SmartTrackFacts | null {
  const intel = intelCache.get(trackId);
  if (!intel) return null;
  return {
    bpm: intel.bpm > 0 ? intel.bpm : null,
    energy: intel.energy,
  };
}

/** The intel-shaped facts for a track, when its analysis is known. */
export function getSmartIntel(trackId: string): SmartTrackIntel | null {
  return intelCache.get(trackId) ?? null;
}

/**
 * Reads stored analyses for the given tracks into the facts cache.
 * Only reads at the current analysis version with intact
 * structure are believed — the analysis cache's trust rule, read
 * the way the For You feed reads the new engine's store: the
 * reads are enumerated once (listReads applies the store's own
 * fingerprint and version gates before serving anything) and
 * attributed to tracks through the engine's bridge (the
 * trackId → audioHash pairs its source path records when it
 * resolves a track's audio; a track key that IS a hash still
 * attributes directly). A track with no bridge entry has no
 * facts — its audio was never resolved by the new engine on
 * this device — exactly the no-facts state this feature has
 * always tolerated. When a hash holds reads at both depths the
 * deep read wins: it is the fuller analysis, and the old cache
 * held one record per track, written by the deep preparation.
 * Each enumeration fails independently and silently: a failed
 * bridge loses only attributions, a failed enumeration is a
 * miss for everyone — never a throw. The fingerprint check
 * belongs to preparation, which re-verifies before any JOIN —
 * ordering and admission spend the facts as evidence, never as
 * a performance guarantee.
 */
export async function prefetchSmartFacts(
  tracks: readonly Track[],
): Promise<void> {
  const now = Date.now();
  const wanted = tracks.filter((track) => {
    if (intelCache.has(track.id)) return false;
    const missedAt = missAtById.get(track.id);
    return missedAt === undefined || now - missedAt > MISS_RECHECK_MS;
  });
  if (wanted.length === 0) return;

  let readsByHash = new Map<string, TrackRead>();
  try {
    const reads = await listReads();
    for (const read of reads) {
      if (!read?.audioHash) continue;
      const existing = readsByHash.get(read.audioHash);
      if (!existing || (read.depth === "deep" && existing.depth !== "deep")) {
        readsByHash.set(read.audioHash, read);
      }
    }
  } catch {
    readsByHash = new Map();
  }
  let hashByTrack: ReadonlyMap<string, string> = new Map();
  try {
    hashByTrack = await listTrackHashes();
  } catch {
    // Bridge unreadable: attributions are lost, reads are not.
  }

  for (const track of wanted) {
    const bridgedHash = hashByTrack.get(track.id);
    const read =
      (bridgedHash ? readsByHash.get(bridgedHash) : undefined) ??
      readsByHash.get(track.id);
    if (
      !read ||
      read.analysisVersion !== ANALYSIS_VERSION ||
      !read.sections ||
      !read.grid
    ) {
      missAtById.set(track.id, Date.now());
      continue;
    }
    intelCache.set(
      track.id,
      factsFromRead(track.id, read, labelsForTrack(track.id)),
    );
  }
}

// ---------------------------------------------------------------------
// Candidate inputs
// ---------------------------------------------------------------------

/** The primary artist's display name (forYouFeed.primaryArtistOf's rule). */
function primaryArtistName(track: Track): string {
  const listed = track.artistList?.[0]?.name;
  if (listed != null && listed.trim() !== "") return listed;
  const first = (track.artists ?? "").split(",")[0]?.trim() ?? "";
  return first !== "" ? first : (track.artists ?? "").trim();
}

/** Builds the ordering module's input for one track. */
export function smartCandidateInputFor(
  track: Track,
  guest = false,
): SmartCandidateInput {
  const labels = labelsForTrack(track.id);
  return {
    trackId: track.id,
    artist: track.artists,
    artistKey: primaryArtistName(track).toLowerCase(),
    ...(labels.playlistGenres.length > 0
      ? { playlistGenres: labels.playlistGenres }
      : {}),
    ...(labels.genres.length > 0 ? { genres: labels.genres } : {}),
    ...(guest ? { guest: true } : {}),
  };
}

// ---------------------------------------------------------------------
// Recommendation rails + guest assembly
// ---------------------------------------------------------------------

const RAIL_POOL_CAP = 24;

async function fetchRails(input: {
  profile: TasteProfile;
  nowMs: number;
  currentTrack: Track | null;
  playlistTracks: readonly Track[];
  excludeIds: ReadonlySet<string>;
}): Promise<Track[]> {
  const aged = decayProfile(input.profile, input.nowMs);
  const byId = new Map<string, Track>();
  const offer = (track: Track | null | undefined) => {
    if (!track || !track.id) return;
    if (input.excludeIds.has(track.id)) return;
    if (isLocalTrackId(track.id)) return;
    if (!byId.has(track.id)) byId.set(track.id, track);
  };

  // Rail 1 — radio seeded by the listener's strongest track (the
  // profile's own most-loved, else the playing track).
  const topTrackId =
    Object.entries(aged.tracks)
      .filter(([, weight]) => weight > 0)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const radioSeed =
    topTrackId && !isLocalTrackId(topTrackId)
      ? topTrackId
      : (input.currentTrack?.id ?? null);
  if (radioSeed && !isLocalTrackId(radioSeed)) {
    try {
      const response = await api.getRadio(radioSeed, {
        k: 12,
        history: [...input.excludeIds],
      });
      for (const item of response.items) offer(toClientTrack(item));
    } catch {
      // A failed rail is an empty rail.
    }
  }

  // Rail 2 — catalogue tracks by the listener's top artists.
  for (const { artist } of topArtists(aged, input.nowMs, 2)) {
    const wanted = artist.split(",")[0]?.trim().toLowerCase() ?? "";
    if (!wanted) continue;
    try {
      const response = await api.search(artist, "track");
      for (const item of response.items) {
        if (item.type !== "track") continue;
        const track = toClientTrack(item);
        if (primaryArtistName(track).toLowerCase() === wanted) {
          offer(track);
        }
      }
    } catch {
      // A failed rail is an empty rail.
    }
  }

  // Rail 3 — catalogue search by the playlist's own Playlist
  // Genre labels (the owner's categories ask for their kin).
  const labelSet = new Set<string>();
  for (const track of input.playlistTracks) {
    for (const label of labelsForTrack(track.id).playlistGenres) {
      labelSet.add(label);
    }
  }
  for (const label of [...labelSet].slice(0, 2)) {
    try {
      const response = await api.search(label, "track");
      for (const item of response.items) {
        if (item.type === "track") offer(toClientTrack(item));
      }
    } catch {
      // A failed rail is an empty rail.
    }
  }

  return [...byId.values()].slice(0, RAIL_POOL_CAP);
}

export interface SmartGuestBuildInput {
  /** The playing track (the fit test's anchor); may be null. */
  currentTrack: Track | null;
  /** The playlist body, current track included. */
  playlistTracks: readonly Track[];
  /** Ratio cap for the upcoming queue (smartShuffle.maxGuestsFor). */
  maxGuests: number;
  nowMs: number;
}

/**
 * Assembles the admitted guests for the current queue: rails →
 * dedupe → stored-analysis facts → the admission gate. Returns
 * the admitted tracks in admission order (best fit first); the
 * caller caps and weaves them into the order. Returns [] whenever
 * anything is missing — thin taste, no facts, failed rails — by
 * design: guests are an enhancement, never a dependency.
 */
export async function buildSmartGuests(
  input: SmartGuestBuildInput,
): Promise<Track[]> {
  if (input.maxGuests <= 0) return [];
  const profile = getTasteProfile();
  if (!hasInsertionTaste(profile, input.nowMs)) return [];

  const playlistIds = new Set(input.playlistTracks.map((t) => t.id));
  const recentIds = new Set(getSmartRecentPlays().slice(0, 10));
  const excludeIds = new Set([...playlistIds, ...recentIds]);
  if (input.currentTrack) excludeIds.add(input.currentTrack.id);

  await prefetchSmartFacts(
    input.currentTrack
      ? [input.currentTrack, ...input.playlistTracks]
      : input.playlistTracks,
  );

  const railTracks = await fetchRails({
    profile,
    nowMs: input.nowMs,
    currentTrack: input.currentTrack,
    playlistTracks: input.playlistTracks,
    excludeIds,
  });
  if (railTracks.length === 0) return [];

  await prefetchSmartFacts(railTracks);

  const pool: GuestCandidate[] = [];
  const trackById = new Map<string, Track>();
  for (const track of railTracks) {
    const facts = getSmartIntel(track.id);
    if (!facts) continue; // no facts → cannot be fit-tested → refused
    const labels = labelsForTrack(track.id);
    pool.push({
      trackId: track.id,
      artist: track.artists,
      ...(labels.playlistGenres.length > 0
        ? { playlistGenres: labels.playlistGenres }
        : {}),
      ...(labels.genres.length > 0 ? { genres: labels.genres } : {}),
      facts,
    });
    trackById.set(track.id, track);
  }
  if (pool.length === 0) return [];

  const currentIntel = input.currentTrack
    ? getSmartIntel(input.currentTrack.id)
    : null;
  const playlistEnergies = input.playlistTracks
    .map((track) => getSmartIntel(track.id)?.energy)
    .filter((energy): energy is number => typeof energy === "number");
  const arcTargetEnergy =
    currentIntel?.energy ??
    (playlistEnergies.length > 0
      ? playlistEnergies.reduce((sum, e) => sum + e, 0) /
        playlistEnergies.length
      : 0.5);

  const admitted = admitGuests({
    current: currentIntel,
    arcTargetEnergy,
    pool,
    profile,
    nowMs: input.nowMs,
    maxGuests: input.maxGuests,
  });

  return admitted
    .map((candidate) => trackById.get(candidate.trackId))
    .filter((track): track is Track => track !== undefined);
}
