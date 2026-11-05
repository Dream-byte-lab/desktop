// PartyPanel.tsx — the party surface, written fresh against the
// landed seams (design §3.8 party seam + §10 interface language).
// It lives in AppFrame's capped DJ region under the Ribbon/Booth
// switch: the Booth swaps in and out, and a party the host cannot
// see or stop while the Booth is open would be a party out of
// reach — so the party surface is a sibling of both, in the same
// "booth at night" language, and it empties the region with them
// when there is nothing to show.
//
// WHAT IT IS: a watching + light-steering surface (automatic
// first). The brain weighs every request; this panel shows the
// weighing's outcomes and reasons verbatim and never re-decides
// a status. The programme list is the return value of the
// session's own evaluateRequests() — the evaluation the brain
// actually performs — refreshed on a 1 s cadence while a party is
// live and the set is running. liveRaveOpenRequests alone would
// hide every not-tonight verdict, so it is used only for counts
// before the first evaluation lands.
//
// DATA SOURCES, seam by seam:
// - Session (liverave/session.ts): submitGuestRequest /
//   evaluateRequests / guestStatus / liveRaveOpenRequests /
//   setDoNotPlay, plus isRunning and the activity feed's clock.
// - Party transport (electron/liverave, a named keep) through the
//   preload bridge on window.linerElectron: partyInfo /
//   partyStart / partyStop for the server's real state (running,
//   port, join addresses carrying tonight's join secret),
//   onPartyRequest for guest arrivals, onPartyReaction for the
//   room's reactions, partySetState to publish tonight's public
//   state, partySetRequestStatus to relay the brain's verdict
//   back to the guest who asked, in the transport's own guest
//   words (electron/liverave/types.ts).
// - Programme search (partySearchBridge.ts): onPartySearch /
//   partySearchReply carry guest searches and their answers. The
//   bridge answers from the app's own programme search seam —
//   the catalogue client the host's Search screen uses — and
//   caches every track it surfaces for tonight.
//
// NAMED GAPS — what the seams do NOT expose, rendered honestly:
// - Guests: PartyInfo carries no guest roster and no connected
//   count; the server's token set never leaves the main process.
//   This panel shows NO roster and invents no headcount — the
//   only guest evidence the seams publish is each request's
//   voter count (party.ts) and the reactions that arrive while
//   the panel is open.
// - Guest tokens are used only as the party seam's guestId (so
//   distinct phones vote distinctly); they are never displayed.
// - The session's upcoming ORDER is private: a scheduled
//   request's published position is party.ts's slot in that
//   order, and the public up-next this panel publishes is the
//   player queue's order with scheduled guest tracks flagged —
//   the session may re-place a guest track inside its own order.
// - The session does not publish its do-not-play list back, and
//   setDoNotPlay REPLACES the list. This panel therefore keeps
//   the record of what IT has blocked (module scope, so a
//   remount cannot silently drop a block when the next one is
//   set) and labels it exactly that: blocked here tonight.
// - Programme search (closed in Wave 4B): guest searches ARE
//   answered here now, by the bridge, and a request for a track
//   outside tonight's queue resolves — from the party's search
//   cache first, then by id through the catalogue — and is
//   weighed like any other arrival. Only an arrival whose id
//   neither pool knows (never surfaced by a search this party
//   answered, and unknown to the catalogue by id) stays
//   unweighed; those are counted and named below, never
//   silently dropped and never judged by this panel.
// - Requests are never paused from here: neither seam exposes
//   a pause-requests switch, so none is offered. Ending the
//   party (partyStop) is the host's real stop control.

import { useEffect, useMemo, useRef, useState } from "react";
import { renderSVG } from "uqr";
import {
  liveRaveSession,
  type LiveRaveSession,
} from "@/features/mixer/liverave/session";
import type {
  GuestRequest,
  GuestRequestStatus,
} from "@/features/mixer/liverave/party";
import { useDjState } from "@/features/mixer/liverave/state";
import { useDjSettings } from "@/features/mixer/liverave/settings";
import { usePlayerStore } from "@/features/player/store/playerStore";
import type { Track } from "@/shared/types";
import type {
  PartyInfo,
  PartyPublicState,
  PartyReaction,
  PartyRequestRecord,
  PartyRequestStatusUpdate,
  PartySearchReply,
  PartySearchRequest,
  PartyTrackListing,
  PartyTrackSource,
} from "../../../../electron/liverave/types";
import {
  createPartySearchBridge,
  type ProgrammeSearchSeam,
} from "./partySearchBridge";
import { formatTimeOfDay, personalityColour } from "./sessionView";

// ---------------------------------------------------------------------
// The transport seam, as this surface consumes it. The default
// implementation is the preload bridge; tests inject a fake.
// ---------------------------------------------------------------------

export interface PartyTransport {
  info(): Promise<PartyInfo>;
  start(): Promise<PartyInfo>;
  stop(): Promise<PartyInfo>;
  setState(state: PartyPublicState): void;
  setRequestStatus(update: PartyRequestStatusUpdate): void;
  onRequest(cb: (record: PartyRequestRecord) => void): () => void;
  onReaction(cb: (reaction: PartyReaction) => void): () => void;
  onSearch(cb: (request: PartySearchRequest) => void): () => void;
  searchReply(reply: PartySearchReply): void;
}

function defaultPartyTransport(): PartyTransport | null {
  if (typeof window === "undefined") return null;
  const api = window.linerElectron;
  if (!api?.partyInfo || !api?.partyStart || !api?.partyStop) return null;
  return {
    info: () => api.partyInfo(),
    start: () => api.partyStart(),
    stop: () => api.partyStop(),
    setState: (state) => api.partySetState(state),
    setRequestStatus: (update) => api.partySetRequestStatus(update),
    onRequest: (cb) => api.onPartyRequest(cb),
    onReaction: (cb) => api.onPartyReaction(cb),
    onSearch: (cb) => (api.onPartySearch ? api.onPartySearch(cb) : () => {}),
    searchReply: (reply) => {
      api.partySearchReply?.(reply);
    },
  };
}

/**
 * The guest-facing words for a session verdict, from the kept
 * transport's own vocabulary (electron/liverave/types.ts: the
 * server stores and relays them; it never invents a judgement).
 */
export function guestStatusWord(status: GuestRequestStatus): string {
  if (status === "scheduled") return "coming soon";
  if (status === "not-tonight") return "not tonight";
  return "waiting for its moment";
}

/** party.ts's two absolute-refusal reasons, verbatim. */
function isAbsoluteReason(reason: string | null): boolean {
  return (
    reason === "on tonight's do-not-play list" ||
    reason === "already played tonight"
  );
}

const STATUS_ORDER: Record<GuestRequestStatus, number> = {
  scheduled: 0,
  waiting: 1,
  "not-tonight": 2,
};

function sortRequests(requests: GuestRequest[]): GuestRequest[] {
  return [...requests].sort((a, z) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[z.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === "scheduled") {
      const bySlot = (a.slot ?? Infinity) - (z.slot ?? Infinity);
      if (bySlot !== 0) return bySlot;
    }
    if (z.votes !== a.votes) return z.votes - a.votes;
    return a.requestedAt - z.requestedAt;
  });
}

/**
 * Tracks blocked through THIS panel tonight (see the header: the
 * session replaces its list on every setDoNotPlay and publishes
 * no read-back, so the panel's own record is the only honest one
 * it can show). Module scope so unmount/remount keeps it.
 */
const blockedHereTonight = new Set<string>();

const PANEL_BG =
  "relative w-full overflow-hidden text-[#f2f0f7] " +
  "bg-[linear-gradient(165deg,#191226_0%,#14101d_60%,#100c18_100%)]";

export function PartyPanel({
  session = liveRaveSession,
  transport: transportProp,
  searchSeam,
}: {
  session?: LiveRaveSession;
  /** Undefined resolves the preload bridge; null means no bridge. */
  transport?: PartyTransport | null;
  /** Undefined uses the app's own catalogue client (the seam). */
  searchSeam?: ProgrammeSearchSeam;
}) {
  const intent = useDjState((state) => state.intent);
  const active = useDjState((state) => state.active);
  const personalityId = useDjSettings((state) => state.personalityId);
  const queue = usePlayerStore((state) => state.queue);
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const currentIndex = usePlayerStore((state) => state.currentIndex);

  const transport = useMemo(
    () =>
      transportProp === undefined ? defaultPartyTransport() : transportProp,
    [transportProp],
  );

  // The search bridge: one per transport+seam pairing. It holds
  // tonight's resolved programme tracks; its lifecycle (attach
  // while a party is live, clear when the party ends) is driven
  // by the effects below.
  const bridge = useMemo(
    () =>
      transport
        ? createPartySearchBridge({ transport, seam: searchSeam })
        : null,
    [transport, searchSeam],
  );

  const [info, setInfo] = useState<PartyInfo | null>(null);
  const [infoRead, setInfoRead] = useState(false);
  // Dismissal (fix-0119): the host can hide the panel for the
  // rest of the current intent-on period. It is a view fact
  // only — no party state moves — and it is overridden the
  // moment a party is live (a live party's panel, Start/End
  // controls included, is never hidden), reset when intent
  // turns off (so the next intent-on period shows it again),
  // and reset when a party starts. Guest requests can only
  // arrive while a party is live, so an arrival always finds
  // the panel up.
  const [dismissed, setDismissed] = useState(false);
  const [evaluated, setEvaluated] = useState<GuestRequest[]>([]);
  const [reactions, setReactions] = useState<Record<string, number>>({});
  const [unresolvedArrivals, setUnresolvedArrivals] = useState(0);
  const [busy, setBusy] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [blockedVersion, setBlockedVersion] = useState(0);
  const [tick, setTick] = useState(0);

  const intakeRef = useRef(new Map<string, string>());
  const relayedRef = useRef(new Map<string, string>());
  const publishedRef = useRef("");
  /** Which pool each requested track was picked from, per intake. */
  const provenanceRef = useRef(new Map<string, PartyTrackSource>());

  const partyRunning = info?.running === true;
  const djOn = intent || active;

  // The dismissal's reset rules (fix-0119): intent off ends the
  // intent-on period it scoped to; a party starting clears it.
  useEffect(() => {
    if (!intent) setDismissed(false);
  }, [intent]);
  useEffect(() => {
    if (partyRunning) setDismissed(false);
  }, [partyRunning]);
  const accent = personalityColour(personalityId);
  const joinUrl = info?.addresses[0] ?? "";

  const qrDataUrl = useMemo(() => {
    if (!joinUrl) return "";
    try {
      return `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(joinUrl))}`;
    } catch {
      return "";
    }
  }, [joinUrl]);

  // The server's real state, read on mount and kept fresh.
  useEffect(() => {
    if (!transport) {
      setInfoRead(true);
      return;
    }
    let cancelled = false;
    const read = () => {
      transport
        .info()
        .then((next) => {
          if (!cancelled) {
            setInfo(next);
            setInfoRead(true);
          }
        })
        .catch(() => {
          if (!cancelled) setInfoRead(true);
        });
    };
    read();
    const timer = setInterval(read, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [transport]);

  // A 1 s heartbeat while the panel could be visible: it drives
  // the evaluation refresh and keeps plain reads (open counts,
  // the session's running flag) current.
  useEffect(() => {
    if (!djOn && !partyRunning) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [djOn, partyRunning]);

  const relayStatuses = (requests: GuestRequest[]) => {
    if (!transport) return;
    const byTrack = new Map(requests.map((r) => [r.track.id, r.status]));
    for (const [requestId, trackId] of intakeRef.current) {
      const status = byTrack.get(trackId) ?? session.guestStatus(trackId);
      if (!status) continue;
      const word = guestStatusWord(status);
      if (relayedRef.current.get(requestId) === word) continue;
      relayedRef.current.set(requestId, word);
      transport.setRequestStatus({ requestId, status: word });
    }
  };

  // The evaluation the brain actually performs, surfaced: while
  // a party is live and the set is running, the panel asks the
  // session to weigh the book and renders what it returns.
  useEffect(() => {
    if (!partyRunning || !session.isRunning) return;
    const results = session.evaluateRequests();
    setEvaluated(results);
    relayStatuses(results);
    // `tick` is the 1 s heartbeat: it is the cadence dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partyRunning, session, transport, tick]);

  // The search bridge's lifecycle: subscribed exactly while the
  // panel is mounted and a party is live — no earlier, and the
  // detach unsubscribes, so nothing leaks past either boundary.
  useEffect(() => {
    if (!bridge || !partyRunning) return;
    return bridge.attach();
  }, [bridge, partyRunning]);

  // A party's end (however it arrives — this panel's End button,
  // or the server's state going dark) wipes tonight's resolved
  // programme tracks and provenance with it, like the server
  // forgets its search offers.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !partyRunning) {
      bridge?.clear();
      provenanceRef.current.clear();
    }
    wasRunningRef.current = partyRunning;
  }, [partyRunning, bridge]);

  // Guest arrivals: transport record → the session's book. The
  // record carries only a track id; the Track object the session
  // weighs is resolved widest first: tonight's queue, then the
  // party's programme-search cache, then by id through the
  // catalogue (the bridge owns the last two pools). Only an id
  // no pool knows stays unweighed — counted and named below.
  useEffect(() => {
    if (!transport || !partyRunning) return;
    let live = true;
    const submitResolved = (record: PartyRequestRecord, track: Track) => {
      intakeRef.current.set(record.requestId, record.trackId);
      session.submitGuestRequest(track, record.guestToken);
      const status = session.guestStatus(record.trackId);
      if (status) {
        const word = guestStatusWord(status);
        relayedRef.current.set(record.requestId, word);
        transport.setRequestStatus({
          requestId: record.requestId,
          status: word,
        });
      }
      if (session.isRunning) {
        setEvaluated(session.evaluateRequests());
      }
    };
    const off = transport.onRequest((record) => {
      // A guest arrival always surfaces the panel (fix-0119).
      setDismissed(false);
      provenanceRef.current.set(record.trackId, record.source);
      const queued = usePlayerStore
        .getState()
        .queue.find((candidate) => candidate.id === record.trackId);
      if (queued) {
        submitResolved(record, queued);
        return;
      }
      const cached = bridge?.cachedTrack(record.trackId);
      if (cached) {
        submitResolved(record, cached);
        return;
      }
      if (!bridge) {
        setUnresolvedArrivals((count) => count + 1);
        return;
      }
      void bridge.resolveTrack(record.trackId).then((track) => {
        if (!live) return;
        if (!track) {
          setUnresolvedArrivals((count) => count + 1);
          return;
        }
        submitResolved(record, track);
      });
    });
    return () => {
      live = false;
      off();
    };
  }, [transport, partyRunning, session, bridge]);

  // The room's reactions, tallied as they land while the panel
  // is open. The tally resets with each party.
  useEffect(() => {
    if (!transport || !partyRunning) return;
    setReactions({});
    const off = transport.onReaction((reaction) => {
      setReactions((tally) => ({
        ...tally,
        [reaction.kind]: (tally[reaction.kind] ?? 0) + 1,
      }));
    });
    return off;
  }, [transport, partyRunning]);

  // Tonight's public state, published to the guests: the party
  // is open to guests exactly while a set is running (requests
  // are weighed against a night that exists), the catalogue is
  // tonight's queue, and scheduled guest tracks are flagged in
  // the up-next. Republished only when the document changes.
  useEffect(() => {
    if (!transport || !partyRunning) return;
    const scheduled = evaluated.filter((r) => r.status === "scheduled");
    const scheduledIds = new Set(scheduled.map((r) => r.track.id));
    const listing = (track: Track): PartyTrackListing => ({
      id: track.id,
      title: track.title,
      artist: track.artists,
      ...(scheduledIds.has(track.id) ? { requested: true } : {}),
    });
    // A flagged up-next entry also carries the pool its guest
    // picked it from (the transport's provenance label), when
    // this panel took that request in.
    const upNextListing = (track: Track): PartyTrackListing => {
      const base = listing(track);
      const source = provenanceRef.current.get(track.id);
      return base.requested && source ? { ...base, source } : base;
    };
    const upNext: PartyTrackListing[] = queue
      .slice(Math.max(0, currentIndex) + 1)
      .map(upNextListing);
    const queuedIds = new Set(queue.map((t) => t.id));
    for (const request of scheduled) {
      if (!queuedIds.has(request.track.id)) {
        upNext.push(upNextListing(request.track));
      }
    }
    const state: PartyPublicState = {
      open: session.isRunning,
      accepting: true,
      partyName: "liveRave party",
      nowPlaying: currentTrack ? listing(currentTrack) : null,
      upNext,
      catalogue: queue.map(listing),
    };
    const signature = JSON.stringify(state);
    if (publishedRef.current === signature) return;
    publishedRef.current = signature;
    transport.setState(state);
  }, [
    transport,
    partyRunning,
    evaluated,
    queue,
    currentTrack,
    currentIndex,
    session,
  ]);

  const startParty = async () => {
    if (!transport || busy) return;
    setBusy(true);
    setTransportError(null);
    try {
      setInfo(await transport.start());
    } catch (error) {
      setTransportError(
        error instanceof Error
          ? error.message
          : "the party server did not start",
      );
    } finally {
      setBusy(false);
    }
  };

  const stopParty = async () => {
    if (!transport || busy) return;
    setBusy(true);
    setTransportError(null);
    try {
      setInfo(await transport.stop());
      setEvaluated([]);
      setUnresolvedArrivals(0);
      intakeRef.current.clear();
      relayedRef.current.clear();
      publishedRef.current = "";
      provenanceRef.current.clear();
      bridge?.clear();
    } catch (error) {
      setTransportError(
        error instanceof Error
          ? error.message
          : "the party server did not stop",
      );
    } finally {
      setBusy(false);
    }
  };

  const blockTrack = (trackId: string) => {
    blockedHereTonight.add(trackId);
    session.setDoNotPlay([...blockedHereTonight]);
    setBlockedVersion((value) => value + 1);
    if (session.isRunning) {
      const results = session.evaluateRequests();
      setEvaluated(results);
      relayStatuses(results);
    }
  };

  const unblockTrack = (trackId: string) => {
    blockedHereTonight.delete(trackId);
    session.setDoNotPlay([...blockedHereTonight]);
    setBlockedVersion((value) => value + 1);
    if (session.isRunning) {
      const results = session.evaluateRequests();
      setEvaluated(results);
      relayStatuses(results);
    }
  };

  // -- absence: DJ off and no party → the app is untouched -------
  if (!djOn && !partyRunning) return null;

  // -- dismissed for this intent-on period (fix-0119) -----------
  // A live party overrides the dismissal unconditionally: its
  // strip/panel and the End control stay reachable.
  if (dismissed && !partyRunning) return null;

  const openCount = session.liveRaveOpenRequests.length;

  // -- DJ off but a party is live: the stop control survives -----
  if (!djOn && partyRunning) {
    return (
      <section
        aria-label="Party is live"
        data-testid="party-panel-strip"
        className={`${PANEL_BG} border-t border-white/[0.07]`}
      >
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <p className="text-xs font-black tracking-[0.22em] uppercase">
            Party is live
          </p>
          <p className="min-w-0 flex-1 truncate text-[11px] text-white/55">
            {joinUrl
              ? `Guests join at ${joinUrl} · ${openCount} open request${openCount === 1 ? "" : "s"}`
              : "The party server published no join address."}
          </p>
          <p className="text-[11px] text-white/45">
            DJ mode is off — this strip stays so the party can always be ended
            from here.
          </p>
          <button
            type="button"
            onClick={() => void stopParty()}
            disabled={busy}
            className="cursor-pointer rounded-full bg-[#ff3d81]/20 px-3 py-1.5 text-[11px] font-bold tracking-[0.14em] text-[#ff8fb8] uppercase disabled:opacity-40"
          >
            End party
          </button>
        </div>
      </section>
    );
  }

  const requests = sortRequests(
    evaluated.length > 0 ? evaluated : session.liveRaveOpenRequests,
  );
  const scheduledCount = requests.filter(
    (r) => r.status === "scheduled",
  ).length;
  const notTonightCount = requests.filter(
    (r) => r.status === "not-tonight",
  ).length;
  const blockedList = [...blockedHereTonight]
    .map((trackId) => {
      const fromRequest = requests.find((r) => r.track.id === trackId)?.track;
      const fromQueue = queue.find((t) => t.id === trackId);
      const track = fromRequest ?? fromQueue;
      return { trackId, title: track ? track.title : trackId };
    })
    .sort((a, z) => a.title.localeCompare(z.title));
  void blockedVersion;

  const reactionEntries = Object.entries(reactions).sort(([a], [z]) =>
    a.localeCompare(z),
  );

  return (
    <section
      aria-label="Party — guest requests tonight"
      data-testid="party-panel"
      className={`${PANEL_BG} border-t border-white/[0.07]`}
    >
      <div className="flex flex-col gap-4 px-4 py-3">
        {/* Header ------------------------------------------------ */}
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-black tracking-[0.28em] uppercase">
            Party
          </h2>
          {partyRunning ? (
            <span
              className="rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-[0.14em] uppercase"
              style={{ background: `${accent}2e`, color: accent }}
              data-party-status="live"
            >
              Live
            </span>
          ) : (
            <span
              className="rounded-full bg-white/[0.07] px-2.5 py-0.5 text-[10px] font-bold tracking-[0.14em] text-white/60 uppercase"
              data-party-status="off"
            >
              Not running
            </span>
          )}
          <p className="text-[11px] text-white/50">
            The brain weighs every guest request against tonight — this panel
            watches the verdicts.
          </p>
          {partyRunning && (
            <button
              type="button"
              onClick={() => void stopParty()}
              disabled={busy}
              className="ml-auto cursor-pointer rounded-full bg-[#ff3d81]/20 px-3 py-1.5 text-[11px] font-bold tracking-[0.14em] text-[#ff8fb8] uppercase disabled:opacity-40"
            >
              End party
            </button>
          )}
          {!partyRunning && (
            <button
              type="button"
              aria-label="Hide party panel"
              title="Hide this panel until DJ mode is next switched on, or a party starts"
              onClick={() => setDismissed(true)}
              className="ml-auto cursor-pointer rounded-full bg-white/[0.07] px-3 py-1.5 text-[11px] font-bold tracking-[0.14em] text-white/60 uppercase"
            >
              Hide
            </button>
          )}
        </div>

        {transportError && (
          <p role="alert" className="text-xs text-[#ff8fb8]">
            {transportError}
          </p>
        )}

        {/* No transport bridge ------------------------------------ */}
        {!transport && (
          <p className="text-sm text-white/65" data-party-no-transport>
            Party hosting runs in the desktop app, where the party server lives.
            This window has no party bridge, so no party can be started or
            watched from here.
          </p>
        )}

        {/* No party running ---------------------------------------- */}
        {transport && infoRead && !partyRunning && (
          <div data-party-empty>
            <p className="text-sm text-white/70">
              No party is running — guests have nowhere to join yet.
            </p>
            <p className="mt-1 text-[11px] leading-snug text-white/45">
              Starting a party opens the guest server on this machine and mints
              tonight&apos;s join address. Guests on the same Wi-Fi scan or type
              it, and every request they send is weighed by the DJ brain against
              the set as it plays.
            </p>
            <button
              type="button"
              onClick={() => void startParty()}
              disabled={busy}
              className="mt-2 cursor-pointer rounded-full px-4 py-2 text-[11px] font-bold tracking-[0.14em] text-[#17121f] uppercase disabled:opacity-40"
              style={{ background: accent }}
            >
              Start a party
            </button>
          </div>
        )}

        {/* Live party ---------------------------------------------- */}
        {transport && partyRunning && (
          <>
            <div className="flex flex-col gap-4 sm:flex-row">
              {/* Invite */}
              <div
                className="flex shrink-0 flex-col items-center gap-2"
                data-party-invite
              >
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="QR code to join the party"
                    className="h-32 w-32 rounded-xl bg-white p-1.5"
                  />
                ) : (
                  <p className="max-w-40 text-center text-[11px] text-white/50">
                    No join address was published, so no QR code can be drawn.
                  </p>
                )}
                <p className="max-w-44 text-center text-xs font-medium break-all text-white/85">
                  {joinUrl || "No local network address was found"}
                </p>
                <p className="max-w-44 text-center text-[11px] text-white/45">
                  Guests: same Wi-Fi, scan or type the address. The address
                  carries tonight&apos;s join secret — a new one is minted for
                  every party.
                </p>
              </div>

              <div className="flex min-w-0 flex-1 flex-col gap-4">
                {/* Guests: the honest absence */}
                <div data-party-guests>
                  <h3 className="text-[11px] font-semibold tracking-[0.18em] text-white/50 uppercase">
                    Guests
                  </h3>
                  <p className="mt-1 text-xs leading-snug text-white/60">
                    The party transport does not publish a guest list or a
                    connected count to this screen, so no roster is shown. What
                    the seams do publish is on each request below: how many
                    distinct guests asked for it.
                  </p>
                  <p className="mt-1 text-xs leading-snug text-white/60">
                    Guests can also search the whole programme from their phones
                    — this screen answers those searches from the app&apos;s own
                    catalogue search, and a request for a song found that way is
                    weighed by the brain exactly like one from tonight&apos;s
                    list.
                  </p>
                  {reactionEntries.length > 0 ? (
                    <p
                      className="mt-1 text-xs text-white/70"
                      data-party-reactions
                    >
                      Reactions since this panel opened:{" "}
                      {reactionEntries
                        .map(([kind, count]) => `${kind} ${count}`)
                        .join(" · ")}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-white/40">
                      No reactions have arrived since this panel opened.
                    </p>
                  )}
                </div>

                {/* The guest programme */}
                <div data-party-programme>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[11px] font-semibold tracking-[0.18em] text-white/50 uppercase">
                      Guest programme
                    </h3>
                    <span className="text-[11px] text-white/45">
                      {requests.length === 0
                        ? "nothing asked yet"
                        : `${scheduledCount} scheduled · ${requests.length - scheduledCount - notTonightCount} waiting · ${notTonightCount} not tonight`}
                    </span>
                    <button
                      type="button"
                      data-party-reweigh
                      onClick={() => {
                        const results = session.evaluateRequests();
                        setEvaluated(results);
                        relayStatuses(results);
                      }}
                      className="ml-auto cursor-pointer rounded-full border border-white/20 px-2.5 py-1 text-[10px] font-bold tracking-[0.12em] text-white/80 uppercase"
                    >
                      Re-weigh now
                    </button>
                  </div>

                  {!session.isRunning && (
                    <p className="mt-1 text-[11px] leading-snug text-white/45">
                      The DJ set is not running, so guests currently see the
                      party as not open and the brain has no night to weigh
                      requests against — verdicts land once a set starts.
                    </p>
                  )}
                  {unresolvedArrivals > 0 && (
                    <p
                      className="mt-1 text-[11px] leading-snug text-[#ffb300]"
                      data-party-unresolved
                    >
                      {unresolvedArrivals} guest request
                      {unresolvedArrivals === 1 ? "" : "s"} arrived for tracks
                      that could not be resolved tonight — not in tonight&apos;s
                      queue, not surfaced by any programme search this party
                      answered, and not known to the catalogue by id. The
                      session can only weigh tracks it holds, so those requests
                      stay unweighed — they are counted here rather than dropped
                      silently.
                    </p>
                  )}

                  {requests.length > 0 ? (
                    <ol
                      className="mt-2 flex flex-col gap-1.5"
                      data-party-requests
                    >
                      {requests.map((request) => {
                        const absolute = isAbsoluteReason(request.reason);
                        const blocked = blockedHereTonight.has(
                          request.track.id,
                        );
                        return (
                          <li
                            key={request.id}
                            data-party-request={request.status}
                            data-absolute={absolute || undefined}
                            className="rounded-lg bg-white/[0.04] px-2.5 py-2"
                          >
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                              <span className="min-w-0 truncate text-sm font-bold text-white">
                                {request.track.title}
                              </span>
                              <span className="truncate text-[11px] text-white/50">
                                {request.track.artists}
                              </span>
                              <span
                                className={
                                  request.status === "scheduled"
                                    ? "ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold tracking-[0.12em] uppercase"
                                    : request.status === "not-tonight"
                                      ? "ml-auto rounded-full border border-dashed border-[#ff8fb8]/50 px-2 py-0.5 text-[10px] font-bold tracking-[0.12em] text-[#ff8fb8] uppercase"
                                      : "ml-auto rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] font-bold tracking-[0.12em] text-white/70 uppercase"
                                }
                                style={
                                  request.status === "scheduled"
                                    ? {
                                        background: `${accent}2e`,
                                        color: accent,
                                      }
                                    : undefined
                                }
                              >
                                {request.status}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] text-white/55">
                              {request.votes} guest
                              {request.votes === 1 ? "" : "s"} asked ·{" "}
                              {formatTimeOfDay(request.requestedAt)}
                              {request.status === "scheduled" &&
                              request.slot !== null
                                ? ` · placed #${request.slot + 1} in the upcoming order`
                                : ""}
                            </p>
                            {request.reason && (
                              <p className="mt-0.5 text-[11px] text-white/70">
                                {request.reason}
                                {absolute && (
                                  <span className="ml-1 font-bold text-[#ff8fb8]">
                                    — absolute: there is no override for this
                                    tonight.
                                  </span>
                                )}
                              </p>
                            )}
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {blocked ? (
                                <span className="rounded-full bg-[#ff3d81]/15 px-2 py-0.5 text-[10px] font-semibold text-[#ff8fb8]">
                                  Blocked here tonight
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  data-party-block={request.track.id}
                                  onClick={() => blockTrack(request.track.id)}
                                  className="cursor-pointer rounded-full border border-white/15 px-2 py-0.5 text-[10px] font-semibold text-white/65 hover:text-white"
                                >
                                  Do not play tonight
                                </button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p
                      className="mt-2 text-sm text-white/60"
                      data-party-requests-empty
                    >
                      No guest requests yet — when a guest asks for a song, it
                      appears here with the brain&apos;s verdict and the reason
                      it gives.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Blocked here tonight ------------------------------------- */}
        {transport && blockedList.length > 0 && (
          <div data-party-blocked>
            <h3 className="text-[11px] font-semibold tracking-[0.18em] text-white/50 uppercase">
              Do-not-play — blocked here tonight
            </h3>
            <p className="mt-1 text-[11px] leading-snug text-white/45">
              The session enforces this list absolutely and does not publish it
              back; this is the record of the blocks set from this panel.
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {blockedList.map((entry) => (
                <button
                  key={entry.trackId}
                  type="button"
                  data-party-unblock={entry.trackId}
                  onClick={() => unblockTrack(entry.trackId)}
                  title="Remove from the do-not-play list"
                  className="cursor-pointer rounded-full bg-[#ff3d81]/15 px-2 py-0.5 text-[11px] font-semibold text-[#ff8fb8]"
                >
                  {entry.title} ×
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
