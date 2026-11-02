// Shared shapes for liveRave's party hosting: the public state the
// renderer publishes to the main process, the requests guests send
// back, and the info the host's own screen needs. The DJ session
// lives in the renderer; the guest web server lives in the main
// process; these types are the contract between them.

export interface PartyTrackListing {
  id: string;
  title: string;
  artist: string;
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
  /** Tonight's searchable tracks — the pool guests request from. */
  catalogue: PartyTrackListing[];
}

/** A guest request as the main process records it. */
export interface PartyRequestRecord {
  requestId: string;
  guestToken: string;
  trackId: string;
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
