import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { DjBrain } from "./brain";
import { createJoinHistory, type JoinLogStorage } from "./joinHistory";
import type { PreparedTrack } from "./trackSource";

// Note 32 — the deck door for auto-resume starts. The intent
// wiring's spend is gated (sounding player, consistent signature),
// and this suite pins the session-side backstop: a start the
// wiring spent (autoResume) re-validates at the moment it would
// land, after preparation, against the store's CURRENT track. If
// the user has chosen something else while the start prepared —
// the fresh-launch fault's exact shape, a press landing behind
// the resume's back — the start leaves quietly ("superseded",
// decks never sound) instead of playing the stale queue's track
// over the user's pick and seizing the bar. A start whose user
// never moved on lands exactly as before, and a deliberate start
// (no autoResume flag) is never re-validated.
//
// The harness follows the R6/seams style: fake audio clock,
// scripted track source whose loads the test can hold open,
// a fake two-deck mixer counting playNow calls, and the seams
// fake player store.

const clock = vi.hoisted(() => ({ now: 0 }));

const loadMock = vi.hoisted(() => ({
  fn: vi.fn<(track: Track) => Promise<PreparedTrack | null>>(),
}));

const sourceCache = vi.hoisted(() => ({
  map: new Map<string, PreparedTrack>(),
}));

const mixerMock = vi.hoisted(() => ({ playNowCalls: 0 }));

const toastMock = vi.hoisted(() => ({ fn: vi.fn() }));

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
    playNow = vi.fn(() => {
      mixerMock.playNowCalls += 1;
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
    performRecipe = vi.fn(() => ({
      blendStartCtxTime: clock.now,
      blendEndCtxTime: clock.now,
    }));
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
    setDeckLoopRegion = vi.fn();
    clearDeckLoop = vi.fn();
    openDeckRoll = vi.fn();
    closeDeckRoll = vi.fn();
    cueAnalyser = vi.fn(() => ({ cueForDeck: 0 }));
    cueMeterSummary = vi.fn(() => ({ peak: 0.4, rms: 0.2 }));
    deckMeterSummary = vi.fn(() => null);
    masterMeterSummary = vi.fn(() => null);
    stageDeckReadings = vi.fn(() => ({
      gainValue: 1,
      rateValue: 1,
      bassDb: 0,
      midDb: 0,
      highDb: 0,
      filterHz: 20_000,
    }));
    stageEffectReadings = vi.fn(() => ({
      built: false,
      wetLevel: null,
      sendLevels: { A: null, B: null },
    }));
    manualFxAssign = vi.fn(() => null);
    crossfaderCurveName = vi.fn(() => "smooth" as const);
    holdManualParam = vi.fn();
    clearManualHolds = vi.fn();
    manualParamHeld = vi.fn(() => false);
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

function makeTrack(id: string, durationMs = 60_000): Track {
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

function analysis60(hash: string): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 60 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: hash,
    sections: [
      section("intro", 0, 8, 0.15, 0),
      section("chorus", 8, 48, 0.5, 0.9),
      section("outro", 48, 60, 0.1, 0),
    ],
    outro: { startSec: 48, endSec: 60, startBeat: 96, endBeat: 120 },
    vocalActivity: vocalCurve(60, (t) => (t < 8 ? 0 : t < 48 ? 0.9 : 0)),
  };
}

function makePrepared(track: Track): PreparedTrack {
  return {
    track,
    buffer: { duration: 60 } as unknown as AudioBuffer,
    analysis: analysis60(`hash-${track.id}`),
    mixable: true,
  };
}

function fakeJoinStorage(): JoinLogStorage {
  return { read: async () => null, write: async () => {} };
}

async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------

describe("DjSession — the Note 32 deck door (auto-resume starts)", () => {
  let session: DjSession;
  const a = makeTrack("a");
  const b = makeTrack("b");
  const x = makeTrack("x");
  const y = makeTrack("y");

  // Loads the test holds open, keyed by track id, until released.
  const held = new Map<
    string,
    { resolve: (prepared: PreparedTrack | null) => void }
  >();

  function holdLoad(trackId: string): void {
    held.set(trackId, { resolve: () => {} });
  }

  function releaseLoad(track: Track): void {
    const entry = held.get(track.id);
    if (!entry) throw new Error(`load for ${track.id} was not held`);
    held.delete(track.id);
    entry.resolve(makePrepared(track));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clock.now = 0;
    loadMock.fn.mockReset();
    mixerMock.playNowCalls = 0;
    sourceCache.map.clear();
    toastMock.fn.mockReset();
    held.clear();
    store.state.status = "playing";
    store.state.currentTrack = a;
    store.state.currentIndex = 0;
    store.state.queue = [a, b];
    store.state.position = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    session = new DjSession(
      new DjBrain({ history: createJoinHistory(fakeJoinStorage()) }),
    );
    loadMock.fn.mockImplementation(
      (track) =>
        new Promise<PreparedTrack | null>((resolve) => {
          if (held.has(track.id)) {
            held.set(track.id, { resolve });
            return;
          }
          resolve(makePrepared(track));
        }),
    );
  });

  afterEach(() => {
    session.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts quietly when the user's press lands while the resume start prepares", async () => {
    // The wiring spent the resume on the sounding state (a in
    // [a, b]); preparation of a is still running when the user's
    // own press — a song from a new playlist — writes the store.
    holdLoad("a");
    const startPromise = session.start([a, b], 0, { autoResume: true });
    await flushMicrotasks();

    store.state.setQueue([x, y]);
    store.state.setCurrentTrack(x, 0);

    releaseLoad(a);
    await startPromise;
    await flushMicrotasks();

    // The stale start never sounded and never seized the store:
    // the press's song is still the current one.
    expect(mixerMock.playNowCalls).toBe(0);
    expect(session.isRunning).toBe(false);
    expect(session.startOutcome).toBe("superseded");
    expect(store.state.currentTrack?.id).toBe("x");
    expect(store.state.queue.map((t) => t.id)).toEqual(["x", "y"]);
    expect(toastMock.fn).not.toHaveBeenCalled();
  });

  it("aborts when the user picks a different track of the same queue mid-preparation", async () => {
    holdLoad("a");
    const startPromise = session.start([a, b], 0, { autoResume: true });
    await flushMicrotasks();

    // Same queue, a different current choice than the start began
    // with — and not the track the start is about to play.
    store.state.setCurrentTrack(b, 1);

    releaseLoad(a);
    await startPromise;
    await flushMicrotasks();

    expect(mixerMock.playNowCalls).toBe(0);
    expect(session.isRunning).toBe(false);
    expect(session.startOutcome).toBe("superseded");
    expect(store.state.currentTrack?.id).toBe("b");
  });

  it("lands exactly as before when the user never moved on", async () => {
    holdLoad("a");
    const startPromise = session.start([a, b], 0, { autoResume: true });
    await flushMicrotasks();

    releaseLoad(a);
    await startPromise;
    await flushMicrotasks();

    expect(mixerMock.playNowCalls).toBe(1);
    expect(session.isRunning).toBe(true);
    expect(session.startOutcome).toBe("started");
    expect(store.state.currentTrack?.id).toBe("a");
  });

  it("never re-validates a deliberate start: the door is resume-only", async () => {
    holdLoad("a");
    const startPromise = session.start([a, b], 0);
    await flushMicrotasks();

    // The same mid-preparation store change that aborts a resume
    // start leaves a deliberate start untouched — the user's own
    // hand is on those, and their behaviour is unchanged.
    store.state.setQueue([x, y]);
    store.state.setCurrentTrack(x, 0);

    releaseLoad(a);
    await startPromise;
    await flushMicrotasks();

    expect(mixerMock.playNowCalls).toBe(1);
    expect(session.isRunning).toBe(true);
    expect(session.startOutcome).toBe("started");
  });
});
