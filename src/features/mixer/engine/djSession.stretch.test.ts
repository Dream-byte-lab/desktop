import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import { DjBrain } from "./brain";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import {
  createJoinHistory,
  pairShapeOf,
  type JoinLogStorage,
  type JoinRecord,
} from "./joinHistory";
import type { TransitionRecipe } from "./recipe";
import type { PreparedTrack } from "./trackSource";

// The stretch integration, end to end at the session seam: a pair
// whose tempo gap (120 → 120/1.1) sits past the standard rate cap
// but inside the +12% rendition ceiling. The brain's decision calls
// for a rendition; preparation renders it in the background; the
// commit performs the RENDITION buffer — or, when no rendition is
// ready by the anchor, does not perform at all and the fallback
// floor takes the join instead. The harness mirrors djSession.v2's:
// fake audio clock, scripted track source, recording fake mixer —
// plus a scripted rendition source and a seeded join history (the
// room has already heard several plain joins tonight, which is what
// anti-repetition charges; it is why the blend is the honest pick).

const clock = vi.hoisted(() => ({ now: 0 }));

const loadMock = vi.hoisted(() => ({
  fn: vi.fn<(track: Track) => Promise<PreparedTrack | null>>(),
}));

const sourceCache = vi.hoisted(() => ({
  map: new Map<string, PreparedTrack>(),
}));

const renditionMock = vi.hoisted(() => ({
  mode: "ready" as "ready" | "manual" | "never",
  buffer: null as AudioBuffer | null,
  calls: [] as { trackId: string; factor: number }[],
  resolvers: [] as ((buffer: AudioBuffer | null) => void)[],
}));

const performMock = vi.hoisted(() => ({
  performed: [] as { buffer: unknown; recipe: TransitionRecipe }[],
}));

const playMock = vi.hoisted(() => ({
  buffers: [] as unknown[],
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
  loadStretchRendition: (prepared: PreparedTrack, factor: number) => {
    renditionMock.calls.push({ trackId: prepared.track.id, factor });
    if (renditionMock.mode === "ready") {
      return Promise.resolve(renditionMock.buffer);
    }
    if (renditionMock.mode === "never") return Promise.resolve(null);
    return new Promise<AudioBuffer | null>((resolve) => {
      renditionMock.resolvers.push(resolve);
    });
  },
  stretchRendition: () => undefined,
}));

vi.mock("./twoDeckMixer", () => ({
  TwoDeckMixer: class {
    currentDeckIndex = 0;
    master = { gain: { value: 1 } };
    playNow = vi.fn((buffer: unknown) => {
      playMock.buffers.push(buffer);
      return clock.now;
    });
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
    performRecipe = vi.fn((buffer: unknown, recipe: TransitionRecipe) => {
      performMock.performed.push({ buffer, recipe });
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

// ---------------------------------------------------------------------
// Fixtures (the rich pair of the v2 suite, with B at 120/1.1 BPM)
// ---------------------------------------------------------------------

function makeTrack(id: string, durationMs = 240_000): Track {
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

function richOutgoing(): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: "hash-a",
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("verse", 16, 64, 0.3, 0.85),
      section("chorus", 64, 112, 0.5, 0.9),
      section("verse", 112, 200, 0.3, 0.85),
      section("outro", 200, 240, 0.1, 0),
    ],
    outro: { startSec: 200, endSec: 240, startBeat: 400, endBeat: 480 },
    vocalActivity: vocalCurve(240, (t) => (t < 16 ? 0 : t < 200 ? 0.9 : 0)),
  };
}

function richIncoming(): TrackAnalysis {
  return {
    beatMap: {
      bpm: 120 / 1.1,
      firstBeatSec: 0,
      beatsPerBar: 4,
      durationSec: 240,
    },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [{ timeSec: 35.2, beat: 64, strength: 2.4 }],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: "hash-b",
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

function makePrepared(track: Track, analysis: TrackAnalysis): PreparedTrack {
  return {
    track,
    buffer: { duration: 240 } as unknown as AudioBuffer,
    analysis,
  };
}

/**
 * Tonight's earlier joins: three each of the plain families, all
 * for this pair's shape — the anti-repetition charge that makes the
 * blend the honest pick for THIS pair (and only this pair's shape).
 */
function seededStorage(outgoing: TrackAnalysis, incoming: TrackAnalysis) {
  const shape = pairShapeOf(outgoing, incoming);
  const families: JoinRecord["family"][] = [
    "filter-fade",
    "drop-cut",
    "let-it-play",
    "early-cut",
  ];
  const records: JoinRecord[] = [];
  let at = 1_000;
  // Interleaved, not grouped: repetition cost decays by recency
  // rank, so each family must appear at recent ranks to be charged
  // as "the room just heard this".
  for (let round = 0; round < 3; round += 1) {
    for (const family of families) {
      records.push({
        aAudioHash: "other-a",
        bAudioHash: "other-b",
        family,
        profileId: "standard",
        pairShape: shape,
        blendBeats: 0,
        stretch: 0,
        heardLengthSec: 120,
        at: (at += 1_000),
      });
    }
  }
  const storage: JoinLogStorage = {
    read: async () => records,
    write: async () => {},
  };
  return storage;
}

async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function tickOnce(): Promise<void> {
  vi.advanceTimersByTime(250);
  await flushMicrotasks();
}

describe("DjSession — stretch joins (rendition decisions)", () => {
  let session: DjSession;
  let outgoing: TrackAnalysis;
  let incoming: TrackAnalysis;
  let trackA: Track;
  let trackB: Track;
  let preparedA: PreparedTrack;
  let preparedB: PreparedTrack;
  let renditionBuffer: AudioBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    clock.now = 0;
    loadMock.fn.mockReset();
    performMock.performed.length = 0;
    playMock.buffers.length = 0;
    sourceCache.map.clear();
    renditionMock.mode = "ready";
    renditionMock.calls.length = 0;
    renditionMock.resolvers.length = 0;
    renditionBuffer = { duration: 240 / 1.1 } as unknown as AudioBuffer;
    renditionMock.buffer = renditionBuffer;
    toastMock.fn.mockReset();
    store.state.status = "idle";
    store.state.currentTrack = null;
    store.state.currentIndex = -1;
    store.state.queue = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);

    outgoing = richOutgoing();
    incoming = richIncoming();
    trackA = makeTrack("a");
    trackB = makeTrack("b");
    preparedA = makePrepared(trackA, outgoing);
    preparedB = makePrepared(trackB, incoming);
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(
        track.id === "a" ? preparedA : track.id === "b" ? preparedB : null,
      ),
    );
    const brain = new DjBrain({
      history: createJoinHistory(seededStorage(outgoing, incoming)),
    });
    session = new DjSession(brain);
  });

  afterEach(() => {
    session.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startAndDecide(): Promise<void> {
    await session.start([trackA, trackB]);
    await flushMicrotasks();
    // Into the planning window (90 s in; the blend anchors at the
    // outro, 200 s): the decision is made and the rendition asked.
    clock.now = 90;
    await tickOnce();
  }

  it("asks preparation for the rendition at decision time, at the recipe's factor", async () => {
    await startAndDecide();
    expect(renditionMock.calls).toHaveLength(1);
    expect(renditionMock.calls[0].trackId).toBe("b");
    expect(renditionMock.calls[0].factor).toBeCloseTo(1.1, 6);
    // Nothing performed yet — the anchor is 110 s away.
    expect(performMock.performed).toHaveLength(0);
  });

  it("commits the RENDITION buffer once it lands, and positions B in original time at the stretch rate", async () => {
    renditionMock.mode = "manual";
    await startAndDecide();
    expect(renditionMock.calls).toHaveLength(1);

    // At the anchor's horizon with no rendition yet: no commit —
    // and above all no performance against the original buffer.
    clock.now = 199.5;
    await tickOnce();
    expect(performMock.performed).toHaveLength(0);

    // The render lands; the next tick commits it.
    renditionMock.resolvers[0](renditionBuffer);
    await flushMicrotasks();
    clock.now = 199.75;
    await tickOnce();
    expect(performMock.performed).toHaveLength(1);
    expect(performMock.performed[0].buffer).toBe(renditionBuffer);
    expect(performMock.performed[0].recipe.overlap.stretchB).toBeCloseTo(
      1.1,
      6,
    );

    // The blend completes (the mock's blend runs 8 s from its 200 s
    // start): the session lands on B.
    await vi.advanceTimersByTimeAsync(9_000);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("b");

    // Position model: B entered at beat 48 of its own grid (26.4 s
    // of original time) and advances at the stretch rate — at ctx
    // 210 s it reads 26.4 + 10 × 1.1 = 37.4 s, not 36.4.
    store.state.setPosition.mockClear();
    clock.now = 210;
    await tickOnce();
    const positions = store.state.setPosition.mock.calls.map(
      ([ms]) => ms as number,
    );
    expect(positions[positions.length - 1]).toBeGreaterThan(37_300);
    expect(positions[positions.length - 1]).toBeLessThan(37_500);
  });

  it("a rendition that never lands leaves the join to the fallback floor — a counted plain cut on the original buffer", async () => {
    renditionMock.mode = "never";
    await startAndDecide();
    expect(renditionMock.calls).toHaveLength(1);

    clock.now = 199.5;
    await tickOnce();
    expect(performMock.performed).toHaveLength(0);

    // A's end arrives with the decision unperformed: it is dropped,
    // and the floor cuts plainly to B's original buffer.
    clock.now = 240.5;
    await tickOnce();
    expect(performMock.performed).toHaveLength(0);
    expect(session.plainCutCount).toBe(1);
    expect(store.state.currentTrack?.id).toBe("b");
    expect(playMock.buffers[playMock.buffers.length - 1]).toBe(
      preparedB.buffer,
    );
  });
});
