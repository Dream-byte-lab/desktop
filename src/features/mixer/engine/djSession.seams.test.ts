import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { DjBrain } from "./brain";
import { createJoinHistory, type JoinLogStorage } from "./joinHistory";
import type { TransitionRecipe } from "./recipe";
import type { PreparedTrack } from "./trackSource";

// The DJ stage engine seams (Interface Build 6's filing), pinned
// at the session in the R6 harness style (fake audio clock,
// scripted track source, fake two-deck mixer extended with the
// seam surface — and, unlike the R6 fake, a performRecipe that
// FLIPS the current deck, as the real mixer does, so the
// session's playing-deck derivation is exercised truthfully):
//   · standing truth — the standby deck holds nothing until a
//     join sounds; during one, standingIncoming and the snapshot
//     name the incoming and its real playhead;
//   · manual deck moves — a brake performs through the executor,
//     a refused scratch changes nothing, the standing decision is
//     superseded by a performed trigger and never by a refused
//     one, the standby deck and a sounding join refuse;
//   · the control levels — manual drops the standing decision
//     and authors nothing; assisted turns grabs into holds and
//     leaving assisted releases them;
//   · the tempo bias — clamped to the stretch envelope, and the
//     performed recipe is authored against the biased tempo,
//     including when the bias lands after a decision stands
//     (the re-plan);
//   · the manual loop — grid-true arming, wrap bookkeeping that
//     keeps the reported position honest, release by hand and
//     by seek;
//   · the manual roll and the cue tap — the standby deck's tap,
//     the roll's slice read from the snapshot.

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

const seamMock = vi.hoisted(() => ({
  loopRegions: [] as { index: number; startSec: number; endSec: number }[],
  loopClears: [] as number[],
  rollOpens: [] as { index: number; sliceSec: number }[],
  rollCloses: [] as number[],
  cueCalls: [] as number[],
  holds: [] as { index: number; target: unknown }[],
  holdClears: 0,
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
    setDeckLoopRegion = vi.fn(
      (index: number, startSec: number, endSec: number) => {
        seamMock.loopRegions.push({ index, startSec, endSec });
      },
    );
    clearDeckLoop = vi.fn((index: number) => {
      seamMock.loopClears.push(index);
    });
    openDeckRoll = vi.fn((index: number, sliceSec: number) => {
      seamMock.rollOpens.push({ index, sliceSec });
    });
    closeDeckRoll = vi.fn((index: number) => {
      seamMock.rollCloses.push(index);
    });
    cueAnalyser = vi.fn((index: number) => {
      seamMock.cueCalls.push(index);
      return { cueForDeck: index };
    });
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
    holdManualParam = vi.fn((index: number, target: unknown) => {
      seamMock.holds.push({ index, target });
    });
    clearManualHolds = vi.fn(() => {
      seamMock.holdClears += 1;
    });
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

/**
 * A 60 s outgoing whose first chorus runs 8–48: the minimum-play
 * floor sits at 48, so the brain's standing decision anchors at
 * the outro (48) and nothing commits early — the stage from
 * which the trigger tests fire. The vocal reads 0.9 through the
 * chorus, so a scratch fired at 30 s is refused by the material.
 */
function outgoing60(hash = "hash-a"): TrackAnalysis {
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

/** A 60 s incoming with real landings (intro end, a drop at 16). */
function incoming60(bpm = 120, hash = "hash-b"): TrackAnalysis {
  return {
    beatMap: { bpm, firstBeatSec: 0, beatsPerBar: 4, durationSec: 60 },
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
  durationSec = 60,
): PreparedTrack {
  return {
    track,
    buffer: { duration: durationSec } as unknown as AudioBuffer,
    analysis,
    mixable: true,
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

// ---------------------------------------------------------------------

describe("DjSession — stage engine seams", () => {
  let session: DjSession;
  const a = makeTrack("a");
  const b = makeTrack("b");

  beforeEach(() => {
    vi.useFakeTimers();
    clock.now = 0;
    loadMock.fn.mockReset();
    performMock.recipes.length = 0;
    seamMock.loopRegions.length = 0;
    seamMock.loopClears.length = 0;
    seamMock.rollOpens.length = 0;
    seamMock.rollCloses.length = 0;
    seamMock.cueCalls.length = 0;
    seamMock.holds.length = 0;
    seamMock.holdClears = 0;
    sourceCache.map.clear();
    toastMock.fn.mockReset();
    store.state.status = "idle";
    store.state.currentTrack = null;
    store.state.currentIndex = -1;
    store.state.queue = [];
    store.state.position = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    session = new DjSession(
      new DjBrain({ history: createJoinHistory(fakeJoinStorage()) }),
    );
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(
        makePrepared(track, track.id === "a" ? outgoing60() : incoming60()),
      ),
    );
  });

  afterEach(() => {
    session.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startPair(): Promise<void> {
    await session.start([a, b]);
    await flushMicrotasks();
    await advance(1);
  }

  it("standby truth: the standby deck holds nothing until a join sounds", async () => {
    await startPair();
    expect(session.standingIncoming).toBeNull();
    const snap = session.stageSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.decks[0].trackId).toBe("a");
    expect(snap!.decks[0].positionSec).not.toBeNull();
    // The next track is prepared — in memory. The standby deck
    // honestly holds nothing.
    expect(snap!.decks[1].trackId).toBeNull();
    expect(snap!.decks[1].positionSec).toBeNull();
  });

  it("a triggered brake performs through the executor and the standby deck tells the truth during the join", async () => {
    await startPair();
    await advance(29); // position ≈ 30
    expect(session.triggerDeckMove(0, "brake")).toBe(true);
    expect(performMock.recipes).toHaveLength(1);
    const recipe = performMock.recipes[0];
    expect(recipe.loops[0].type).toBe("brake");
    expect(recipe.loops[0].startMs).toBeGreaterThan(29_000);
    // The join is sounding: the incoming stands on deck 1.
    const standing = session.standingIncoming;
    expect(standing?.track.id).toBe("b");
    expect(standing?.deckIndex).toBe(1);
    await advance(0.5);
    const snap = session.stageSnapshot();
    expect(snap!.decks[1].trackId).toBe("b");
    expect(snap!.decks[1].positionSec).not.toBeNull();
    expect(snap!.decks[0].trackId).toBe("a");
    // The join lands; the incoming is the playing track now.
    await advance(3);
    expect(session.standingIncoming).toBeNull();
    expect(store.state.currentTrack?.id).toBe("b");
  });

  it("triggers refuse on the standby deck, and a spinback refuses without runway", async () => {
    await startPair(); // position ≈ 1
    expect(session.triggerDeckMove(1, "brake")).toBe(false);
    expect(session.triggerDeckMove(0, "spinback")).toBe(false);
    expect(performMock.recipes).toHaveLength(0);
  });

  it("a refused scratch changes nothing; a performed trigger supersedes the standing decision", async () => {
    await startPair();
    await advance(4); // position ≈ 5 — a decision stands by now
    expect(session.stageSnapshot()?.currentMove).not.toBeNull();
    await advance(25); // position ≈ 30, inside the loud chorus
    // The material refuses the scratch (vocal 0.9 across the window).
    expect(session.triggerDeckMove(0, "baby")).toBe(false);
    expect(performMock.recipes).toHaveLength(0);
    // The brain's standing decision is exactly where it was.
    expect(session.stageSnapshot()?.currentMove).not.toBeNull();
    // The host's brake performs, superseding it.
    expect(session.triggerDeckMove(0, "brake")).toBe(true);
    expect(performMock.recipes).toHaveLength(1);
    // And while the join sounds, no second trigger can fire.
    expect(session.triggerDeckMove(0, "brake")).toBe(false);
    expect(performMock.recipes).toHaveLength(1);
  });

  it("manual level: the standing decision is dropped and the brain authors nothing", async () => {
    await startPair();
    await advance(4);
    expect(session.stageSnapshot()?.currentMove).not.toBeNull();
    session.setControlLevel("manual");
    expect(session.controlLevel).toBe("manual");
    expect(session.stageSnapshot()?.controlLevel).toBe("manual");
    expect(session.stageSnapshot()?.currentMove).toBeNull();
    // Deep into where the join would have been authored and
    // committed, nothing is performed by the brain.
    await advance(30);
    expect(performMock.recipes).toHaveLength(0);
    // The host's own trigger still performs in manual.
    expect(session.triggerDeckMove(0, "brake")).toBe(true);
    expect(performMock.recipes).toHaveLength(1);
  });

  it("assisted level: grabs become holds, and leaving assisted releases them", async () => {
    await startPair();
    session.setDeckEq(0, "bass", -6);
    expect(seamMock.holds).toHaveLength(0); // autonomous: no holds
    session.setControlLevel("assisted");
    session.setDeckEq(0, "bass", -6);
    session.setDeckFilter(1, 800);
    session.setFxSendLevel("reverb", "B", 0.5);
    expect(seamMock.holds).toEqual([
      { index: 0, target: { kind: "eq", band: "bass" } },
      { index: 1, target: { kind: "filter" } },
      { index: 1, target: { kind: "send", effect: "reverb" } },
    ]);
    session.setControlLevel("autonomous");
    expect(seamMock.holdClears).toBe(1);
  });

  it("tempo bias: clamped to the stretch envelope, and a bias set after a decision stands re-plans the join", async () => {
    session.setDeckTempoBias(0, 99);
    expect(session.stageSnapshot()).toBeNull(); // no session yet
    await startPair();
    expect(session.stageSnapshot()!.decks[0].tempoBias).toBe(1.15);
    session.setDeckTempoBias(0, 1);
    session.setDeckTempoBias(1, 0.01);
    expect(session.stageSnapshot()!.decks[1].tempoBias).toBe(0.91);
    session.setDeckTempoBias(1, 1);

    await advance(4); // a decision stands, authored at 120 bpm
    expect(session.stageSnapshot()?.currentMove).not.toBeNull();
    session.setDeckTempoBias(0, 1.05);
    // Drive to the commit; the performed recipe must carry the
    // biased tempo belief (120 × 1.05), not the analysis's 120.
    for (let i = 0; i < 60 && performMock.recipes.length === 0; i += 1) {
      await advance(1);
    }
    expect(performMock.recipes).toHaveLength(1);
    expect(performMock.recipes[0].overlap.bpmA).toBeCloseTo(126, 6);
  });

  it("manual loop: grid-true arming, honest wrap bookkeeping, release by seek", async () => {
    await startPair();
    await advance(9); // position ≈ 10
    expect(session.setManualLoop(1, { startSec: 10, beats: 8 })).toBe(false);
    expect(session.setManualLoop(0, { startSec: 10, beats: 8 })).toBe(true);
    // 8 beats at 120 bpm from 10 s ends at 14 s, on the grid.
    expect(seamMock.loopRegions).toEqual([
      { index: 0, startSec: 10, endSec: 14 },
    ]);
    expect(session.stageSnapshot()!.decks[0].manualLoop).toEqual({
      startSec: 10,
      beats: 8,
    });
    // Play past the region's end: the playhead wraps to 10, and
    // the position the session reports follows it down.
    await advance(5.25); // ctx ≈ 15.25 — past the 14 s wrap
    expect(store.state.position).toBeGreaterThan(9_500);
    expect(store.state.position).toBeLessThan(12_500);
    // A seek ends the loop.
    session.seekTo(20_000);
    expect(session.stageSnapshot()!.decks[0].manualLoop).toBeNull();
    expect(seamMock.loopClears).toContain(0);
  });

  it("manual roll: opens on the playing deck only, reads back from the snapshot, releases", async () => {
    await startPair();
    session.setManualRoll(1, 1);
    expect(seamMock.rollOpens).toHaveLength(0); // standby: ignored
    session.setManualRoll(0, 1);
    // 1 beat at 120 bpm = 0.5 s of slice (the roll's tuning —
    // feedback and level — is the mixer's own, pinned there).
    expect(seamMock.rollOpens).toEqual([{ index: 0, sliceSec: 0.5 }]);
    expect(session.stageSnapshot()!.decks[0].manualRollBeats).toBe(1);
    session.setManualRoll(0, null);
    expect(seamMock.rollCloses).toEqual([0]);
    expect(session.stageSnapshot()!.decks[0].manualRollBeats).toBeNull();
  });

  it("cue: the session's cue tap is the standby deck's, and the snapshot names it", async () => {
    await startPair();
    const tap = session.cueAnalyser();
    expect(tap).toEqual({ cueForDeck: 1 });
    expect(seamMock.cueCalls).toContain(1);
    const snap = session.stageSnapshot();
    expect(snap!.cue.deckIndex).toBe(1);
    expect(snap!.cue.meter).toEqual({ peak: 0.4, rms: 0.2 });
  });
});
