import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis } from "./analyseTrack";
import { DjBrain } from "./brain";
import { createJoinHistory, type JoinLogStorage } from "./joinHistory";
import type { TransitionRecipe } from "./recipe";
import type { PreparedTrack } from "./trackSource";

// Note 21's pins: the silent wedge — a song ends, the display
// keeps counting past its length, nothing advances and nothing
// ends. The traced path: the end-of-track floor's latch reset
// lived only in its walk's fulfilment handler, so a REJECTED
// walk (an exception escaping preparation — e.g. the walk
// indexing a queue that curation had just replaced with a
// shorter one) latched the floor forever while positionNow kept
// integrating and the tick wrote the overrun to the store
// unclamped. Same harness style as the v2/Note 20 suites — fake
// audio clock, scripted track source, fake two-deck mixer — plus
// a player-store fake that records every position it is shown.

const clock = vi.hoisted(() => ({ now: 0 }));

const loadMock = vi.hoisted(() => ({
  fn: vi.fn<(track: Track) => Promise<PreparedTrack | null>>(),
}));

const sourceCache = vi.hoisted(() => ({
  map: new Map<string, PreparedTrack>(),
}));

const performMock = vi.hoisted(() => ({
  recipes: [] as TransitionRecipe[],
}));

const toastMock = vi.hoisted(() => ({
  fn: vi.fn(),
}));

vi.mock("@/shared/ui/Toast", () => ({
  showToast: toastMock.fn,
}));

vi.mock("./trackSource", () => ({
  loadTrackForMixing: (track: Track) =>
    loadMock.fn(track).then((prepared) => {
      if (prepared) sourceCache.map.set(track.id, prepared);
      return prepared;
    }),
  preparedTrack: (trackId: string) => sourceCache.map.get(trackId),
  loadStretchRendition: async () => null,
  stretchRendition: () => undefined,
}));

vi.mock("./twoDeckMixer", () => ({
  TwoDeckMixer: class {
    currentDeckIndex = 0;
    master = { gain: { value: 1 } };
    playNow = vi.fn(() => clock.now);
    stopAll = vi.fn();
    transitionTo = vi.fn(
      (
        _buffer: unknown,
        plan: { startsInSec: number; blendDurationSec: number },
      ) => ({
        blendStartCtxTime: clock.now + plan.startsInSec,
        blendEndCtxTime: clock.now + plan.startsInSec + plan.blendDurationSec,
      }),
    );
    performRecipe = vi.fn((_buffer: unknown, recipe: TransitionRecipe) => {
      performMock.recipes.push(recipe);
      const blendStartCtxTime = clock.now + Math.max(0.1, recipe.leadInSec);
      return {
        blendStartCtxTime,
        blendEndCtxTime: blendStartCtxTime + recipe.overlap.durationMs / 1000,
      };
    });
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
    position: 0,
    maxPosition: 0,
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
    setPosition: vi.fn((ms: number) => {
      state.position = ms;
      state.maxPosition = Math.max(state.maxPosition, ms);
    }),
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

function makeTrack(id: string, durationMs = 30_000): Track {
  return {
    id,
    title: id,
    artists: "Test Artist",
    durationMs,
  } as unknown as Track;
}

function plainAnalysis(durationSec = 30): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec },
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
    analysis: plainAnalysis(durationSec),
    mixable: true,
  };
}

function fakeJoinStorage(): JoinLogStorage {
  return { read: async () => null, write: async () => {} };
}

async function flushMicrotasks(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function tickOnce(): Promise<void> {
  vi.advanceTimersByTime(250);
  await flushMicrotasks();
}

/** A load that hangs until the test settles it, shared by every ask for its track. */
function hangingLoads() {
  const deferreds = new Map<
    string,
    {
      promise: Promise<PreparedTrack | null>;
      resolve: (prepared: PreparedTrack | null) => void;
      reject: (error: unknown) => void;
    }
  >();
  return {
    forTrack(track: Track): Promise<PreparedTrack | null> {
      let deferred = deferreds.get(track.id);
      if (!deferred) {
        let resolveFn!: (prepared: PreparedTrack | null) => void;
        let rejectFn!: (error: unknown) => void;
        const promise = new Promise<PreparedTrack | null>((resolve, reject) => {
          resolveFn = resolve;
          rejectFn = reject;
        });
        deferred = { promise, resolve: resolveFn, reject: rejectFn };
        deferreds.set(track.id, deferred);
      }
      return deferred.promise;
    },
    get(id: string) {
      return deferreds.get(id);
    },
  };
}

describe("DjSession — Note 21 (the silent wedge)", () => {
  let session: DjSession;

  beforeEach(() => {
    vi.useFakeTimers();
    clock.now = 0;
    loadMock.fn.mockReset();
    performMock.recipes.length = 0;
    sourceCache.map.clear();
    toastMock.fn.mockReset();
    store.state.status = "idle";
    store.state.currentTrack = null;
    store.state.currentIndex = -1;
    store.state.queue = [];
    store.state.position = 0;
    store.state.maxPosition = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    session = new DjSession(
      new DjBrain({ history: createJoinHistory(fakeJoinStorage()) }),
    );
  });

  afterEach(() => {
    session.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a rejecting preparation inside the end-advance walk does not latch the session — it recovers, and the next end still ends honestly", async () => {
    const a = makeTrack("a", 4_000);
    const b = makeTrack("b");
    const c = makeTrack("c", 4_000);
    const hanging = hangingLoads();
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "a") return Promise.resolve(makePrepared(track, 4));
      return hanging.forTrack(track);
    });
    await session.start([a, b, c]);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("a");
    // The horizon's walks are parked on the hanging b and c loads;
    // neither slot holds anything.

    // a ends: the tick takes the end-of-track floor, whose own
    // walk parks on the same hanging b load.
    clock.now = 4.5;
    await tickOnce();
    expect(store.state.currentTrack?.id).toBe("a");
    expect(session.isRunning).toBe(true);

    // THE FIELD FAILURE, injected: the preparation REJECTS inside
    // the end-advance walk. Under the old code the walk's promise
    // rejected, the latch's only reset (in the fulfilment handler)
    // never ran, and the set wedged here forever.
    hanging.get("b")?.reject(new Error("network exploded mid-walk"));
    await flushMicrotasks();
    hanging.get("c")?.resolve(makePrepared(c, 4));
    await flushMicrotasks();

    // The walk treated the rejection as a failed preparation,
    // marked b, moved on, and landed c through the counted floor.
    expect(session.isRunning).toBe(true);
    expect(session.endReason).toBeNull();
    expect(store.state.currentTrack?.id).toBe("c");
    expect(session.plainCutCount).toBeGreaterThanOrEqual(1);

    // And the latch is free for the NEXT end: c plays out, nothing
    // is left, and the set ends honestly with its reason and its
    // toast — the exact ending the wedge used to swallow.
    clock.now = 10;
    await tickOnce();
    await flushMicrotasks();
    expect(session.isRunning).toBe(false);
    expect(session.endReason).toBe("queue-exhausted");
    expect(toastMock.fn).toHaveBeenCalled();
  });

  it("the watchdog fires on an overrun past the margin, forces the floor, and fires only once per track", async () => {
    const a = makeTrack("a", 4_000);
    const b = makeTrack("b");
    const hanging = hangingLoads();
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "a") return Promise.resolve(makePrepared(track, 4));
      return hanging.forTrack(track);
    });
    await session.start([a, b]);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("a");

    // a ends; the floor's walk parks on the hanging b load and the
    // latch is held. Inside the margin, nothing rescues yet.
    clock.now = 4.5;
    await tickOnce();
    clock.now = 5.5;
    await tickOnce();
    expect(session.plainCutCount).toBe(0);
    expect(store.state.currentTrack?.id).toBe("a");

    // Past the 2 s margin with the latch still held, the watchdog
    // presumes the walk dead: it clears the latch, counts the
    // rescue, and forces the floor again (a second walk parks on
    // the same hanging load).
    clock.now = 6.5;
    await tickOnce();
    expect(session.plainCutCount).toBe(1);
    expect(store.state.currentTrack?.id).toBe("a");
    expect(session.isRunning).toBe(true);

    // Once per track: further overrun ticks do not rescue again.
    clock.now = 7.5;
    await tickOnce();
    clock.now = 8.5;
    await tickOnce();
    expect(session.plainCutCount).toBe(1);

    // When the load finally lands, a waiting walk lands b through
    // the counted floor — the set recovered instead of wedging.
    hanging.get("b")?.resolve(makePrepared(b));
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("b");
    expect(session.isRunning).toBe(true);
    expect(session.endReason).toBeNull();
    expect(session.plainCutCount).toBe(2);
  });

  it("the store position never exceeds the current track's duration while the floor recovers", async () => {
    const a = makeTrack("a", 4_000);
    const b = makeTrack("b");
    const hanging = hangingLoads();
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "a") return Promise.resolve(makePrepared(track, 4));
      return hanging.forTrack(track);
    });
    await session.start([a, b]);
    await flushMicrotasks();

    // The song is over and the floor is parked on the hanging
    // load; the session's clock keeps counting (that is what a
    // clock does), but the store — what the interface shows — must
    // sit at the end of the song, never past it.
    clock.now = 5;
    await tickOnce();
    clock.now = 6;
    await tickOnce();
    clock.now = 7.5;
    await tickOnce();
    expect(store.state.maxPosition).toBeLessThanOrEqual(4_000);
    expect(store.state.position).toBe(4_000);
    expect(store.state.currentTrack?.id).toBe("a");

    // Recovery still works from the clamped state.
    hanging.get("b")?.resolve(makePrepared(b));
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("b");
  });
});
