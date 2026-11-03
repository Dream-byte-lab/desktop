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

import { partyHost } from "./partyHost";
import { useDjModeStore } from "../store/djModeStore";
import { usePartyStore } from "../store/partyStore";

type ReactionHandler = (reaction: {
  guestToken: string;
  kind: string;
  atMs: number;
}) => void;

function makeBridge() {
  const bridge = {
    reactionHandler: null as ReactionHandler | null,
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
    onPartyRequest: vi.fn(() => () => {}),
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
  useDjModeStore.setState({ active: true });
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
