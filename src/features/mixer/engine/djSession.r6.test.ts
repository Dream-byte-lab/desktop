import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { DjBrain } from "./brain";
import { createJoinHistory, type JoinLogStorage } from "./joinHistory";
import type { TransitionRecipe } from "./recipe";
import type { PreparedTrack } from "./trackSource";

// R6's session pins, in the Note 20/21 harness style (fake audio
// clock, scripted track source, fake two-deck mixer extended
// with the loop and stage surface):
//   · the track choice — the horizon prepares the track the
//     brain chose from the known prefix of the tail (scope 1);
//   · §3's second validation — a horizon track invalidated after
//     preparation is excluded at the deck door and the set
//     continues to the following track (also Note 24's named
//     acceptance case: no stop while a playable track remains);
//   · §34 resume-inspection — a stage grab on healthy state
//     leaves a standing decision intact; a stale horizon slot is
//     dropped and its decision cancelled before planning;
//   · the minimum-play floor (Note 19, ruling 1) end to end —
//     the performed join anchors at or after the first big
//     section's end, and a user's skip overrides it instantly;
//   · loop-to-buy-time (ruling 2) — the loop arms at the
//     boundary, the playhead wraps musically, the bound lets go
//     and the standing floor applies; a failure-blocked tail is
//     worth outwaiting (Note 24);
//   · Note 24's discarded floor walk — a queue rebuild under the
//     end-of-track walk re-runs the floor instead of ending the
//     set as "exhausted".

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

const loopMock = vi.hoisted(() => ({
  calls: [] as { startSec: number; endSec: number }[],
  clears: 0,
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
    setDeckEq = vi.fn();
    setDeckFilter = vi.fn();
    setCrossfaderCurve = vi.fn();
    setManualFxAssign = vi.fn();
    setManualFxSend = vi.fn();
    loopCurrentDeck = vi.fn((startSec: number, endSec: number) => {
      loopMock.calls.push({ startSec, endSec });
    });
    clearCurrentDeckLoop = vi.fn(() => {
      loopMock.clears += 1;
    });
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

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

function makeTrack(id: string, durationMs = 30_000): Track {
  return {
    id,
    title: id,
    artists: "Test Artist",
    durationMs,
  } as unknown as Track;
}

function key(camelot: string, pitchClass: number): KeyEstimate {
  return { tonic: "C", mode: "major", pitchClass, camelot, confidence: 0.9 };
}

function vocalCurve(
  durationSec: number,
  activityAt: (t: number) => number,
): VocalActivityCurve {
  const points = [];
  for (let t = 0; t < durationSec; t += 0.25) {
    points.push({ timeSec: t, activity: activityAt(t), confidence: 1 });
  }
  return { windowSec: 0.25, stepSec: 0.25, points };
}

function section(
  kind: TrackSection["kind"],
  startSec: number,
  endSec: number,
  meanRms: number,
  vocalActivity: number,
): TrackSection {
  return {
    kind,
    startSec,
    endSec,
    startBeat: startSec * 2,
    endBeat: endSec * 2,
    meanRms,
    vocalActivity,
    confidence: 0.9,
  };
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

/** A plain analysis plus a beat grid — loopable, but not blendable. */
function griddedPlainAnalysis(durationSec = 30): TrackAnalysis {
  const anchors = [];
  for (let t = 0; t <= durationSec; t += 0.5) {
    anchors.push({ beat: t / 0.5, timeSec: t, confidence: 0.9 });
  }
  const analysis = plainAnalysis(durationSec);
  analysis.beatMap.grid = {
    anchors,
    sections: [
      {
        startBeat: 0,
        endBeat: durationSec / 0.5,
        bpm: 120,
        confidence: 0.9,
      },
    ],
    confidence: 0.9,
  };
  return analysis;
}

function makePrepared(
  track: Track,
  durationSec = 30,
  analysis?: TrackAnalysis,
): PreparedTrack {
  return {
    track,
    buffer: { duration: durationSec } as unknown as AudioBuffer,
    analysis: analysis ?? plainAnalysis(durationSec),
    mixable: true,
  };
}

/** A rich 120 s outgoing whose first chorus ends at 90 — floor 90. */
function richOutgoing120(hash = "hash-ra"): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 120 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: hash,
    sections: [
      section("intro", 0, 10, 0.15, 0),
      section("verse", 10, 40, 0.3, 0.85),
      section("chorus", 40, 90, 0.5, 0.9),
      section("verse", 90, 110, 0.3, 0.85),
      section("outro", 110, 120, 0.1, 0),
    ],
    outro: { startSec: 110, endSec: 120, startBeat: 220, endBeat: 240 },
    vocalActivity: vocalCurve(120, (t) => (t < 10 ? 0 : t < 110 ? 0.9 : 0)),
  };
}

/** A rich 120 s incoming, the friendly pair's other half. */
function richIncoming120(hash = "hash-rb"): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 120 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [{ timeSec: 16, beat: 32, strength: 2.4 }],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: hash,
    sections: [
      section("intro", 0, 8, 0.15, 0),
      section("chorus", 8, 32, 0.5, 0.9),
      section("verse", 32, 80, 0.3, 0.85),
      section("chorus", 80, 120, 0.5, 0.9),
    ],
    intro: { startSec: 0, endSec: 8, startBeat: 0, endBeat: 16 },
    vocalActivity: vocalCurve(120, (t) => (t < 8 ? 0 : 0.9)),
  };
}

/** The v2 suite's rich 240 s pair, for the §34 decision phases. */
function richOutgoing240(outroStartSec = 200, hash = "hash-a"): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: hash,
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("verse", 16, 64, 0.3, 0.85),
      section("chorus", 64, 112, 0.5, 0.9),
      section("verse", 112, outroStartSec, 0.3, 0.85),
      section("outro", outroStartSec, 240, 0.1, 0),
    ],
    outro: {
      startSec: outroStartSec,
      endSec: 240,
      startBeat: outroStartSec * 2,
      endBeat: 480,
    },
    vocalActivity: vocalCurve(240, (t) =>
      t < 16 ? 0 : t < outroStartSec ? 0.9 : 0,
    ),
  };
}

function richIncoming240(hash = "hash-b"): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [{ timeSec: 32, beat: 64, strength: 2.4 }],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: hash,
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("chorus", 16, 64, 0.5, 0.9),
      section("verse", 64, 160, 0.3, 0.85),
      section("chorus", 160, 240, 0.5, 0.9),
    ],
    intro: { startSec: 0, endSec: 16, startBeat: 0, endBeat: 32 },
    vocalActivity: vocalCurve(240, (t) => (t < 16 ? 0 : 0.9)),
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

function loadsOf(id: string): number {
  return loadMock.fn.mock.calls.filter(([track]) => track.id === id).length;
}

// ---------------------------------------------------------------------

describe("DjSession — R6", () => {
  let session: DjSession;

  beforeEach(() => {
    vi.useFakeTimers();
    clock.now = 0;
    loadMock.fn.mockReset();
    performMock.recipes.length = 0;
    loopMock.calls.length = 0;
    loopMock.clears = 0;
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

  it("scope 1: the horizon prepares the track the brain chose from the known tail", async () => {
    const a = makeTrack("a", 60_000);
    const b = makeTrack("b", 60_000);
    const c = makeTrack("c", 60_000);
    const d = makeTrack("d", 60_000);
    const hanging = hangingLoads();
    // c and d are already in the analysis cache (prepared on an
    // earlier occasion); c's fresh load hangs, so the horizon's
    // second slot stays open — the landing where a choice spends.
    const songAnalysis = (rms: number, withIntro: boolean): TrackAnalysis => ({
      beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 60 },
      tempoConfidence: 0.9,
      energyCurve: [],
      drops: [],
      key: null,
      vocalRanges: [],
      loudness: 0.4,
      analysisVersion: 2,
      sections: [section("chorus", 0, 60, rms, 0)],
      ...(withIntro
        ? { intro: { startSec: 0, endSec: 16, startBeat: 0, endBeat: 32 } }
        : {}),
    });
    sourceCache.map.set("c", makePrepared(c, 60, songAnalysis(0.035, false)));
    sourceCache.map.set("d", makePrepared(d, 60, songAnalysis(0.2625, true)));
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "c") return hanging.forTrack(track);
      return Promise.resolve(
        makePrepared(
          track,
          60,
          track.id === "d" ? songAnalysis(0.2625, true) : undefined,
        ),
      );
    });
    await session.start([a, b, c, d]);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("a");

    // Land b: the first horizon slot opens, the brain scores the
    // known prefix [c, d] — d is the peak-shaped, clean-opening
    // track the arc wants here — and the tail is reordered so
    // the horizon prepares d, not the standing order's c.
    session.skipNext();
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("b");
    expect(session.lastTrackChoice?.trackId).toBe("d");
    expect(store.state.queue.map((track) => track.id)).toEqual([
      "a",
      "b",
      "d",
      "c",
    ]);

    // And the set actually plays the chosen track next.
    session.skipNext();
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("d");
  });

  it("§3 + Note 24: a horizon track invalidated after preparation is excluded at the door and the set continues", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    const c = makeTrack("c");
    let bBroken = false;
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "b" && bBroken) {
        return Promise.reject(new Error("b went away"));
      }
      return Promise.resolve(makePrepared(track));
    });
    await session.start([a, b, c]);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("a");
    expect((session as any).next?.track.id).toBe("b");

    // b was prepared into the horizon — then the world changed:
    // a guest request for b fails its preparation through the
    // session's own request path, laying a failure mark on b.
    bBroken = true;
    const refused = await session.submitLiveRaveRequest({
      id: "r1",
      guestId: "g1",
      track: b,
      requestedAtSec: 0,
    });
    expect(refused).toBeNull();

    // a ends. The standing next (b) no longer validates at the
    // deck door: it is excluded, the choice re-runs, and the set
    // continues to c — no dead deck, no stop, b never plays.
    clock.now = 30.2;
    await tickOnce();
    expect(store.state.currentTrack?.id).toBe("a");
    expect(session.plainCutCount).toBe(0);
    await tickOnce();
    expect(store.state.currentTrack?.id).toBe("c");
    expect(session.plainCutCount).toBe(1);
    expect(session.isRunning).toBe(true);
    expect(session.endReason).toBeNull();
  });

  it("§34: a stage grab on healthy state keeps the decision; a stale slot cancels it and planning recovers", async () => {
    const ra = makeTrack("ra", 240_000);
    const rb = makeTrack("rb", 240_000);
    const rc = makeTrack("rc", 240_000);
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "ra") {
        return Promise.resolve(makePrepared(ra, 240, richOutgoing240()));
      }
      if (track.id === "rb") {
        return Promise.resolve(makePrepared(rb, 240, richIncoming240()));
      }
      return Promise.resolve(makePrepared(rc, 240, richIncoming240("hash-c")));
    });
    await session.start([ra, rb, rc]);
    await flushMicrotasks();
    clock.now = 100; // inside the consider window
    await tickOnce();
    expect((session as any).decision).not.toBeNull();
    expect(performMock.recipes).toHaveLength(0);

    // A grab on healthy state: inspection runs, finds the decks
    // as planned, and the standing decision survives untouched.
    session.setDeckEq(0, "bass", -3);
    await tickOnce();
    expect((session as any).decision).not.toBeNull();
    clock.now = 199.6;
    await tickOnce();
    expect(performMock.recipes).toHaveLength(1);

    // rb lands; a fresh decision for rc is authored.
    vi.advanceTimersByTime(12_000);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("rb");
    clock.now = 320;
    await tickOnce();
    expect((session as any).decision).not.toBeNull();

    // Corrupt the horizon: the next slot's index now points at
    // the CURRENT track — stale state a grab must not let the
    // planner trust. (The cast writes the private slot directly;
    // it stands in for any drift between assumed and actual
    // state, which is what §34 exists to catch.)
    (session as any).nextIndex = 0;
    session.setDeckTrim(0, 0.8);
    await tickOnce();
    // Inspection dropped the stale slot and cancelled the
    // decision that was planned against it...
    expect((session as any).decision).toBeNull();
    // ...and planning recovered against the real state: rc is
    // the next track again, at its true index, and a fresh
    // decision re-authors and performs.
    expect((session as any).next?.track.id).toBe("rc");
    expect((session as any).nextIndex).toBe(2);
    await tickOnce();
    const decision = (session as any).decision;
    expect(decision).not.toBeNull();
    // Advance the clock to just before the decision's anchor,
    // wherever rb's timeline currently sits.
    clock.now +=
      (decision.recipe.overlap.startAMs - store.state.position) / 1000 - 0.4;
    await tickOnce();
    expect(performMock.recipes).toHaveLength(2);
  });

  it("ruling 1: the performed join anchors at or after the first big section's end", async () => {
    const ra = makeTrack("ra", 120_000);
    const rb = makeTrack("rb", 120_000);
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(
        track.id === "ra"
          ? makePrepared(ra, 120, richOutgoing120())
          : makePrepared(rb, 120, richIncoming120()),
      ),
    );
    await session.start([ra, rb]);
    await flushMicrotasks();
    clock.now = 30; // planning window open; position 30 < floor 90
    await tickOnce();
    const decision = (session as any).decision;
    expect(decision).not.toBeNull();
    // The decision itself already respects the floor...
    expect(decision.recipe.overlap.startAMs).toBeGreaterThanOrEqual(90_000);
    clock.now +=
      (decision.recipe.overlap.startAMs - store.state.position) / 1000 - 0.4;
    await tickOnce();
    // ...and so does the performed join.
    expect(performMock.recipes).toHaveLength(1);
    expect(performMock.recipes[0].overlap.startAMs).toBeGreaterThanOrEqual(
      90_000,
    );
  });

  it("ruling 1: the floor binds the DJ, never the user — a skip overrides it instantly", async () => {
    const ra = makeTrack("ra", 120_000);
    const rb = makeTrack("rb", 120_000);
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(
        track.id === "ra"
          ? makePrepared(ra, 120, richOutgoing120())
          : makePrepared(rb, 120, richIncoming120()),
      ),
    );
    await session.start([ra, rb]);
    await flushMicrotasks();
    clock.now = 30; // deep inside the owed first chorus (ends 90)
    session.skipNext();
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("rb");
  });

  it("ruling 2: at an unready boundary the loop buys time, the playhead wraps, and the set never stops", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    const hanging = hangingLoads();
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "a") {
        return Promise.resolve(makePrepared(a, 30, griddedPlainAnalysis(30)));
      }
      return hanging.forTrack(track);
    });
    await session.start([a, b]);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("a");

    // a ends with b still preparing: instead of a cut into
    // nothing or a silent stop, the deck loops a's final 16
    // beats (22 s → 30 s at 120 BPM) and the set plays on.
    clock.now = 30.2;
    await tickOnce();
    vi.advanceTimersByTime(1); // settle the zero-delay wrap timer
    await flushMicrotasks();
    expect(loopMock.calls).toEqual([{ startSec: 22, endSec: 30 }]);
    expect(session.buyTimeLoopCount).toBe(1);
    expect(session.isRunning).toBe(true);
    expect(session.endReason).toBeNull();
    expect(store.state.currentTrack?.id).toBe("a");

    // The playhead wrapped with the loop: at ctx 31 the room is
    // hearing second 23 of a, not silence past its end.
    clock.now = 31;
    await tickOnce();
    expect(store.state.position).toBe(23_000);

    // b lands in the horizon; at the loop span's next end the
    // set cuts to it, the loop is cleared, and play continues.
    hanging.get("b")?.resolve(makePrepared(b));
    await flushMicrotasks();
    clock.now = 38.2;
    await tickOnce();
    expect(store.state.currentTrack?.id).toBe("b");
    expect(loopMock.clears).toBeGreaterThanOrEqual(1);
    expect(session.isRunning).toBe(true);
    expect(session.endReason).toBeNull();
  });

  it("ruling 2: the bound lets go after three wraps and the standing floor applies exactly as before", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    const hanging = hangingLoads();
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "a") {
        return Promise.resolve(makePrepared(a, 30, griddedPlainAnalysis(30)));
      }
      return hanging.forTrack(track);
    });
    await session.start([a, b]);
    await flushMicrotasks();

    clock.now = 30.2;
    await tickOnce();
    vi.advanceTimersByTime(1); // settle the zero-delay wrap timer
    await flushMicrotasks();
    expect(session.buyTimeLoopCount).toBe(1);
    // Wrap 2 at ctx 38, wrap 3 at ctx 46 — the bound.
    clock.now = 38;
    vi.advanceTimersByTime(7_800);
    await flushMicrotasks();
    expect(session.buyTimeLoopCount).toBe(2);
    clock.now = 46;
    vi.advanceTimersByTime(8_000);
    await flushMicrotasks();
    expect(session.buyTimeLoopCount).toBe(3);
    expect(loopMock.clears).toBeGreaterThanOrEqual(1);

    // The span now plays out linearly; at the real end the
    // standing floor walks — and lands b when it finally
    // prepares, through the counted plain cut, as it always has.
    clock.now = 54.2;
    await tickOnce();
    expect(store.state.currentTrack?.id).toBe("a");
    expect(session.isRunning).toBe(true);
    hanging.get("b")?.resolve(makePrepared(b));
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("b");
    // The watchdog may also have counted its rescue while the
    // floor recovered — the pin is that the landing came through
    // the counted floor, not the exact count.
    expect(session.plainCutCount).toBeGreaterThanOrEqual(1);
    expect(session.endReason).toBeNull();
  });

  it("Note 24: a failure-blocked tail is a delay, not a verdict — the loop outwaits the first backoff step", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    let bAttempts = 0;
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "a") {
        return Promise.resolve(makePrepared(a, 30, griddedPlainAnalysis(30)));
      }
      bAttempts += 1;
      return bAttempts === 1
        ? Promise.reject(new Error("transient"))
        : Promise.resolve(makePrepared(track));
    });
    await session.start([a, b]);
    await flushMicrotasks();
    expect(loadsOf("b")).toBe(1); // failed once during horizon prep

    // a ends while b sits inside its 30 s backoff. The set does
    // not stop: the loop buys the time the mark needs to expire.
    clock.now = 30.2;
    await tickOnce();
    vi.advanceTimersByTime(1); // settle the zero-delay wrap timer
    await flushMicrotasks();
    expect(loopMock.calls).toEqual([{ startSec: 22, endSec: 30 }]);
    expect(session.isRunning).toBe(true);
    expect(session.endReason).toBeNull();

    // Time passes (the mark expires); the wrap re-kicks
    // preparation, b prepares on its second attempt, and the
    // set — which never stopped — cuts to it once the loop's
    // bound lets the span play out to its real end.
    vi.advanceTimersByTime(31_000);
    await flushMicrotasks();
    clock.now = 38;
    vi.advanceTimersByTime(8_000);
    await flushMicrotasks();
    expect(loadsOf("b")).toBe(2);
    expect((session as any).next?.track.id).toBe("b");
    // The third wrap spends the bound and lets go at ctx 46;
    // the span then plays out linearly to the real end at 54.
    clock.now = 46.1;
    await tickOnce();
    expect(session.buyTimeLoopCount).toBe(3);
    clock.now = 54.1;
    await tickOnce();
    expect(store.state.currentTrack?.id).toBe("b");
    expect(session.plainCutCount).toBe(1);
    expect(session.isRunning).toBe(true);
    expect(session.endReason).toBeNull();
  });

  it("Note 24: a floor walk discarded by a queue rebuild re-runs instead of ending the set", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    const hanging = hangingLoads();
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "a") return Promise.resolve(makePrepared(track));
      return hanging.forTrack(track);
    });
    await session.start([a, b]);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("a");

    // a ends; the floor's walk parks on the hanging b load.
    clock.now = 30.2;
    await tickOnce();
    expect(store.state.currentTrack?.id).toBe("a");
    expect(session.isRunning).toBe(true);

    // The queue is rebuilt under the parked walk (the cast bumps
    // the generation directly — it stands in for a curation or
    // request rebuild, which is indistinguishable to the walk).
    // The walk discards itself; read as exhaustion, that discard
    // used to stop the set here with b still listed as playable.
    (session as any).queueGeneration += 1;
    hanging.get("b")?.resolve(makePrepared(b));
    await flushMicrotasks();

    // Instead the floor re-ran against the rebuilt queue and
    // landed b through the counted cut. The set never ended.
    expect(store.state.currentTrack?.id).toBe("b");
    expect(session.isRunning).toBe(true);
    expect(session.endReason).toBeNull();
    expect(session.plainCutCount).toBeGreaterThanOrEqual(1);
  });
});
