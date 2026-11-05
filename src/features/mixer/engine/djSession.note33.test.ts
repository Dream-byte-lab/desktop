import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { DjBrain } from "./brain";
import { createJoinHistory, type JoinLogStorage } from "./joinHistory";
import type { TransitionRecipe } from "./recipe";
import type { PreparedTrack } from "./trackSource";

// Note 33's session pins, in the Note 20/21/R6 harness style (fake
// audio clock, scripted track source, fake two-deck mixer):
//   · a section-less song is still owed its derived floor end to
//     end — the performed join anchors at or after a quarter of
//     the track, where before the floor abstained entirely and
//     the join could land seconds in;
//   · the performed-side gate — a decision authored while the
//     outgoing's analysis was shallower is NOT performed when
//     the analysis deepens past its anchor: the commit waits,
//     the song keeps playing, and the same decision performs
//     once the deepened floor has passed;
//   · the user's skip inside the derived floor is instant (the
//     floor binds the DJ, never the user);
//   · the natural end is never wedged by the gate — a track
//     whose floor is its whole length still hands over at its
//     end and the set plays on.

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
    setDeckEq = vi.fn();
    setDeckFilter = vi.fn();
    setCrossfaderCurve = vi.fn();
    setManualFxAssign = vi.fn();
    setManualFxSend = vi.fn();
    loopCurrentDeck = vi.fn();
    clearCurrentDeckLoop = vi.fn();
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

function makePrepared(
  track: Track,
  durationSec = 30,
  analysis?: TrackAnalysis,
): PreparedTrack {
  return {
    track,
    buffer: { duration: durationSec } as unknown as AudioBuffer,
    analysis: analysis ?? richIncoming120(),
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

/** The same song with its section map missing — a legacy analysis. */
function bareOutgoing120(hash = "hash-ra"): TrackAnalysis {
  const analysis = richOutgoing120(hash);
  analysis.sections = undefined;
  return analysis;
}

/**
 * The same song after a deep pass: its first chorus now reads as
 * running to chorusEndSec, so its floor stands that much later.
 */
function deepenedOutgoing120(chorusEndSec: number): TrackAnalysis {
  const analysis = richOutgoing120();
  analysis.sections = [
    section("intro", 0, 10, 0.15, 0),
    section("verse", 10, 40, 0.3, 0.85),
    section("chorus", 40, chorusEndSec, 0.5, 0.9),
    section("outro", chorusEndSec, 120, 0.1, 0),
  ];
  analysis.outro = {
    startSec: chorusEndSec,
    endSec: 120,
    startBeat: chorusEndSec * 2,
    endBeat: 240,
  };
  return analysis;
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

/** One chorus the whole length of the track — its floor is 120. */
function oneChorus120(): TrackAnalysis {
  const analysis = richOutgoing120();
  analysis.sections = [section("chorus", 0, 120, 0.5, 0.9)];
  return analysis;
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

// ---------------------------------------------------------------------

describe("DjSession — Note 33 (the minimum-play floor, performed side)", () => {
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

  function loadPair(outgoing: TrackAnalysis): void {
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(
        track.id === "ra"
          ? makePrepared(track, 120, outgoing)
          : makePrepared(track, 120, richIncoming120()),
      ),
    );
  }

  it("a section-less song is owed its derived floor, end to end", async () => {
    const ra = makeTrack("ra", 120_000);
    const rb = makeTrack("rb", 120_000);
    loadPair(bareOutgoing120());
    await session.start([ra, rb]);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("ra");

    clock.now = 10; // planning window open; position 10 < derived floor 30
    await tickOnce();
    const decision = (session as unknown as { decision: unknown }).decision as {
      recipe: { overlap: { startAMs: number | null } };
    } | null;
    expect(decision).not.toBeNull();
    // The decision itself already respects the derived floor...
    expect(decision!.recipe.overlap.startAMs).toBeGreaterThanOrEqual(30_000);
    clock.now +=
      (decision!.recipe.overlap.startAMs! - store.state.position) / 1000 - 0.4;
    await tickOnce();
    // ...and so does the performed join. Before the fix the floor
    // abstained for this song and nothing stood between it and a
    // join landing seconds after it started.
    expect(performMock.recipes).toHaveLength(1);
    expect(performMock.recipes[0].overlap.startAMs).toBeGreaterThanOrEqual(
      30_000,
    );
  });

  it("a decision authored against a shallower analysis waits at the performed door until the deepened floor passes", async () => {
    const ra = makeTrack("ra", 120_000);
    const rb = makeTrack("rb", 120_000);
    loadPair(richOutgoing120());
    await session.start([ra, rb]);
    await flushMicrotasks();

    clock.now = 30; // planning window open; the standing floor is 90
    await tickOnce();
    const internals = session as unknown as {
      decision: {
        recipe: { overlap: { startAMs: number | null } };
      } | null;
      current: PreparedTrack;
    };
    const decision = internals.decision;
    expect(decision).not.toBeNull();
    const anchorMs = decision!.recipe.overlap.startAMs!;
    expect(anchorMs).toBeGreaterThanOrEqual(90_000);
    const anchorSec = anchorMs / 1000;

    // The outgoing's analysis deepens mid-track (the deepened-
    // outro latch): its first chorus now reads as running six
    // seconds past the standing anchor, so the floor the room is
    // owed moved beyond the moment the decision wants to fire.
    const deepFloorSec = Math.min(anchorSec + 6, 119);
    internals.current = {
      ...internals.current,
      analysis: deepenedOutgoing120(deepFloorSec),
    };

    // The anchor arrives — the commit is held at the door. The
    // decision stands unperformed and the song plays on.
    clock.now = anchorSec - 0.5;
    await tickOnce();
    expect(performMock.recipes).toHaveLength(0);
    expect(internals.decision).not.toBeNull();
    expect(store.state.currentTrack?.id).toBe("ra");

    // Halfway through the owed remainder: still held.
    clock.now = (anchorSec + deepFloorSec) / 2;
    await tickOnce();
    expect(performMock.recipes).toHaveLength(0);
    expect(store.state.currentTrack?.id).toBe("ra");

    // The floor passes: the same decision performs, its anchor
    // unchanged — only its lead-in was re-stamped to the moment
    // it actually began.
    clock.now = deepFloorSec + 0.3;
    await tickOnce();
    expect(performMock.recipes).toHaveLength(1);
    expect(performMock.recipes[0].overlap.startAMs).toBe(anchorMs);
  });

  it("the user's skip inside the derived floor is instant", async () => {
    const ra = makeTrack("ra", 120_000);
    const rb = makeTrack("rb", 120_000);
    loadPair(bareOutgoing120());
    await session.start([ra, rb]);
    await flushMicrotasks();
    clock.now = 10; // deep inside the derived floor (30)
    session.skipNext();
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("rb");
  });

  it("the natural end is never wedged by the gate", async () => {
    const ra = makeTrack("ra", 120_000);
    const rb = makeTrack("rb", 120_000);
    loadPair(oneChorus120()); // floor = the whole 120 s track
    await session.start([ra, rb]);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("ra");

    clock.now = 120.3; // past the end — and past any floor can stand
    await tickOnce();
    vi.advanceTimersByTime(15_000); // let any blend landing settle
    await flushMicrotasks();
    expect(session.isRunning).toBe(true);
    expect(store.state.currentTrack?.id).toBe("rb");
  });
});
