import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis } from "./analyseTrack";
import type { PreparedTrack } from "./trackSource";
import type { TransitionPlan } from "./transitionPlanner";

// The DJ session, driven end to end with a fake audio clock, a fake
// two-deck mixer and a scripted track source. The scenarios are the
// ones the Note 7 investigation proved fatal: the next track cannot
// be prepared, or its preparation merely finishes late — either used
// to end the whole session at the end of the current song. Now they
// must not.

const clock = vi.hoisted(() => ({ now: 0 }));

const loadMock = vi.hoisted(() => ({
  fn: vi.fn<(track: Track) => Promise<PreparedTrack | null>>(),
}));

vi.mock("./trackSource", () => ({
  loadTrackForMixing: loadMock.fn,
  preparedTrack: vi.fn(() => undefined),
}));

vi.mock("./twoDeckMixer", () => ({
  TwoDeckMixer: class {
    currentDeckIndex = 0;
    master = { gain: { value: 1 } };
    playNow = vi.fn(() => clock.now);
    stopAll = vi.fn();
    transitionTo = vi.fn((_buffer: unknown, plan: TransitionPlan) => ({
      blendStartCtxTime: clock.now + plan.startsInSec,
      blendEndCtxTime: clock.now + plan.startsInSec + plan.blendDurationSec,
    }));
    echoOutCurrent = vi.fn();
    setCrossfade = vi.fn();
    setDeckTrim = vi.fn();
    setDeckBassCut = vi.fn();
  },
}));

const store = vi.hoisted(() => {
  const state = {
    volume: 0.8,
    status: "idle" as string,
    currentTrack: null as Track | null,
    currentIndex: -1,
    queue: [] as Track[],
    dispatch: vi.fn(),
    setQueue: vi.fn((queue: Track[]) => {
      state.queue = queue;
    }),
    setStatus: vi.fn((status: string) => {
      state.status = status;
    }),
    setCurrentTrack: vi.fn((track: Track, index: number) => {
      state.currentTrack = track;
      state.currentIndex = index;
    }),
    setDuration: vi.fn(),
    setPosition: vi.fn(),
  };
  return { state };
});

vi.mock("../../player/store/playerStore", () => ({
  usePlayerStore: { getState: () => store.state },
}));

class FakeAudioContext {
  state = "running";
  get currentTime(): number {
    return clock.now;
  }
  close = vi.fn(() => Promise.resolve());
  suspend = vi.fn(() => Promise.resolve());
  resume = vi.fn(() => Promise.resolve());
}

import { DjSession } from "./djSession";

function makeTrack(id: string): Track {
  return {
    id,
    title: id,
    artists: "Test Artist",
    durationMs: 30_000,
  } as unknown as Track;
}

function fakeAnalysis(): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 30 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: null,
    vocalRanges: [],
    loudness: 0.4,
  };
}

function makePrepared(track: Track, durationSec = 30): PreparedTrack {
  return {
    track,
    buffer: { duration: durationSec } as unknown as AudioBuffer,
    analysis: fakeAnalysis(),
  };
}

/** Lets pending promise chains (preparation walks) settle. */
async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** Fires the session's 250 ms tick once, then settles promises it started. */
async function tickOnce(): Promise<void> {
  vi.advanceTimersByTime(250);
  await flushMicrotasks();
}

describe("DjSession resilience — a dead or late next track must not end the session", () => {
  let session: DjSession;
  const trackA = makeTrack("a");
  const trackB = makeTrack("b");
  const trackC = makeTrack("c");
  const preparedA = makePrepared(trackA);
  const preparedB = makePrepared(trackB);
  const preparedC = makePrepared(trackC);

  beforeEach(() => {
    vi.useFakeTimers();
    clock.now = 0;
    loadMock.fn.mockReset();
    store.state.status = "idle";
    store.state.currentTrack = null;
    store.state.currentIndex = -1;
    store.state.queue = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    session = new DjSession();
  });

  afterEach(() => {
    session.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function loadsById(map: Map<string, PreparedTrack | null>): void {
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(map.get(track.id) ?? null),
    );
  }

  it("walks past an unpreparable next track and cuts to the one after it at track end", async () => {
    loadsById(
      new Map([
        ["a", preparedA],
        ["b", null],
        ["c", preparedC],
      ]),
    );
    await session.start([trackA, trackB, trackC]);
    await flushMicrotasks();
    expect(session.isRunning).toBe(true);
    expect(store.state.currentTrack?.id).toBe("a");

    clock.now = 31; // past the end of the 30 s track
    await tickOnce();

    expect(session.isRunning).toBe(true);
    expect(store.state.currentTrack?.id).toBe("c");
    expect(store.state.currentIndex).toBe(2);
  });

  it("ends the session only when nothing playable remains in the queue", async () => {
    loadsById(
      new Map([
        ["a", preparedA],
        ["b", null],
      ]),
    );
    await session.start([trackA, trackB]);
    await flushMicrotasks();

    clock.now = 31;
    await tickOnce();

    expect(session.isRunning).toBe(false);
    expect(store.state.status).toBe("idle");
  });

  it("survives a preparation that merely finishes late", async () => {
    let resolveB: ((value: PreparedTrack | null) => void) | undefined;
    const lateB = new Promise<PreparedTrack | null>((resolve) => {
      resolveB = resolve;
    });
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "a") return Promise.resolve(preparedA);
      return lateB; // every later ask rides the same in-flight load
    });
    await session.start([trackA, trackB]);
    await flushMicrotasks();
    expect(session.isRunning).toBe(true);

    clock.now = 31; // track A ends while B is still preparing
    await tickOnce();
    expect(session.isRunning).toBe(true); // waiting, not dead

    resolveB?.(preparedB);
    await flushMicrotasks();

    expect(session.isRunning).toBe(true);
    expect(store.state.currentTrack?.id).toBe("b");
    expect(store.state.currentIndex).toBe(1);
  });

  it("does not retry a track that already failed preparation", async () => {
    loadsById(
      new Map([
        ["a", preparedA],
        ["b", null],
        ["c", preparedC],
      ]),
    );
    await session.start([trackA, trackB, trackC]);
    await flushMicrotasks();
    const bLoads = () =>
      loadMock.fn.mock.calls.filter(([track]) => track.id === "b").length;
    expect(bLoads()).toBe(1);

    clock.now = 31;
    await tickOnce();
    expect(store.state.currentTrack?.id).toBe("c");
    expect(bLoads()).toBe(1); // the dead track was paid for once
  });

  it("skipNext lands on the walked-to track, at its real queue index", async () => {
    loadsById(
      new Map([
        ["a", preparedA],
        ["b", null],
        ["c", preparedC],
      ]),
    );
    await session.start([trackA, trackB, trackC]);
    await flushMicrotasks();

    session.skipNext();

    expect(session.isRunning).toBe(true);
    expect(store.state.currentTrack?.id).toBe("c");
    expect(store.state.currentIndex).toBe(2);
  });

  it("a blend lands on the walked-to track's index, not the neighbour's", async () => {
    const longA = makePrepared(trackA, 3600);
    const longC = makePrepared(trackC, 3600);
    loadsById(
      new Map<string, PreparedTrack | null>([
        ["a", longA],
        ["b", null],
        ["c", longC],
      ]),
    );
    await session.start([trackA, trackB, trackC]);
    await flushMicrotasks();

    const plan: TransitionPlan = {
      blendBeats: 16,
      startsInSec: 0,
      blendDurationSec: 8,
      outgoingExitBeat: 0,
      outgoingEndBeat: 16,
      incomingStartSec: 0,
      incomingEntryBeat: 0,
      incomingRate: 1,
      tempoStretch: 0,
      tempoComfortable: true,
      bassSwapBeatOffset: 8,
      bassSwapInSec: 4,
      rateReturnDurationSec: 2,
      keyCompatibility: null,
      vocalOverlap: false,
    };
    const internals = session as unknown as {
      executeTransition: (plan: TransitionPlan) => void;
    };
    internals.executeTransition(plan);
    vi.advanceTimersByTime(8_000);
    await flushMicrotasks();

    expect(session.isRunning).toBe(true);
    expect(store.state.currentTrack?.id).toBe("c");
    expect(store.state.currentIndex).toBe(2);
  });
});
