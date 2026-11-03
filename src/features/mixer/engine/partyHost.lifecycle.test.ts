import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A controllable stand-in for the DJ session. The party host reads
// its running state and hands it guest requests; nothing else about
// the real session matters to the party's lifecycle.
const fakeSession = vi.hoisted(() => ({
  isRunning: true,
  setLiveRaveDoNotPlay: vi.fn(),
  submitLiveRaveRequest: vi.fn(async () => null),
  evaluateLiveRaveQueue: vi.fn(async () => []),
}));

vi.mock("./djSession", () => ({ djSession: fakeSession }));

// A stand-in programme: one track the whole-programme search can
// find that is NOT in tonight's queue (Step 6's whole point).
const fakeProgramme = vi.hoisted(() => ({
  track: {
    id: "prog-1",
    title: "Programme Song",
    artists: "Programme Artist",
    coverUrl: "",
    durationMs: 200_000,
    playCount: 0,
  },
}));

vi.mock("./partyProgrammeSearch", () => ({
  searchProgrammeTracks: vi.fn(async () => [fakeProgramme.track]),
  searchListings: (
    tracks: readonly { id: string; title: string; artists: string }[],
  ) =>
    tracks.map((track) => ({
      id: track.id,
      title: track.title,
      artist: track.artists,
      source: "search" as const,
    })),
}));

import { partyHost } from "./partyHost";
import { useDjModeStore } from "../store/djModeStore";
import { usePartyStore } from "../store/partyStore";
import { usePlayerStore } from "../../player/store/playerStore";

type ReactionHandler = (reaction: {
  guestToken: string;
  kind: string;
  atMs: number;
}) => void;

type RequestHandler = (record: {
  requestId: string;
  guestToken: string;
  trackId: string;
  source: "tonight" | "search";
  requestedAtSec: number;
  status: string;
}) => void;

type SearchHandler = (request: { searchId: string; query: string }) => void;

function makeBridge() {
  const bridge = {
    reactionHandler: null as ReactionHandler | null,
    requestHandler: null as RequestHandler | null,
    searchHandler: null as SearchHandler | null,
    partyStart: vi.fn(async () => ({
      running: true,
      port: 8471,
      joinSecret: "test-secret",
      addresses: ["http://192.168.1.2:8471/#join=test-secret"],
    })),
    partyStop: vi.fn(async () => ({
      running: false,
      port: 0,
      joinSecret: "",
      addresses: [],
    })),
    partySetState: vi.fn(),
    partySetRequestStatus: vi.fn(),
    partySearchReply: vi.fn(),
    onPartyRequest: vi.fn((handler: RequestHandler) => {
      bridge.requestHandler = handler;
      return () => {
        bridge.requestHandler = null;
      };
    }),
    onPartySearch: vi.fn((handler: SearchHandler) => {
      bridge.searchHandler = handler;
      return () => {
        bridge.searchHandler = null;
      };
    }),
    onPartyReaction: vi.fn((handler: ReactionHandler) => {
      bridge.reactionHandler = handler;
      return () => {
        bridge.reactionHandler = null;
      };
    }),
  };
  return bridge;
}

let bridge: ReturnType<typeof makeBridge>;

/** Lets the host's async stop() finish its bridge round-trip. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  bridge = makeBridge();
  window.linerElectron = bridge as any;
  fakeSession.isRunning = true;
  fakeSession.submitLiveRaveRequest.mockResolvedValue(null);
  useDjModeStore.setState({ active: true });
  usePlayerStore.setState({ queue: [], currentIndex: -1, currentTrack: null });
});

afterEach(async () => {
  await partyHost.stop();
  useDjModeStore.setState({ active: false });
  window.linerElectron = undefined as any;
  vi.clearAllMocks();
});

describe("partyHost lifecycle", () => {
  it("ends the party when the DJ session ends", async () => {
    expect(await partyHost.start()).toBe(true);
    expect(usePartyStore.getState().open).toBe(true);

    bridge.reactionHandler?.({
      guestToken: "guest-1",
      kind: "fire",
      atMs: Date.now(),
    });
    expect(usePartyStore.getState().reactions.fire).toBe(1);

    // The session ends — DJ toggled off, an arbitration stop, or
    // the session stopping on its own; the DJ-mode store hears all
    // of them the same way, and the party must follow.
    useDjModeStore.getState().setActive(false);
    await flush();

    const snapshot = usePartyStore.getState();
    expect(partyHost.isOpen).toBe(false);
    expect(snapshot.open).toBe(false);
    expect(snapshot.reactions).toEqual({ fire: 0, heart: 0, clap: 0 });
    expect(snapshot.feed).toEqual([]);
    expect(bridge.partyStop).toHaveBeenCalledTimes(1);
  });

  it("starting over a still-open party wipes it completely first", async () => {
    expect(await partyHost.start()).toBe(true);
    bridge.reactionHandler?.({
      guestToken: "guest-1",
      kind: "heart",
      atMs: Date.now(),
    });
    expect(usePartyStore.getState().reactions.heart).toBe(1);

    // The old party never ended (its panel vanished with DJ mode),
    // and the host starts again: no silent no-op, no inherited
    // reactions — the old party is fully stopped first.
    expect(await partyHost.start()).toBe(true);

    const snapshot = usePartyStore.getState();
    expect(snapshot.open).toBe(true);
    expect(snapshot.reactions).toEqual({ fire: 0, heart: 0, clap: 0 });
    expect(snapshot.feed).toEqual([]);
    expect(bridge.partyStart).toHaveBeenCalledTimes(2);
    expect(bridge.partyStop).toHaveBeenCalledTimes(1);
    expect(bridge.partyStop.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.partyStart.mock.invocationCallOrder[1],
    );
  });

  it("stop leaves a completely clean snapshot", async () => {
    expect(await partyHost.start()).toBe(true);
    partyHost.setPaused(true);
    bridge.reactionHandler?.({
      guestToken: "guest-1",
      kind: "clap",
      atMs: Date.now(),
    });

    await partyHost.stop();

    const snapshot = usePartyStore.getState();
    expect(snapshot.open).toBe(false);
    expect(snapshot.addresses).toEqual([]);
    expect(snapshot.paused).toBe(false);
    expect(snapshot.reactions).toEqual({ fire: 0, heart: 0, clap: 0 });
    expect(snapshot.feed).toEqual([]);
  });
});

describe("partyHost open guest requests (Step 6)", () => {
  it("answers a programme search, then resolves a request from it", async () => {
    expect(await partyHost.start()).toBe(true);

    bridge.searchHandler?.({ searchId: "s1", query: "programme" });
    await flush();
    await flush();
    expect(bridge.partySearchReply).toHaveBeenCalledWith({
      searchId: "s1",
      tracks: [
        {
          id: "prog-1",
          title: "Programme Song",
          artist: "Programme Artist",
          source: "search",
        },
      ],
    });

    fakeSession.submitLiveRaveRequest.mockResolvedValue({
      id: "req-1",
      track: { trackId: "prog-1" },
    } as never);
    bridge.requestHandler?.({
      requestId: "req-1",
      guestToken: "guest-1",
      trackId: "prog-1",
      source: "search",
      requestedAtSec: 30,
      status: "received",
    });
    await flush();
    await flush();

    // The session received the resolved programme track itself —
    // through the same seam a queue request uses.
    expect(fakeSession.submitLiveRaveRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        track: expect.objectContaining({ id: "prog-1" }),
      }),
    );
    // The host's feed labels it a guest request with its source.
    const feedItem = usePartyStore
      .getState()
      .feed.find((item) => item.recordId === "req-1");
    expect(feedItem).toMatchObject({
      title: "Programme Song",
      source: "search",
    });

    // And once the track sits in the queue's up-next, the published
    // state labels it as a guest request from the programme search.
    usePlayerStore.setState({
      queue: [
        { id: "now-1", title: "Now", artists: "A" } as never,
        fakeProgramme.track as never,
      ],
      currentIndex: 0,
      currentTrack: { id: "now-1", title: "Now", artists: "A" } as never,
    });
    partyHost.setPaused(true);
    const published = bridge.partySetState.mock.calls.at(-1)?.[0] as {
      upNext: { id: string; requested?: boolean; source?: string }[];
    };
    expect(published.upNext[0]).toMatchObject({
      id: "prog-1",
      requested: true,
      source: "search",
    });
  });

  it("answers a programme request the session refuses with not tonight", async () => {
    expect(await partyHost.start()).toBe(true);
    bridge.searchHandler?.({ searchId: "s1", query: "programme" });
    await flush();
    await flush();

    // The default fake session refuses (preparation failed).
    bridge.requestHandler?.({
      requestId: "req-2",
      guestToken: "guest-1",
      trackId: "prog-1",
      source: "search",
      requestedAtSec: 5,
      status: "received",
    });
    await flush();
    await flush();

    expect(bridge.partySetRequestStatus).toHaveBeenCalledWith({
      requestId: "req-2",
      status: "not tonight",
    });
  });

  it("still resolves tonight's queue requests, labelled as tonight's", async () => {
    const queueTrack = {
      id: "queue-1",
      title: "Queue Song",
      artists: "Queue Artist",
      coverUrl: "",
      durationMs: 180_000,
      playCount: 0,
    };
    usePlayerStore.setState({
      queue: [queueTrack as never],
      currentIndex: -1,
      currentTrack: null,
    });
    expect(await partyHost.start()).toBe(true);

    fakeSession.submitLiveRaveRequest.mockResolvedValue({
      id: "req-3",
      track: { trackId: "queue-1" },
    } as never);
    bridge.requestHandler?.({
      requestId: "req-3",
      guestToken: "guest-1",
      trackId: "queue-1",
      source: "tonight",
      requestedAtSec: 10,
      status: "received",
    });
    await flush();
    await flush();

    expect(fakeSession.submitLiveRaveRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        track: expect.objectContaining({ id: "queue-1" }),
      }),
    );
    const feedItem = usePartyStore
      .getState()
      .feed.find((item) => item.recordId === "req-3");
    expect(feedItem).toMatchObject({ source: "tonight" });
  });
});
