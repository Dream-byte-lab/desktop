import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import {
  VISUALIZER_TAP_ID,
  VISUALIZER_TAP_PRIORITY,
  visualizerTaps,
} from "@/features/greeting/lib/visualizerSource";
import { STAGE_EFFECT_KINDS } from "../ui/stage/stageSnapshot";
import type { TrackAnalysis } from "./analyseTrack";
import { DjBrain, type BrainDecision } from "./brain";
import { createJoinHistory, type JoinLogStorage } from "./joinHistory";
import type { TransitionRecipe } from "./recipe";
import type { PreparedTrack } from "./trackSource";

// The SESSION UNLOCK pins: the stage snapshot the session
// assembles from the mixer's stage readings, the manual-stage
// setters delegating through, the master analyser accessor, the
// pure move narration read off the decision artefact, and the
// greeting DJ-master tap registration. Same harness family as
// the Note 21 suite — fake audio clock, scripted track source,
// fake two-deck mixer — with the mixer's stage API added as
// scriptable stubs (canned readings the test sets, setter spies).

const clock = vi.hoisted(() => ({ now: 0 }));

const loadMock = vi.hoisted(() => ({
  fn: vi.fn<(track: Track) => Promise<PreparedTrack | null>>(),
}));

const sourceCache = vi.hoisted(() => ({
  map: new Map<string, PreparedTrack>(),
}));

const toastMock = vi.hoisted(() => ({
  fn: vi.fn(),
}));

const stageMock = vi.hoisted(() => ({
  deckReadings: [
    {
      gainValue: 0.8,
      rateValue: 1.01,
      bassDb: -6,
      midDb: 2,
      highDb: 0,
      filterHz: 12_000,
    },
    {
      gainValue: 0.3,
      rateValue: 0.99,
      bassDb: 0,
      midDb: -3,
      highDb: 4,
      filterHz: 1_200,
    },
  ] as [
    {
      gainValue: number;
      rateValue: number;
      bassDb: number;
      midDb: number;
      highDb: number;
      filterHz: number;
    },
    {
      gainValue: number;
      rateValue: number;
      bassDb: number;
      midDb: number;
      highDb: number;
      filterHz: number;
    },
  ],
  deckMeters: [{ peak: 0.9, rms: 0.5 }, null] as ({
    peak: number;
    rms: number;
  } | null)[],
  masterMeter: { peak: 0.95, rms: 0.6 } as { peak: number; rms: number } | null,
  effectReadings: {} as Record<
    string,
    {
      built: boolean;
      wetLevel: number | null;
      sendLevels: { A: number | null; B: number | null };
    }
  >,
  assigns: {} as Record<string, "A" | "B" | "both" | null>,
  curve: "constant-power" as "smooth" | "constant-power" | "cut",
  analyser: { sentinel: "master-analyser" } as unknown as AnalyserNode,
  setDeckEq: vi.fn(),
  setDeckFilter: vi.fn(),
  setCrossfaderCurve: vi.fn(),
  setManualFxAssign: vi.fn(),
  setManualFxSend: vi.fn(),
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
    // The stage API (the parallel mixer's fixed surface).
    stageDeckReadings = vi.fn((index: 0 | 1) => stageMock.deckReadings[index]);
    deckMeterSummary = vi.fn((index: 0 | 1) => stageMock.deckMeters[index]);
    masterMeterSummary = vi.fn(() => stageMock.masterMeter);
    stageEffectReadings = vi.fn(
      (kind: string) => stageMock.effectReadings[kind],
    );
    manualFxAssign = vi.fn((kind: string) => stageMock.assigns[kind] ?? null);
    crossfaderCurveName = vi.fn(() => stageMock.curve);
    masterAnalyser = vi.fn(() => stageMock.analyser);
    setDeckEq = vi.fn(
      (index: 0 | 1, band: "bass" | "mid" | "high", db: number) => {
        stageMock.setDeckEq(index, band, db);
      },
    );
    setDeckFilter = vi.fn((index: 0 | 1, hz: number) => {
      stageMock.setDeckFilter(index, hz);
    });
    setCrossfaderCurve = vi.fn((curve: "smooth" | "constant-power" | "cut") => {
      stageMock.setCrossfaderCurve(curve);
    });
    setManualFxAssign = vi.fn(
      (kind: string, assign: "A" | "B" | "both" | null) => {
        stageMock.setManualFxAssign(kind, assign);
      },
    );
    setManualFxSend = vi.fn((kind: string, side: "A" | "B", level: number) => {
      stageMock.setManualFxSend(kind, side, level);
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

import { DjSession, describeDecisionMove } from "./djSession";

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

function decisionWith(partial: {
  family: string;
  loops?: unknown[];
  effects?: unknown[];
}): BrainDecision {
  return {
    candidate: { family: partial.family },
    recipe: {
      loops: partial.loops ?? [],
      effects: partial.effects ?? [],
    },
  } as unknown as BrainDecision;
}

function resetStageFake(): void {
  stageMock.deckMeters = [{ peak: 0.9, rms: 0.5 }, null];
  stageMock.masterMeter = { peak: 0.95, rms: 0.6 };
  stageMock.curve = "constant-power";
  stageMock.effectReadings = {};
  STAGE_EFFECT_KINDS.forEach((kind, i) => {
    stageMock.effectReadings[kind] = {
      built: i % 2 === 0,
      wetLevel: i / 10,
      sendLevels: { A: i / 10, B: null },
    };
  });
  stageMock.assigns = {
    reverb: "B",
    delay: "both",
    flanger: "A",
  };
  stageMock.setDeckEq.mockReset();
  stageMock.setDeckFilter.mockReset();
  stageMock.setCrossfaderCurve.mockReset();
  stageMock.setManualFxAssign.mockReset();
  stageMock.setManualFxSend.mockReset();
}

describe("DjSession — stage unlock (snapshot, setters, narration, tap)", () => {
  let session: DjSession;

  beforeEach(() => {
    vi.useFakeTimers();
    clock.now = 0;
    loadMock.fn.mockReset();
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(makePrepared(track)),
    );
    sourceCache.map.clear();
    toastMock.fn.mockReset();
    resetStageFake();
    store.state.status = "idle";
    store.state.currentTrack = null;
    store.state.currentIndex = -1;
    store.state.queue = [];
    store.state.position = 0;
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

  it("stageSnapshot() is null before start and after stop", async () => {
    expect(session.stageSnapshot()).toBeNull();
    await session.start([makeTrack("a"), makeTrack("b")]);
    await flushMicrotasks();
    expect(session.stageSnapshot()).not.toBeNull();
    session.stop();
    expect(session.stageSnapshot()).toBeNull();
  });

  it("after start the snapshot assembles decks, effects, master and curve verbatim from the mixer", async () => {
    await session.start([makeTrack("a"), makeTrack("b")]);
    await flushMicrotasks();

    const snapshot = session.stageSnapshot();
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.decks).toEqual([
      { ...stageMock.deckReadings[0], meter: { peak: 0.9, rms: 0.5 } },
      { ...stageMock.deckReadings[1], meter: null },
    ]);
    expect(snapshot.master).toEqual({
      meter: { peak: 0.95, rms: 0.6 },
    });
    expect(snapshot.effects.map((effect) => effect.kind)).toEqual([
      ...STAGE_EFFECT_KINDS,
    ]);
    expect(snapshot.effects).toEqual(
      STAGE_EFFECT_KINDS.map((kind) => ({
        kind,
        ...stageMock.effectReadings[kind],
        assign: stageMock.assigns[kind] ?? null,
      })),
    );
    expect(snapshot.crossfaderCurve).toBe("constant-power");
    expect(snapshot.currentMove).toBeNull();
  });

  it("masterAnalyser() returns the mixer's sentinel while running and null when stopped", async () => {
    expect(session.masterAnalyser()).toBeNull();
    await session.start([makeTrack("a"), makeTrack("b")]);
    await flushMicrotasks();
    expect(session.masterAnalyser()).toBe(stageMock.analyser);
    session.stop();
    expect(session.masterAnalyser()).toBeNull();
  });

  it("the five manual setters delegate with exact arguments", async () => {
    await session.start([makeTrack("a"), makeTrack("b")]);
    await flushMicrotasks();

    session.setDeckEq(1, "mid", -4.5);
    expect(stageMock.setDeckEq).toHaveBeenCalledTimes(1);
    expect(stageMock.setDeckEq).toHaveBeenCalledWith(1, "mid", -4.5);

    session.setDeckFilter(0, 3_200);
    expect(stageMock.setDeckFilter).toHaveBeenCalledTimes(1);
    expect(stageMock.setDeckFilter).toHaveBeenCalledWith(0, 3_200);

    session.setCrossfaderCurve("cut");
    expect(stageMock.setCrossfaderCurve).toHaveBeenCalledTimes(1);
    expect(stageMock.setCrossfaderCurve).toHaveBeenCalledWith("cut");

    session.setFxAssign("reverb", "both");
    expect(stageMock.setManualFxAssign).toHaveBeenCalledTimes(1);
    expect(stageMock.setManualFxAssign).toHaveBeenCalledWith("reverb", "both");

    session.setFxSendLevel("delay", "B", 0.42);
    expect(stageMock.setManualFxSend).toHaveBeenCalledTimes(1);
    expect(stageMock.setManualFxSend).toHaveBeenCalledWith("delay", "B", 0.42);
  });

  it("the greeting DJ-master tap registration landed in the app registry", () => {
    const registrations = visualizerTaps.registrations();
    expect(registrations).toContainEqual({
      id: VISUALIZER_TAP_ID.DJ_MASTER,
      priority: VISUALIZER_TAP_PRIORITY.DJ_MASTER,
    });
  });
});

describe("describeDecisionMove — narration from the artefact", () => {
  it("null decision narrates to null", () => {
    expect(describeDecisionMove(null)).toBeNull();
  });

  it("let-it-play narrates to null — nothing is performed", () => {
    expect(
      describeDecisionMove(decisionWith({ family: "let-it-play" })),
    ).toBeNull();
  });

  it("a chirp scratch names its technique", () => {
    expect(
      describeDecisionMove(
        decisionWith({
          family: "scratch",
          loops: [{ type: "scratch", technique: "chirp" }],
        }),
      ),
    ).toEqual({
      label: "Performing a chirp scratch",
      family: "scratch",
      technique: "chirp",
    });
  });

  it("a brake block under the vinyl-stop family is a brake stop", () => {
    expect(
      describeDecisionMove(
        decisionWith({
          family: "vinyl-stop",
          loops: [{ type: "brake" }],
        }),
      ),
    ).toEqual({
      label: "Brake stop into the next track",
      family: "vinyl-stop",
      technique: "brake",
    });
  });

  it("a vinyl-stop without a brake block is a vinyl stop", () => {
    expect(
      describeDecisionMove(
        decisionWith({
          family: "vinyl-stop",
          loops: [{ type: "vinyl-stop" }],
        }),
      ),
    ).toEqual({
      label: "Vinyl stop into the next track",
      family: "vinyl-stop",
      technique: "vinyl-stop",
    });
  });

  it("spinback narrates as a spinback", () => {
    expect(
      describeDecisionMove(
        decisionWith({
          family: "spinback",
          loops: [{ type: "spinback" }],
        }),
      ),
    ).toEqual({
      label: "Spinback into the next track",
      family: "spinback",
      technique: "spinback",
    });
  });

  it("a single-kind fx join names the kind", () => {
    expect(
      describeDecisionMove(
        decisionWith({
          family: "fx",
          effects: [{ kind: "reverb" }],
        }),
      ),
    ).toEqual({
      label: "Blending with reverb",
      family: "fx",
      technique: "reverb",
    });
  });

  it("a multi-kind fx join is layered effects", () => {
    expect(
      describeDecisionMove(
        decisionWith({
          family: "fx",
          effects: [{ kind: "reverb" }, { kind: "delay" }],
        }),
      ),
    ).toEqual({
      label: "Blending with layered effects",
      family: "fx",
      technique: "reverb",
    });
  });

  it("a standard blend narrates plainly", () => {
    expect(
      describeDecisionMove(decisionWith({ family: "standard-blend" })),
    ).toEqual({
      label: "Blending into the next track",
      family: "standard-blend",
      technique: null,
    });
  });
});
