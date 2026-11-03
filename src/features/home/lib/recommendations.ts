import { api, toClientTrack } from "@/shared/api";
import type { Track } from "@/shared/types";
import {
  topArtists,
  type TasteProfile,
} from "@/features/mixer/engine/tasteProfile";
import { primaryArtistOf } from "./forYouFeed";

// Server recommendations for the For You feed (user ruling,
// 2026-11-03): alongside the local, library-only feed, the page
// gains catalogue discovery in Spotify's shape — rows of tracks the
// listener has NOT heard, chosen from the catalogue by their own
// taste. This module is the whole layer: seed selection from the
// taste profile, the catalogue calls behind a small client
// interface, and the new-to-the-user filtering.
//
// What the client's API surface actually offers (audited
// 2026-11-03, see investigation/for-you-server-recommendations.md):
//
// - api.getRadio(seedTrackId, { history, k }) — a true
//   seed-to-similar mechanism (the catalogue's radio for a track:
//   YouTube Music's RDAMVM/watch-next under the hood, SoundCloud
//   radio for SoundCloud ids). The api layer already drops the
//   supplied history ids from the result.
// - api.getArtist(artistId) — the artist's catalogue tracks; there
//   is NO related-artists field anywhere in ArtistDetails, so no
//   related-artist traversal exists to build on.
// - api.search(label, "track") — catalogue search, used with the
//   listener's own Playlist Genre labels as the query text.
// - api.getDailyMixes() (/v1/me/recommendations/daily-mixes) — the
//   server's own daily mixes; deliberately NOT consumed here: mixes
//   belong to the one local mix engine (Step 8), and home-surface
//   tests pin that no home hook calls it.
//
// Honesty rules (Note 18's law, applied to discovery):
// - Every row carries the basis that actually produced it — the
//   seed track played, the artist played, the Playlist Genre
//   filed — and a row whose basis cannot be stated truthfully is
//   never built.
// - "New" means new to THIS listener: anything in their server
//   history, their liked tracks, or the taste profile's own track
//   evidence is excluded wherever that is checkable.
// - Thin taste builds nothing: below the signal floor there are no
//   seeds and no rows — never global charts dressed as taste
//   (the explore/popular endpoints are not touched at all).

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

/** Why a recommendation row exists — the truthful label source. */
export type RecommendationBasis =
  | { kind: "similarToTrack"; seed: Track }
  | { kind: "moreFromArtist"; artistId: string; artistName: string }
  | { kind: "playlistGenre"; label: string };

export interface RecommendationRow {
  id: string;
  basis: RecommendationBasis;
  /** New-to-the-listener catalogue tracks, in source order. */
  tracks: Track[];
}

export interface RecommendationSeeds {
  /** Tracks the listener's taste weights most — radio seeds. */
  radioSeeds: Track[];
  /** Top artists whose catalogue id could be resolved locally. */
  artistSeeds: { artistId: string; artistName: string }[];
  /** The listener's own Playlist Genre labels, taste-ranked. */
  genreSeeds: string[];
}

export const EMPTY_SEEDS: RecommendationSeeds = {
  radioSeeds: [],
  artistSeeds: [],
  genreSeeds: [],
};

/**
 * The catalogue in client-Track space. The real implementation
 * wraps the shared api; tests inject a fake. Every method may
 * reject — the loader treats a rejection as "that row is absent".
 */
export interface RecommendationClient {
  getRadioTracks(
    seedTrackId: string,
    historyIds: readonly string[],
    k: number,
  ): Promise<Track[]>;
  getArtistTracks(artistId: string): Promise<Track[]>;
  searchTracks(query: string): Promise<Track[]>;
}

export const apiRecommendationClient: RecommendationClient = {
  async getRadioTracks(seedTrackId, historyIds, k) {
    const res = await api.getRadio(seedTrackId, {
      history: [...historyIds],
      k,
    });
    return (res.items ?? []).map((item) => toClientTrack(item));
  },
  async getArtistTracks(artistId) {
    const details = await api.getArtist(artistId);
    return (details.tracks ?? []).map((item) => toClientTrack(item));
  },
  async searchTracks(query) {
    const res = await api.search(query, "track");
    return (res.items ?? [])
      .filter((item) => item.type === "track")
      .map((item) => toClientTrack(item));
  },
};

// ---------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------

export const RECOMMENDATION_LIMITS = {
  /** How many seed tracks get a radio row at most. */
  radioSeeds: 3,
  /** How many top artists get a "more from" row at most. */
  artistSeeds: 2,
  /** How many Playlist Genre labels get a discovery row at most. */
  genreSeeds: 2,
  /** Candidates requested per radio seed. */
  radioSize: 25,
  /** A row renders only with at least this many genuinely new tracks. */
  minRowTracks: 4,
  /** Tracks kept per row. */
  rowSize: 20,
  /**
   * The taste floor: at least this many metadata-known tracks with
   * positive taste weight, or this many positively weighted
   * artists, before any seed is chosen. Below it the listener's
   * taste is too thin to aim the catalogue with.
   */
  minTasteTracks: 3,
  minTasteArtists: 2,
} as const;

// ---------------------------------------------------------------------
// Seed selection (pure)
// ---------------------------------------------------------------------

function poolById(heard: readonly Track[], liked: readonly Track[]): Track[] {
  const byId = new Map<string, Track>();
  for (const track of heard) {
    if (track?.id && !byId.has(track.id)) byId.set(track.id, track);
  }
  for (const track of liked) {
    if (track?.id && !byId.has(track.id)) byId.set(track.id, track);
  }
  return [...byId.values()];
}

function artistIdOf(track: Track): string {
  if (track.artistId) return track.artistId;
  return track.artistList?.find((artist) => artist.id)?.id ?? "";
}

/**
 * Chooses the seeds the catalogue will be aimed with, from the
 * (already decayed) taste profile. The profile carries weights but
 * no metadata, so seeds resolve against the listener's own heard /
 * liked tracks — the same division of labour as heavy rotation.
 * Below the taste floor every seed list is empty.
 */
export function selectRecommendationSeeds(input: {
  profile: TasteProfile;
  heard: readonly Track[];
  liked: readonly Track[];
  /** Every Playlist Genre label currently in use in the library. */
  genreLabels: readonly string[];
  nowMs: number;
}): RecommendationSeeds {
  const { profile, nowMs } = input;
  const pool = poolById(input.heard, input.liked);

  const weightedPool = pool
    .map((track, index) => ({
      track,
      index,
      weight: profile.tracks[track.id] ?? 0,
    }))
    .filter((entry) => entry.weight > 0);
  const topArtistEntries = topArtists(profile, nowMs, 8).filter(
    (entry) => entry.weight > 0,
  );

  const enoughTaste =
    weightedPool.length >= RECOMMENDATION_LIMITS.minTasteTracks ||
    topArtistEntries.length >= RECOMMENDATION_LIMITS.minTasteArtists;
  if (!enoughTaste) return EMPTY_SEEDS;

  const radioSeeds = [...weightedPool]
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .slice(0, RECOMMENDATION_LIMITS.radioSeeds)
    .map((entry) => entry.track);

  const artistSeeds: { artistId: string; artistName: string }[] = [];
  for (const entry of topArtistEntries) {
    if (artistSeeds.length >= RECOMMENDATION_LIMITS.artistSeeds) break;
    // The profile's artist key is the track's artist string as
    // heard; resolve it to a catalogue id through the pool: first
    // an exact artist-string match, then a primary-artist match.
    const exact = pool.find((track) => track.artists === entry.artist);
    const primary =
      exact ?? pool.find((track) => primaryArtistOf(track) === entry.artist);
    if (!primary) continue;
    const artistId = artistIdOf(primary);
    if (!artistId) continue;
    if (artistSeeds.some((seed) => seed.artistId === artistId)) continue;
    artistSeeds.push({ artistId, artistName: entry.artist });
  }

  const genreSeeds = input.genreLabels
    .map((label, index) => ({
      label,
      index,
      weight: profile.tags[label] ?? 0,
    }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .slice(0, RECOMMENDATION_LIMITS.genreSeeds)
    .map((entry) => entry.label);

  return { radioSeeds, artistSeeds, genreSeeds };
}

// ---------------------------------------------------------------------
// New-to-the-listener filtering (pure)
// ---------------------------------------------------------------------

/**
 * Keeps only tracks that are genuinely new: not in the known set
 * (history ∪ liked ∪ taste evidence), not already shown in an
 * accepted row, and not repeated inside this batch. Pure — the
 * caller owns the shown set and extends it only for accepted rows,
 * so a dropped row never poisons a later row's candidates.
 */
export function filterNewTracks(
  tracks: readonly Track[],
  knownIds: ReadonlySet<string>,
  shownIds: ReadonlySet<string>,
): Track[] {
  const seen = new Set<string>(shownIds);
  const fresh: Track[] = [];
  for (const track of tracks) {
    if (!track?.id) continue;
    if (knownIds.has(track.id) || seen.has(track.id)) continue;
    seen.add(track.id);
    fresh.push(track);
  }
  return fresh;
}

// ---------------------------------------------------------------------
// Row loading
// ---------------------------------------------------------------------

/**
 * Builds the recommendation rows for a seed set. Sources run in
 * seed-priority order (radio similarity first, then more-from-an-
 * artist, then Playlist Genre discovery) and each runs isolated: a
 * failing source costs its row, never the layer. A row is accepted
 * only with at least minRowTracks genuinely new tracks; only then
 * do its tracks join the shown set. Never rejects.
 */
export async function loadRecommendationRows(
  seeds: RecommendationSeeds,
  knownIds: ReadonlySet<string>,
  client: RecommendationClient,
): Promise<RecommendationRow[]> {
  const rows: RecommendationRow[] = [];
  const shown = new Set<string>();
  const historyIds = [...knownIds];

  const accept = (
    id: string,
    basis: RecommendationBasis,
    candidates: Track[],
  ) => {
    const fresh = filterNewTracks(candidates, knownIds, shown);
    if (fresh.length < RECOMMENDATION_LIMITS.minRowTracks) return;
    const tracks = fresh.slice(0, RECOMMENDATION_LIMITS.rowSize);
    for (const track of tracks) shown.add(track.id);
    rows.push({ id, basis, tracks });
  };

  for (const seed of seeds.radioSeeds) {
    try {
      const candidates = await client.getRadioTracks(
        seed.id,
        historyIds,
        RECOMMENDATION_LIMITS.radioSize,
      );
      accept(
        `reco-similar-${seed.id}`,
        { kind: "similarToTrack", seed },
        candidates,
      );
    } catch {
      // Source failed: the row is simply absent.
    }
  }

  for (const seed of seeds.artistSeeds) {
    try {
      const candidates = await client.getArtistTracks(seed.artistId);
      accept(
        `reco-artist-${seed.artistId}`,
        {
          kind: "moreFromArtist",
          artistId: seed.artistId,
          artistName: seed.artistName,
        },
        candidates,
      );
    } catch {
      // Source failed: the row is simply absent.
    }
  }

  for (const label of seeds.genreSeeds) {
    try {
      const candidates = await client.searchTracks(label);
      accept(
        `reco-genre-${label}`,
        { kind: "playlistGenre", label },
        candidates,
      );
    } catch {
      // Source failed: the row is simply absent.
    }
  }

  return rows;
}
