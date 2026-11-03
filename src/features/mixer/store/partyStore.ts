import { create } from "zustand";
import type { PartyTrackSource } from "../../../../electron/liverave/types";

// The party panel's view of liveRave: whether the party is open,
// where guests join, what has been requested, and the host's own
// controls. The party host controller (engine/partyHost) owns the
// behaviour and writes snapshots here; this store is only the state
// the panel renders.

export interface PartyFeedItem {
  recordId: string;
  trackId: string;
  title: string;
  artist: string;
  /** Provenance: the pool the guest picked this track from. */
  source: PartyTrackSource;
  status: string;
}

export interface PartySnapshot {
  open: boolean;
  addresses: string[];
  feed: PartyFeedItem[];
  reactions: { fire: number; heart: number; clap: number };
  paused: boolean;
  doNotPlay: string[];
}

interface PartyStore extends PartySnapshot {
  setSnapshot: (snapshot: PartySnapshot) => void;
}

export const usePartyStore = create<PartyStore>((set) => ({
  open: false,
  addresses: [],
  feed: [],
  reactions: { fire: 0, heart: 0, clap: 0 },
  paused: false,
  doNotPlay: [],
  setSnapshot: (snapshot) => set(snapshot),
}));
