import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis } from "./analyseTrack";
import { DjBrain } from "./brain";
import { createJoinHistory, type JoinLogStorage } from "./joinHistory";
import type { TransitionRecipe } from "./recipe";
import type { PreparedTrack } from "./trackSource";

// Note 20's session-level pins: the playable/mixable split (a shell
// is PLAYED through the floor, never skipped), the two-track
// preparation horizon (concurrent walks, promotion without
// re-preparing), and failure backoff instead of the old permanent
// 3-strike burial. Same harness style as the v2 suite — fake audio
// clock, scripted track source, fake two-deck mixer.

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

function makePrepared(
  track: Track,
  durationSec = 30,
  mixable = true,
): PreparedTrack {
  return {
    track,
    buffer: { duration: durationSec } as unknown as AudioBuffer,
    analysis: plainAnalysis(durationSec),
    mixable,
  };
}

function fakeJoinStorage(): JoinLogStorage {
  return { read: async () => null, write: async () => {} };
}

async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function tickOnce(): Promise<void> {
  vi.advanceTimersByTime(250);
  await flushMicrotasks();
}

describe("DjSession — Note 20", () => {
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

  function loadsOf(id: string): number {
    return loadMock.fn.mock.calls.filter(([track]) => track.id === id).length;
  }

  it("plays an analysis-failing (shell) track plainly through the floor instead of skipping or ending", async () => {
    const a = makeTrack("a", 4_000);
    const shell = makeTrack("shell");
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(
        track.id === "a"
          ? makePrepared(track, 4)
          : makePrepared(track, 30, false),
      ),
    );
    await session.start([a, shell]);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("a");

    // Inside the consider window the shell pair is never blended.
    clock.now = 3;
    await tickOnce();
    expect(performMock.recipes).toHaveLength(0);

    // At the track end the floor lands the shell with a plain cut:
    // counted, and the session lives on on the shell track.
    clock.now = 5;
    await tickOnce();
    expect(session.isRunning).toBe(true);
    expect(store.state.currentTrack?.id).toBe("shell");
    expect(store.state.currentIndex).toBe(1);
    expect(session.plainCutCount).toBe(1);
    expect(session.endReason).toBeNull();
  });

  it("prepares the two upcoming candidates concurrently and lands the second by promotion, without re-preparing it", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    const c = makeTrack("c");
    const deferreds = new Map<
      string,
      { resolve: (prepared: PreparedTrack | null) => void }
    >();
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "a") return Promise.resolve(makePrepared(track));
      let deferred = deferreds.get(track.id);
      if (!deferred) {
        let resolveFn!: (prepared: PreparedTrack | null) => void;
        const promise = new Promise<PreparedTrack | null>((resolve) => {
          resolveFn = resolve;
        });
        deferred = { resolve: resolveFn };
        deferreds.set(track.id, deferred);
        return promise;
      }
      // A second ask for the same track would be a re-preparation;
      // the loadsOf counts below catch it.
      return Promise.resolve(makePrepared(track));
    });

    await session.start([a, b, c]);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("a");
    // Both horizon walks are in flight before either has resolved:
    // b's load was called AND c's load was called while both
    // promises were still pending.
    expect(loadsOf("b")).toBe(1);
    expect(loadsOf("c")).toBe(1);

    deferreds.get("b")?.resolve(makePrepared(b));
    deferreds.get("c")?.resolve(makePrepared(c));
    await flushMicrotasks();

    session.skipNext();
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("b");

    // Landing b promoted the already-prepared c into the next slot:
    // the skip to c spends no new preparation on it.
    session.skipNext();
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("c");
    expect(loadsOf("c")).toBe(1);
  });

  it("retries a track failed three times once its backoff has elapsed — backoff, not burial", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    let bFails = true;
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "b") {
        return Promise.resolve(bFails ? null : makePrepared(track));
      }
      return Promise.resolve(makePrepared(track));
    });
    await session.start([a, b]);
    await flushMicrotasks();
    // The horizon's first attempt on b failed and marked it.
    expect(loadsOf("b")).toBe(1);
    expect(store.state.currentTrack?.id).toBe("a");

    // Attempt 2, after the first mark's 30 s window.
    vi.setSystemTime(Date.now() + 31_000);
    session.skipNext();
    await flushMicrotasks();
    expect(loadsOf("b")).toBe(2);
    expect(store.state.currentTrack?.id).toBe("a");

    // Attempt 3, after the grown 60 s window. Under the old rule
    // this third strike buried b for the rest of the session.
    vi.setSystemTime(Date.now() + 61_000);
    session.skipNext();
    await flushMicrotasks();
    expect(loadsOf("b")).toBe(3);
    expect(store.state.currentTrack?.id).toBe("a");

    // The third mark's window is 90 s (30 s × 3 attempts): still
    // blocked part-way through it...
    vi.setSystemTime(Date.now() + 31_000);
    session.skipNext();
    await flushMicrotasks();
    expect(loadsOf("b")).toBe(3);
    expect(store.state.currentTrack?.id).toBe("a");

    // ...and eligible again once it elapses. The track plays.
    bFails = false;
    vi.setSystemTime(Date.now() + 60_000);
    session.skipNext();
    await flushMicrotasks();
    expect(loadsOf("b")).toBe(4);
    expect(store.state.currentTrack?.id).toBe("b");
    expect(session.isRunning).toBe(true);
  });
});
