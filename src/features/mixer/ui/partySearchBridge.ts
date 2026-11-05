// partySearchBridge.ts — the party search bridge (Wave 4B, Step 6).
//
// THE SEARCH SEAM. The host's own Search screen queries the
// catalogue through the search feature's hooks
// (src/features/search/hooks/useSearchTracks.ts), and those hooks
// are a thin React wrapper over one call: `api.search(query,
// "track")` from "@/shared/api", with each ApiTrack converted by
// `toClientTrack`. By-id resolution rides the same client:
// `api.getTrack(id)` (the call the deeplink handler uses, also
// converted with `toClientTrack`). This bridge uses exactly that
// seam — no second catalogue is invented, and the wrapping lives
// here, in the party surface's own neighbourhood.
//
// WHAT THE BRIDGE DOES:
// - While attached (the panel mounts it only while a party is
//   live), it subscribes to the transport's onPartySearch and
//   answers EVERY ask with exactly one partySearchReply, in the
//   transport's own result shape (PartyTrackListing, stamped
//   source: "search" — the ids the guest side can act on, which
//   the server then vouches for as requestable offers).
// - A malformed ask (missing/blank/one-character query — the
//   host's own search likewise refuses under two characters) and
//   a failed search both get an honest EMPTY reply, immediately.
//   Nothing ever hangs: the server bounds its wait at 10 s and
//   answers the guest 504 if no reply lands, so a swallowed ask
//   here would surface as a guest-facing failure, not silence.
// - Guests typing is many small queries. The seam load is
//   bounded the way the host's own search bounds it, without
//   dropping a single reply: identical in-flight queries share
//   one seam call, identical finished queries are served from a
//   short result cache, results are deduped by exact track id
//   and capped. (A debounce that dropped superseded asks would
//   hang their guests, so none is used.)
// - Every track a search surfaces is cached by exact id for the
//   party's life. That cache is the first resolution pool for a
//   guest request that arrives for a track outside tonight's
//   queue; the second pool is the catalogue's own by-id lookup
//   (api.getTrack), so even a search offer the server evicted,
//   or an ask from a search this panel never saw, still resolves
//   when the catalogue knows the id. What remains unresolvable
//   is named precisely in resolveTrack's contract below.

import { api, toClientTrack, type ApiTrack } from "@/shared/api";
import type { Track } from "@/shared/types";
import type {
  PartySearchReply,
  PartySearchRequest,
  PartyTrackListing,
} from "../../../../electron/liverave/types";

/** How many programme results one guest search may surface. */
export const PARTY_SEARCH_LIMIT = 25;

/** The host's own search refuses queries under two characters. */
export const PARTY_SEARCH_MIN_QUERY = 2;

/**
 * The programme seam, as the bridge consumes it. The default
 * implementation is the app's own catalogue client; tests inject
 * a fake. Both halves are the Search screen's own source.
 */
export interface ProgrammeSearchSeam {
  /** The programme-wide track search (api.search, "track"). */
  searchTracks(query: string): Promise<Track[]>;
  /**
   * By-id track resolution (api.getTrack). Resolves null when
   * the catalogue does not know the id — the one genuinely
   * unresolvable sub-case (see the bridge's resolveTrack).
   */
  getTrackById(trackId: string): Promise<Track | null>;
}

export const defaultProgrammeSearchSeam: ProgrammeSearchSeam = {
  async searchTracks(query: string): Promise<Track[]> {
    const res = await api.search(query, "track");
    const seen = new Set<string>();
    const tracks: Track[] = [];
    for (const item of res.items) {
      if (item.type !== "track") continue;
      const track = toClientTrack(item as ApiTrack & { type: "track" });
      if (!track.id || seen.has(track.id)) continue;
      seen.add(track.id);
      tracks.push(track);
      if (tracks.length >= PARTY_SEARCH_LIMIT) break;
    }
    return tracks;
  },

  async getTrackById(trackId: string): Promise<Track | null> {
    try {
      const details = await api.getTrack(trackId);
      const track = toClientTrack(details);
      if (!track.title) return null;
      // Keep the id the caller asked for (clientCatalog's own
      // snapshot rule): the session and the status relay key on
      // the requested id, so a canonicalised id here would make
      // the resolution unfindable by its own request.
      return track.id === trackId ? track : { ...track, id: trackId };
    } catch {
      return null;
    }
  },
};

/** The transport slice the bridge needs (PartyPanel's seam). */
export interface PartySearchTransport {
  onSearch(cb: (request: PartySearchRequest) => void): () => void;
  searchReply(reply: PartySearchReply): void;
}

/** The guest-facing listings for programme tracks, source-stamped. */
export function partySearchListings(
  tracks: readonly Track[],
): PartyTrackListing[] {
  return tracks.map((track) => ({
    id: track.id,
    title: track.title,
    artist: track.artists,
    source: "search" as const,
  }));
}

export interface PartySearchBridge {
  /**
   * Subscribes to guest searches. Returns the detach function;
   * attaching twice without detaching is a no-op that returns
   * the live detach. Detach unsubscribes — no leaked listeners.
   */
  attach(): () => void;
  /** True while subscribed. */
  readonly attached: boolean;
  /** A track this party's searches already resolved, if held. */
  cachedTrack(trackId: string): Track | undefined;
  /**
   * Resolves a track id to a full Track, widest pool first:
   * tonight's search cache, then the catalogue's by-id lookup
   * (whose result is cached for the rest of the party).
   * Resolves null ONLY when both miss — the id was never
   * surfaced by a search this bridge answered AND the catalogue
   * does not know it (unknown id, a lookup failure, or details
   * with no title). That is the genuinely unresolvable arrival;
   * the panel counts and names exactly those.
   */
  resolveTrack(trackId: string): Promise<Track | null>;
  /** Drops every cached track and cached answer (party's end). */
  clear(): void;
}

export function createPartySearchBridge(deps: {
  transport: PartySearchTransport;
  seam?: ProgrammeSearchSeam;
  limit?: number;
}): PartySearchBridge {
  const seam = deps.seam ?? defaultProgrammeSearchSeam;
  const limit = deps.limit ?? PARTY_SEARCH_LIMIT;

  const trackCache = new Map<string, Track>();
  const answerCache = new Map<string, Track[]>();
  const inFlightSearches = new Map<string, Promise<Track[]>>();
  const inFlightLookups = new Map<string, Promise<Track | null>>();
  let detachLive: (() => void) | null = null;

  function reply(searchId: string, tracks: readonly Track[]): void {
    try {
      deps.transport.searchReply({
        searchId,
        tracks: partySearchListings(tracks.slice(0, limit)),
      });
    } catch {
      // A reply channel that throws must not take the bridge
      // down with it; the server's own timeout covers the guest.
    }
  }

  function runSearch(query: string): Promise<Track[]> {
    const cached = answerCache.get(query);
    if (cached) return Promise.resolve(cached);
    const inFlight = inFlightSearches.get(query);
    if (inFlight) return inFlight;
    const run = (async () => {
      try {
        const tracks = await seam.searchTracks(query);
        const shaped: Track[] = [];
        const seen = new Set<string>();
        for (const track of tracks) {
          if (!track?.id || seen.has(track.id)) continue;
          seen.add(track.id);
          shaped.push(track);
          trackCache.set(track.id, track);
          if (shaped.length >= limit) break;
        }
        answerCache.set(query, shaped);
        return shaped;
      } finally {
        inFlightSearches.delete(query);
      }
    })();
    inFlightSearches.set(query, run);
    return run;
  }

  async function handleSearch(request: PartySearchRequest): Promise<void> {
    const searchId =
      request && typeof request.searchId === "string" ? request.searchId : "";
    if (!searchId) return; // No id: no reply can be paired.
    const query = typeof request.query === "string" ? request.query.trim() : "";
    if (query.length < PARTY_SEARCH_MIN_QUERY) {
      reply(searchId, []);
      return;
    }
    try {
      reply(searchId, await runSearch(query));
    } catch {
      reply(searchId, []);
    }
  }

  function attach(): () => void {
    if (detachLive) return detachLive;
    const off = deps.transport.onSearch((request) => {
      void handleSearch(request);
    });
    let detached = false;
    detachLive = () => {
      if (detached) return;
      detached = true;
      detachLive = null;
      off();
    };
    return detachLive;
  }

  async function resolveTrack(trackId: string): Promise<Track | null> {
    if (!trackId) return null;
    const cached = trackCache.get(trackId);
    if (cached) return cached;
    const inFlight = inFlightLookups.get(trackId);
    if (inFlight) return inFlight;
    const run = (async () => {
      try {
        const track = await seam.getTrackById(trackId);
        if (!track || !track.id) return null;
        trackCache.set(trackId, track);
        if (track.id !== trackId) trackCache.set(track.id, track);
        return track;
      } catch {
        return null;
      } finally {
        inFlightLookups.delete(trackId);
      }
    })();
    inFlightLookups.set(trackId, run);
    return run;
  }

  return {
    attach,
    get attached() {
      return detachLive !== null;
    },
    cachedTrack: (trackId) => trackCache.get(trackId),
    resolveTrack,
    clear() {
      trackCache.clear();
      answerCache.clear();
    },
  };
}
