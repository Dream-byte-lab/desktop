import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { DjSessionEndReason } from "../engine/djSession";

// The intent wiring's state machine, driven against a fake session
// and an injected player state (the deps seam), plus the DJ-mode
// store's intent persistence. The real djSession module is mocked
// out: the wiring factory under test never touches the singleton.

vi.mock("../engine/djSession", () => ({
  djSession: {
    isRunning: false,
    endReason: null,
    onRunningChange: null,
    start: vi.fn(async () => {}),
  },
}));

import {
  createDjIntentWiring,
  type DjIntentSession,
  type DjIntentWiring,
} from "./djIntentWiring";
import {
  DJ_INTENT_KEY,
  readPersistedDjIntent,
  useDjModeStore,
} from "./djModeStore";

function makeTrack(id: string): Track {
  return { id, title: id, artists: "Test Artist" } as unknown as Track;
}

interface Harness {
  wiring: DjIntentWiring;
  session: DjIntentSession & {
    start: ReturnType<typeof vi.fn>;
  };
  activeMirror: boolean[];
  setIntent: (intent: boolean) => void;
  getIntent: () => boolean;
  /** Replace the player state wholesale and fire a player change. */
  movePlayer: (queue: Track[], currentIndex: number) => void;
  /** Fire a player change with the state untouched. */
  pokePlayer: () => void;
  /** Simulate the session ending for the given reason. */
  endSession: (reason: DjSessionEndReason) => void;
}

function makeHarness(initialIntent = true): Harness {
  let intent = initialIntent;
  const intentListeners = new Set<() => void>();
  const playerListeners = new Set<() => void>();
  const queueA = [makeTrack("a1"), makeTrack("a2")];
  const playerState: {
    queue: Track[];
    currentTrack: Track | null;
    currentIndex: number;
  } = { queue: queueA, currentTrack: queueA[0], currentIndex: 0 };

  const sessionState: {
    running: boolean;
    reason: DjSessionEndReason | null;
  } = { running: false, reason: null };
  const session: Harness["session"] = {
    get isRunning() {
      return sessionState.running;
    },
    get endReason() {
      return sessionState.reason;
    },
    onRunningChange: null,
    start: vi.fn(async () => {}),
  };
  const activeMirror: boolean[] = [];

  const wiring = createDjIntentWiring({
    session,
    getIntent: () => intent,
    subscribeIntent: (listener) => {
      intentListeners.add(listener);
      return () => intentListeners.delete(listener);
    },
    getPlayerState: () => playerState,
    subscribePlayer: (listener) => {
      playerListeners.add(listener);
      return () => playerListeners.delete(listener);
    },
    setActive: (running) => activeMirror.push(running),
  });

  return {
    wiring,
    session,
    activeMirror,
    setIntent: (next) => {
      intent = next;
      for (const listener of intentListeners) listener();
    },
    getIntent: () => intent,
    movePlayer: (queue, currentIndex) => {
      playerState.queue = queue;
      playerState.currentIndex = currentIndex;
      playerState.currentTrack = queue[currentIndex] ?? null;
      for (const listener of playerListeners) listener();
    },
    pokePlayer: () => {
      for (const listener of playerListeners) listener();
    },
    endSession: (reason) => {
      sessionState.running = false;
      sessionState.reason = reason;
      session.onRunningChange?.(false);
    },
  };
}

describe("djIntentWiring — the auto-resume machine", () => {
  it("mirrors running state into `active` on every running change", () => {
    const h = makeHarness();
    h.session.onRunningChange?.(true);
    h.endSession("queue-exhausted");
    expect(h.activeMirror).toEqual([true, false]);
  });

  it("intent survives a queue-exhausted end and re-engages on a NEW queue signature without a press", () => {
    const h = makeHarness();
    h.endSession("queue-exhausted");
    expect(h.wiring.armed).toBe(true);
    expect(h.session.start).not.toHaveBeenCalled();

    const queueB = [makeTrack("b1"), makeTrack("b2")];
    h.movePlayer(queueB, 1);
    expect(h.session.start).toHaveBeenCalledTimes(1);
    expect(h.session.start).toHaveBeenCalledWith(queueB, 1);
  });

  it("does not engage for the SAME signature it armed on", () => {
    const h = makeHarness();
    h.endSession("queue-exhausted");
    h.pokePlayer();
    h.pokePlayer();
    expect(h.session.start).not.toHaveBeenCalled();
  });

  it("a user-stop never resumes, however the queue changes afterwards", () => {
    const h = makeHarness();
    h.endSession("user-stop");
    expect(h.wiring.armed).toBe(false);
    h.movePlayer([makeTrack("b1")], 0);
    h.movePlayer([makeTrack("c1")], 0);
    expect(h.session.start).not.toHaveBeenCalled();
  });

  it("a replaced end never resumes either", () => {
    const h = makeHarness();
    h.endSession("replaced");
    h.movePlayer([makeTrack("b1")], 0);
    expect(h.session.start).not.toHaveBeenCalled();
  });

  it("a deliberate stop after a qualifying end disarms the resume", () => {
    const h = makeHarness();
    h.endSession("queue-exhausted");
    expect(h.wiring.armed).toBe(true);
    h.wiring.noteDeliberateStop();
    expect(h.wiring.armed).toBe(false);
    h.movePlayer([makeTrack("b1")], 0);
    expect(h.session.start).not.toHaveBeenCalled();
  });

  it("intent off means no resume, even after a qualifying end", () => {
    const h = makeHarness();
    h.endSession("start-no-playable");
    expect(h.wiring.armed).toBe(true);
    h.setIntent(false);
    expect(h.wiring.armed).toBe(false);
    h.movePlayer([makeTrack("b1")], 0);
    expect(h.session.start).not.toHaveBeenCalled();

    // And an end that arrives while intent is already off never arms.
    const off = makeHarness(false);
    off.endSession("queue-exhausted");
    expect(off.wiring.armed).toBe(false);
    off.movePlayer([makeTrack("b1")], 0);
    expect(off.session.start).not.toHaveBeenCalled();
  });

  it("a resume that ends start-no-playable does not retry the same signature, but does retry a new one", () => {
    const h = makeHarness();
    h.endSession("queue-exhausted");

    const queueB = [makeTrack("b1"), makeTrack("b2")];
    h.movePlayer(queueB, 0);
    expect(h.session.start).toHaveBeenCalledTimes(1);

    // The resume attempt itself finds nothing playable. Its end
    // re-arms on the attempted signature...
    h.endSession("start-no-playable");
    expect(h.wiring.armed).toBe(true);
    // ...so the same signature is never retried (no hot loop)...
    h.pokePlayer();
    h.movePlayer(queueB, 0);
    expect(h.session.start).toHaveBeenCalledTimes(1);
    // ...while a genuinely new signature is a new chance.
    const queueC = [makeTrack("c1")];
    h.movePlayer(queueC, 0);
    expect(h.session.start).toHaveBeenCalledTimes(2);
    expect(h.session.start).toHaveBeenLastCalledWith(queueC, 0);
  });

  it("does not resume onto an empty queue or with no current track", () => {
    const h = makeHarness();
    h.endSession("queue-exhausted");
    h.movePlayer([], -1);
    expect(h.session.start).not.toHaveBeenCalled();
  });
});

describe("djModeStore — intent persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useDjModeStore.setState({ intent: false, active: false });
  });

  it("setIntent writes the persisted key, and clearing removes it", () => {
    useDjModeStore.getState().setIntent(true);
    expect(useDjModeStore.getState().intent).toBe(true);
    expect(localStorage.getItem(DJ_INTENT_KEY)).toBe("1");

    useDjModeStore.getState().setIntent(false);
    expect(useDjModeStore.getState().intent).toBe(false);
    expect(localStorage.getItem(DJ_INTENT_KEY)).toBeNull();
  });

  it("the read helper returns the persisted value", () => {
    expect(readPersistedDjIntent()).toBe(false);
    localStorage.setItem(DJ_INTENT_KEY, "1");
    expect(readPersistedDjIntent()).toBe(true);
    localStorage.removeItem(DJ_INTENT_KEY);
    expect(readPersistedDjIntent()).toBe(false);
  });
});
