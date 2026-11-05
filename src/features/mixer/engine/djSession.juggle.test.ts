import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { DjBrain } from "./brain";
import { ADVENTUROUS_PROFILE } from "./decisionProfile";
import { createJoinHistory, type JoinLogStorage } from "./joinHistory";
import type { JugglePerformance } from "./juggle";
import type { TransitionRecipe } from "./recipe";
import type { PreparedTrack } from "./trackSource";

// The DJ session's borrow protocol (the crab-and-juggling plan's
// J2 + step 10), pinned at the session in the R6 harness style
// (fake audio clock, scripted track source, fake two-deck mixer
// extended with performJuggle — which, unlike performRecipe,
// does NOT flip the current deck: the borrow returns its deck):
//   · triggerJuggle performs with NO prepared incoming — the
//     deliberate difference from triggerDeckMove, which is
//     join-shaped and refuses without one;
//   · the horizon (next / afterNext and their indices) is
//     byte-identical before and after the window, and a real
//     join still lands after it;
//   · position truth runs through the appended segment map: a
//     repeat's playhead re-reads the break span once per segment
//     and resumes from the exit;
//   · a standing decision is cancelled by the act and re-planned
//     after the window — never performed across it;
//   · refusals: the standby deck, a sounding juggle, a shell,
//     material that offers no break;
//   · an interrupted juggle (a seek mid-window) is cleared
//     unrecorded; a completed one writes the self-pair record.

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

const juggleMock = vi.hoisted(() => ({
  performances: [] as JugglePerformance[],
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
      // The real mixer flips its current deck at perform time.
      this.currentDeckIndex = 1 - this.currentDeckIndex;
      const blendStartCtxTime = clock.now + Math.max(0.1, recipe.leadInSec);
      return {
        blendStartCtxTime,
        blendEndCtxTime: blendStartCtxTime + recipe.overlap.durationMs / 1000,
      };
    });
    performJuggle = vi.fn(
      (
        performance: JugglePerformance,
        _buffer: unknown,
        startCtxTime: number,
      ) => {
        juggleMock.performances.push(performance);
        // The borrow does NOT flip the current deck. The window's
        // wall length: a repeat hears its span once per segment,
        // a continue hears the walk.
        const windowSec =
          performance.pattern === "repeat"
            ? performance.segments.length *
              (performance.exitSec - performance.breakStartSec)
            : performance.exitSec - performance.breakStartSec;
        return { endCtxTime: startCtxTime + windowSec };
      },
    );
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
    cueAnalyser = vi.fn((index: number) => ({ cueForDeck: index }));
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
    points.push({ timeSec: t, activity: activityAt(t), confidence: 0.9 });
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

/**
 * A 240 s track with a REPEAT break at 32 s: drops at beats 64
 * and 66 (the segment's end closes the unit), witnessed silence
 * across the break's span, a sung chorus elsewhere, and an outro
 * from 200 s for the join author to anchor on. A second, late
 * break stands at 198 s (beats 396/398) for the
 * standing-decision test.
 */
function juggleTrack240(hash = "hash-a"): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [
      { timeSec: 32, beat: 64, strength: 2.4 },
      { timeSec: 33, beat: 66, strength: 2 },
      { timeSec: 198, beat: 396, strength: 2.4 },
      { timeSec: 199, beat: 398, strength: 2 },
    ],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: hash,
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("verse", 16, 32, 0.3, 0.85),
      section("chorus", 32, 198, 0.5, 0.9),
      section("chorus", 198, 200, 0.5, 0),
      section("outro", 200, 240, 0.1, 0),
    ],
    outro: { startSec: 200, endSec: 240, startBeat: 400, endBeat: 480 },
    vocalActivity: vocalCurve(240, (t) =>
      (t >= 32 && t < 34) || (t >= 198 && t < 200) ? 0 : t < 16 ? 0 : 0.9,
    ),
  };
}

/** A 60 s incoming with real landings (the seams fixture's shape). */
function incoming60(hash = "hash-b"): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 60 },
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
      section("verse", 32, 60, 0.3, 0.85),
    ],
    intro: { startSec: 0, endSec: 8, startBeat: 0, endBeat: 16 },
    vocalActivity: vocalCurve(60, (t) => (t < 8 ? 0 : 0.9)),
  };
}

function makePrepared(
  track: Track,
  analysis: TrackAnalysis,
  durationSec = 240,
  mixable = true,
): PreparedTrack {
  return {
    track,
    buffer: { duration: durationSec } as unknown as AudioBuffer,
    analysis,
    mixable,
  };
}

function fakeJoinStorage(): JoinLogStorage {
  return { read: async () => null, write: async () => {} };
}

async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** Advances the audio clock and the timers together, in tick steps. */
async function advance(sec: number): Promise<void> {
  const steps = Math.round(sec / 0.25);
  for (let i = 0; i < steps; i += 1) {
    clock.now += 0.25;
    vi.advanceTimersByTime(250);
    await flushMicrotasks();
  }
}

const decisionOf = (session: DjSession): unknown =>
  (session as unknown as { decision: unknown }).decision;

/** The preparation horizon's slots, read as the R6 suite reads them. */
const horizonOf = (session: DjSession) =>
  session as unknown as {
    next: PreparedTrack | null;
    nextIndex: number;
    afterNext: PreparedTrack | null;
    afterNextIndex: number;
  };

// ---------------------------------------------------------------------

describe("DjSession — beat juggling (the borrow protocol)", () => {
  let brain: DjBrain;
  let session: DjSession;
  const a = makeTrack("a");
  const b = makeTrack("b", 60_000);

  beforeEach(() => {
    vi.useFakeTimers();
    clock.now = 0;
    loadMock.fn.mockReset();
    performMock.recipes.length = 0;
    juggleMock.performances.length = 0;
    sourceCache.map.clear();
    toastMock.fn.mockReset();
    store.state.status = "idle";
    store.state.currentTrack = null;
    store.state.currentIndex = -1;
    store.state.queue = [];
    store.state.position = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    brain = new DjBrain({
      history: createJoinHistory(fakeJoinStorage()),
    });
    session = new DjSession(brain);
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(
        track.id === "a"
          ? makePrepared(track, juggleTrack240())
          : makePrepared(track, incoming60(), 60),
      ),
    );
  });

  afterEach(() => {
    session.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("triggerJuggle performs with NO prepared incoming — the deliberate difference from a deck move", async () => {
    await session.start([a]);
    await flushMicrotasks();
    await advance(26);
    // A single-track queue: nothing is prepared behind the
    // playing track, and a deck move would refuse here.
    expect(horizonOf(session).next).toBeNull();
    expect(session.triggerJuggle(1)).toBe(false); // the standby deck
    expect(session.triggerJuggle(0)).toBe(true);
    expect(juggleMock.performances).toHaveLength(1);
    const performance = juggleMock.performances[0];
    expect(performance.pattern).toBe("repeat");
    expect(performance.breakStartSec).toBe(32);
    // The borrow is not a join: the mixer's deck never flipped,
    // and during the window the stage names the borrowed deck's
    // copy and narrates the act.
    expect(session.currentDeckIndex).toBe(0);
    await advance(7); // wall 33: the second segment is sounding
    const snap = session.stageSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decks[1].trackId).toBe("a");
    expect(snap!.decks[1].positionSec).toBeCloseTo(32, 6);
    expect(snap!.currentMove?.family).toBe("juggle");
    expect(snap!.currentMove?.technique).toBe("repeat");
    // The window completes: the act is recorded, self-paired,
    // and the borrowed deck is returned — it holds nothing.
    await advance(3); // wall 36, past the window's end at 35
    const history = brain.historySnapshot();
    expect(history).toHaveLength(1);
    expect(history[0].family).toBe("juggle");
    expect(history[0].aAudioHash).toBe("hash-a");
    expect(history[0].bAudioHash).toBe("hash-a");
    expect(session.stageSnapshot()!.decks[1].trackId).toBeNull();
  });

  it("position truth runs through the segment map: the repeat re-reads its span, then resumes from the exit", async () => {
    await session.start([a]);
    await flushMicrotasks();
    await advance(26);
    expect(session.triggerJuggle(0)).toBe(true);
    await advance(6.5); // wall 32.5 — first segment, mid-span
    expect(store.state.position).toBe(32_500);
    await advance(1); // wall 33.5 — second copy, SAME span re-cued
    expect(store.state.position).toBe(32_500);
    await advance(1); // wall 34.5 — third segment, the span again
    expect(store.state.position).toBe(32_500);
    await advance(1); // wall 35.5 — resumed from the exit (33)
    expect(store.state.position).toBe(33_500);
  });

  it("the horizon is untouched by the borrow, and the real join still lands after the window", async () => {
    await session.start([a, b]);
    await flushMicrotasks();
    await advance(26);
    const nextBefore = horizonOf(session).next;
    const nextIndexBefore = horizonOf(session).nextIndex;
    expect(nextBefore?.track.id).toBe("b");
    expect(session.triggerJuggle(0)).toBe(true);
    await advance(10); // wall 36: the window completed at 35
    // Byte-identical horizon: the same prepared object, the same
    // slot, nothing prepared or evicted by the borrow.
    expect(horizonOf(session).next).toBe(nextBefore);
    expect(horizonOf(session).nextIndex).toBe(nextIndexBefore);
    expect(horizonOf(session).afterNext).toBeNull();
    // The set plays on and the join into b is really performed.
    await advance(210);
    expect(performMock.recipes.length).toBeGreaterThanOrEqual(1);
    expect(store.state.currentTrack?.id).toBe("b");
    const families = brain.historySnapshot().map((r) => r.family);
    expect(families).toContain("juggle");
    expect(families.some((f) => f !== "juggle")).toBe(true);
  });

  it("a standing decision is cancelled by the act, never performed across the window, and re-planned after it", async () => {
    await session.start([a, b]);
    await flushMicrotasks();
    // Into the join-planning stretch (remaining < 150): a
    // decision stands for the pair.
    await advance(150);
    expect(decisionOf(session)).not.toBeNull();
    // Up to the late break at 198 s, decision still standing.
    await advance(42);
    expect(decisionOf(session)).not.toBeNull();
    expect(session.triggerJuggle(0)).toBe(true);
    // The act superseded the decision outright.
    expect(decisionOf(session)).toBeNull();
    expect(juggleMock.performances).toHaveLength(1);
    expect(juggleMock.performances[0].breakStartSec).toBe(198);
    // Across the window [198, 201] the cancelled decision is
    // never performed — its anchor (the outro at 200) passes
    // silently, because planning is locked under the act.
    await advance(9); // wall 201: the window has just closed
    expect(performMock.recipes).toHaveLength(0);
    // After the window the brain re-plans and the set reaches b.
    await advance(45);
    expect(store.state.currentTrack?.id).toBe("b");
  });

  it("the autonomous spend performs on its own — no trigger — under a bold temperament", async () => {
    // The spend's draw is a pure function of the session seed:
    // this seed and profile are the pinned fixture under which
    // the stream's first draw admits the act (probed against the
    // brain directly; the default seed draws restraint and is
    // covered by the brain-level pins).
    brain = new DjBrain({
      history: createJoinHistory(fakeJoinStorage()),
      profile: ADVENTUROUS_PROFILE,
      sessionSeed: "juggle-probe-1",
    });
    session = new DjSession(brain);
    await session.start([a]);
    await flushMicrotasks();
    await advance(40);
    expect(juggleMock.performances).toHaveLength(1);
    expect(juggleMock.performances[0].segments).toHaveLength(4);
    const history = brain.historySnapshot();
    expect(history.map((r) => r.family)).toEqual(["juggle"]);
  });

  it("refusals: a second trigger while a juggle sounds, a shell current, and material with no break", async () => {
    await session.start([a]);
    await flushMicrotasks();
    await advance(26);
    expect(session.triggerJuggle(0)).toBe(true);
    await advance(1);
    // The act is committed (its window opens at 32): a second
    // trigger refuses.
    expect(session.triggerJuggle(0)).toBe(false);
    session.stop();

    // A shell can be played plainly and never juggled.
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(makePrepared(track, juggleTrack240(), 240, false)),
    );
    await session.start([a]);
    await flushMicrotasks();
    await advance(20);
    expect(session.triggerJuggle(0)).toBe(false);
    session.stop();

    // A sung-over break is no break: the author refuses, and so
    // does the trigger.
    const sung = juggleTrack240();
    sung.vocalActivity = vocalCurve(240, () => 0.9);
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(makePrepared(track, sung)),
    );
    await session.start([a]);
    await flushMicrotasks();
    await advance(26);
    expect(session.triggerJuggle(0)).toBe(false);
    expect(juggleMock.performances).toHaveLength(1);
  });

  it("a seek mid-window cuts the act: cleared, unrecorded, and the decks tell the truth after", async () => {
    await session.start([a]);
    await flushMicrotasks();
    await advance(26);
    expect(session.triggerJuggle(0)).toBe(true);
    await advance(7); // wall 33: mid-window
    expect(session.stageSnapshot()!.decks[1].trackId).toBe("a");
    session.seekTo(60_000);
    await advance(1);
    expect(store.state.position).toBe(61_000);
    // No completed window, no record.
    expect(brain.historySnapshot()).toHaveLength(0);
    expect(session.stageSnapshot()!.decks[1].trackId).toBeNull();
    expect(session.stageSnapshot()!.currentMove).toBeNull();
  });
});
