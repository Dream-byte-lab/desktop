// Shared shapes for liveRave's party hosting: the public state the
// renderer publishes to the main process, the requests guests send
// back, and the info the host's own screen needs. The DJ session
// lives in the renderer; the guest web server lives in the main
// process; these types are the contract between them.

/**
 * Where a track listing reached the guest from (Step 6 provenance):
 * "tonight" — tonight's published catalogue (the host's queue);
 * "search" — the programme-wide search the guest ran from the party
 * page. The label rides the listing, the request record, the host's
 * feed and the published up-next, so a guest request is always
 * visibly a guest request, with its source attached.
 */
export type PartyTrackSource = "tonight" | "search";

export interface PartyTrackListing {
  id: string;
  title: string;
  artist: string;
  /** Provenance: which pool this listing came from. */
  source?: PartyTrackSource;
  /**
   * On up-next listings only: this queue entry is a guest request
   * (its `source` says where that guest found it).
   */
  requested?: boolean;
}

/** Everything a guest is allowed to see about tonight. */
export interface PartyPublicState {
  /** Whether the party is open to guests at all. */
  open: boolean;
  /**
   * The host's kill switch: when false, the party stays open and
   * visible but new requests are paused. The music never stops.
   */
  accepting: boolean;
  partyName: string;
  nowPlaying: PartyTrackListing | null;
  upNext: PartyTrackListing[];
  /**
   * Tonight's tracks — the host's queue, still the first pool a
   * guest browses. Since Step 6 it is no longer the ONLY pool: a
   * guest may also request anything the programme search surfaces
   * (those listings are vouched for per search, not published here).
   */
  catalogue: PartyTrackListing[];
}

/** A guest request as the main process records it. */
export interface PartyRequestRecord {
  requestId: string;
  guestToken: string;
  trackId: string;
  /** Provenance: the pool the guest picked this track from. */
  source: PartyTrackSource;
  /** When the request arrived, in party-clock seconds. */
  requestedAtSec: number;
  /**
   * The guest-facing status words, owned by the renderer's DJ brain:
   * received / waiting for its moment / coming soon / played /
   * not tonight. The server stores and relays them; it never invents
   * a musical judgement of its own.
   */
  status: string;
}

export interface PartyReaction {
  guestToken: string;
  kind: string;
  atMs: number;
}

export interface PartyRequestStatusUpdate {
  requestId: string;
  status: string;
}

/**
 * A programme search asked by a guest, relayed to the renderer —
 * the programme's search lives there; the server only carries the
 * question and the answer. `searchId` pairs a reply with its ask.
 */
export interface PartySearchRequest {
  searchId: string;
  query: string;
}

/** The renderer's answer to a PartySearchRequest. */
export interface PartySearchReply {
  searchId: string;
  tracks: PartyTrackListing[];
}

/** What the host's screen shows about the running party server. */
export interface PartyInfo {
  running: boolean;
  port: number;
  /**
   * Tonight's join secret, embedded in every join address as
   * `#join=<secret>`; guests must present it to receive a token.
   * Empty when no party is running. A fresh one is minted per party.
   */
  joinSecret: string;
  /** Join addresses on the local network, best first. */
  addresses: string[];
}
