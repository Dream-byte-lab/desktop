import type {
  PartyPublicState,
  PartyReaction,
  PartyRequestRecord,
} from "../../../../electron/liverave/types";
import { usePlayerStore } from "../../player/store/playerStore";
import { djSession } from "./djSession";
import { guestStatus, type RaveDecision } from "./liveRave";
import { usePartyStore, type PartyFeedItem } from "../store/partyStore";

// The party host: the renderer-side half of liveRave, and the piece
// that closes the circuit. The main-process server takes requests
// from guests; this controller hears each one, hands it to the DJ
// session (which prepares the track and refuses it if unplayable),
// asks the queue layer for verdicts, and sends the honest status
// words back to the server for each guest. It also publishes
// tonight's public state — what's playing, what's next, and the
// catalogue guests may request from, which is tonight's queue.
//
// One subtlety lives here: when several guests request the same
// song, the DJ brain keeps ONE canonical request (the rest are
// votes), while the server holds one record per guest. This
// controller keeps the link between the two, so every guest who
// asked hears the verdict meant for their song.

/** Links a server's per-guest record to the brain's canonical request. */
export function linkRecordId(
  recordsByCanonical: Map<string, Set<string>>,
  recordId: string,
  canonicalId: string,
): void {
  const set = recordsByCanonical.get(canonicalId) ?? new Set<string>();
  set.add(recordId);
  recordsByCanonical.set(canonicalId, set);
}

/**
 * Turns the brain's decisions into per-record status updates: every
 * server record linked to a decided canonical request gets the
 * decision's guest-facing words.
 */
export function statusUpdatesForDecisions(
  decisions: RaveDecision[],
  recordsByCanonical: Map<string, ReadonlySet<string>>,
  ageSecByCanonical: Map<string, number>,
): { recordId: string; status: string }[] {
  const updates: { recordId: string; status: string }[] = [];
  for (const decision of decisions) {
    const records = recordsByCanonical.get(decision.requestId);
    if (!records) continue;
    const status = guestStatus(
      decision,
      ageSecByCanonical.get(decision.requestId) ?? 0,
    );
    for (const recordId of records) updates.push({ recordId, status });
  }
  return updates;
}

const PARTY_NAME = "liveRave party";
const POLL_MS = 2000;

class PartyHost {
  private startedAtMs = 0;
  private feed = new Map<string, PartyFeedItem>();
  private recordsByCanonical = new Map<string, Set<string>>();
  private canonicalTrack = new Map<string, string>();
  private canonicalRequestedAt = new Map<string, number>();
  private statusByCanonical = new Map<string, string>();
  private reactions = { fire: 0, heart: 0, clap: 0 };
  private doNotPlay: string[] = [];
  private paused = false;
  private addresses: string[] = [];
  private poll: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: (() => void)[] = [];
  private lastPublishedKey = "";
  private lastCurrentTrackId: string | null = null;

  get isOpen(): boolean {
    return this.poll !== null;
  }

  async start(): Promise<boolean> {
    const bridge = window.linerElectron;
    if (!bridge || this.isOpen || !djSession.isRunning) return false;
    const info = await bridge.partyStart();
    if (!info.running) return false;
    this.addresses = info.addresses;
    this.startedAtMs = Date.now();
    this.lastCurrentTrackId =
      usePlayerStore.getState().currentTrack?.id ?? null;
    this.unsubscribers.push(
      bridge.onPartyRequest((record) => {
        void this.handleRequest(record);
      }),
      bridge.onPartyReaction((reaction) => this.handleReaction(reaction)),
    );
    this.publishState(true);
    this.poll = setInterval(() => this.tick(), POLL_MS);
    this.syncStore();
    return true;
  }

  async stop(): Promise<void> {
    const bridge = window.linerElectron;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.feed.clear();
    this.recordsByCanonical.clear();
    this.canonicalTrack.clear();
    this.canonicalRequestedAt.clear();
    this.statusByCanonical.clear();
    this.reactions = { fire: 0, heart: 0, clap: 0 };
    this.lastPublishedKey = "";
    if (bridge) await bridge.partyStop();
    this.syncStore();
  }

  /** The kill switch: pauses new requests; the music never stops. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.publishState(true);
    this.syncStore();
  }

  setDoNotPlay(values: string[]): void {
    this.doNotPlay = [...values];
    djSession.setLiveRaveDoNotPlay(this.doNotPlay);
    void this.evaluate();
    this.syncStore();
  }

  private handleReaction(reaction: PartyReaction): void {
    if (reaction.kind === "fire") this.reactions.fire += 1;
    else if (reaction.kind === "heart") this.reactions.heart += 1;
    else if (reaction.kind === "clap") this.reactions.clap += 1;
    else return;
    this.syncStore();
  }

  private async handleRequest(record: PartyRequestRecord): Promise<void> {
    const bridge = window.linerElectron;
    if (!bridge) return;
    const track = usePlayerStore
      .getState()
      .queue.find((candidate) => candidate.id === record.trackId);
    this.feed.set(record.requestId, {
      recordId: record.requestId,
      trackId: record.trackId,
      title: track?.title ?? record.trackId,
      artist: track?.artists ?? "",
      status: "received",
    });
    this.syncStore();
    if (!track) {
      this.setRecordStatus(record.requestId, "not tonight");
      return;
    }
    const canonical = await djSession.submitLiveRaveRequest({
      id: record.requestId,
      guestId: record.guestToken,
      track,
      requestedAtSec: record.requestedAtSec,
    });
    if (!canonical) {
      this.setRecordStatus(record.requestId, "not tonight");
      return;
    }
    linkRecordId(this.recordsByCanonical, record.requestId, canonical.id);
    this.canonicalTrack.set(canonical.id, canonical.track.trackId);
    if (!this.canonicalRequestedAt.has(canonical.id)) {
      this.canonicalRequestedAt.set(canonical.id, canonical.requestedAtSec);
    }
    await this.evaluate();
  }

  private async evaluate(): Promise<void> {
    const bridge = window.linerElectron;
    if (!bridge || !this.isOpen) return;
    const nowSec = Math.max(0, (Date.now() - this.startedAtMs) / 1000);
    const decisions = await djSession.evaluateLiveRaveQueue(nowSec);
    const ages = new Map<string, number>();
    for (const [canonicalId, requestedAt] of this.canonicalRequestedAt) {
      ages.set(canonicalId, nowSec - requestedAt);
    }
    for (const update of statusUpdatesForDecisions(
      decisions,
      this.recordsByCanonical,
      ages,
    )) {
      this.setRecordStatus(update.recordId, update.status);
    }
    for (const decision of decisions) {
      const status = guestStatus(decision, ages.get(decision.requestId) ?? 0);
      this.statusByCanonical.set(decision.requestId, status);
    }
  }

  private setRecordStatus(recordId: string, status: string): void {
    window.linerElectron?.partySetRequestStatus({
      requestId: recordId,
      status,
    });
    const item = this.feed.get(recordId);
    if (item) {
      item.status = status;
      this.syncStore();
    }
  }

  private tick(): void {
    this.publishState(false);
    const currentId = usePlayerStore.getState().currentTrack?.id ?? null;
    if (currentId && currentId !== this.lastCurrentTrackId) {
      this.lastCurrentTrackId = currentId;
      // A requested song that starts playing has earned its "played".
      for (const [canonicalId, trackId] of this.canonicalTrack) {
        if (
          trackId === currentId &&
          this.statusByCanonical.get(canonicalId) === "coming soon"
        ) {
          this.statusByCanonical.set(canonicalId, "played");
          for (const recordId of this.recordsByCanonical.get(canonicalId) ??
            []) {
            this.setRecordStatus(recordId, "played");
          }
        }
      }
      void this.evaluate();
    }
  }

  private publishState(force: boolean): void {
    const bridge = window.linerElectron;
    if (!bridge) return;
    const { queue, currentTrack, currentIndex } = usePlayerStore.getState();
    const seen = new Set<string>();
    const catalogue = queue
      .filter((track) => {
        if (seen.has(track.id)) return false;
        seen.add(track.id);
        return true;
      })
      .map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artists,
      }));
    const state: PartyPublicState = {
      open: true,
      accepting: !this.paused,
      partyName: PARTY_NAME,
      nowPlaying: currentTrack
        ? {
            id: currentTrack.id,
            title: currentTrack.title,
            artist: currentTrack.artists,
          }
        : null,
      upNext: queue.slice(currentIndex + 1, currentIndex + 4).map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artists,
      })),
      catalogue,
    };
    const key = JSON.stringify([
      state.nowPlaying?.id,
      state.upNext.map((track) => track.id),
      state.catalogue.length,
      state.accepting,
    ]);
    if (!force && key === this.lastPublishedKey) return;
    this.lastPublishedKey = key;
    bridge.partySetState(state);
  }

  private syncStore(): void {
    usePartyStore.getState().setSnapshot({
      open: this.isOpen,
      addresses: this.addresses,
      feed: [...this.feed.values()].reverse(),
      reactions: { ...this.reactions },
      paused: this.paused,
      doNotPlay: [...this.doNotPlay],
    });
  }
}

/** The shared party host used by the panel. */
export const partyHost = new PartyHost();
