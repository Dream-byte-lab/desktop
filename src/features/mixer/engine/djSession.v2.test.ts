import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import { DjBrain } from "./brain";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import {
  createJoinHistory,
  type JoinLogStorage,
  type JoinRecord,
} from "./joinHistory";
import { familyOfRecipe } from "./candidates";
import type { TransitionRecipe } from "./recipe";
import type { PreparedTrack } from "./trackSource";

// Session v2 (S5-4): the eight guarantees from the Note 14/15
// diagnosis, plus the blueprint's Req 1 / Req 2 / locked-join
// acceptance tests, driven end to end with the same harness style
// as the Step 2 suite — fake audio clock, scripted track source,
// fake two-deck mixer (this one also performs recipes).

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
  analysis?: TrackAnalysis,
): PreparedTrack {
  return {
    track,
    buffer: { duration: durationSec } as unknown as AudioBuffer,
    analysis: analysis ?? plainAnalysis(durationSec),
  };
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

/** A rich v2 outgoing analysis (120 BPM, 240 s) with a movable outro. */
function richOutgoing(outroStartSec = 200, hash = "hash-a"): TrackAnalysis {
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

function richIncoming(hash = "hash-b"): TrackAnalysis {
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

async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function tickOnce(): Promise<void> {
  vi.advanceTimersByTime(250);
  await flushMicrotasks();
}

const BLEND_FAMILIES = new Set([
  "long-blend",
  "standard-blend",
  "short-blend",
  "loop-extended-blend",
]);

// ---------------------------------------------------------------------

describe("DjSession v2 — the eight guarantees", () => {
  let session: DjSession;
  let brain: DjBrain;

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
    brain = new DjBrain({ history: createJoinHistory(fakeJoinStorage()) });
    session = new DjSession(brain);
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

  function loadsOf(id: string): number {
    return loadMock.fn.mock.calls.filter(([track]) => track.id === id).length;
  }

  it("guarantee 1: start walks from the requested index and reports its outcome", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    const c = makeTrack("c");
    loadsById(
      new Map([
        ["a", makePrepared(a)],
        ["b", null],
        ["c", makePrepared(c)],
      ]),
    );
    await session.start([a, b, c], 1);
    await flushMicrotasks();
    expect(session.isRunning).toBe(true);
    expect(store.state.currentTrack?.id).toBe("c");
    expect(store.state.currentIndex).toBe(2);
    expect(session.startOutcome).toBe("started");
  });

  it("guarantee 2: a preparation that never settles resolves as failure within the deadline", async () => {
    const hang = makeTrack("hang");
    const good = makeTrack("good");
    loadMock.fn.mockImplementation((track) =>
      track.id === "hang"
        ? new Promise<PreparedTrack | null>(() => {})
        : Promise.resolve(makePrepared(track)),
    );
    let settled = false;
    const starting = session.start([hang, good]).then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false); // the hang is genuinely pending
    await vi.advanceTimersByTimeAsync(45_000);
    await starting;
    expect(settled).toBe(true);
    expect(session.isRunning).toBe(true);
    expect(store.state.currentTrack?.id).toBe("good");
    expect(session.startOutcome).toBe("started");
  });

  it("guarantee 5: a transiently failed track is retried once its mark expires", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    let bAttempts = 0;
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "b") {
        bAttempts += 1;
        return Promise.resolve(bAttempts === 1 ? null : makePrepared(track));
      }
      return Promise.resolve(makePrepared(track));
    });
    await session.start([a, b]);
    await flushMicrotasks();
    expect(loadsOf("b")).toBe(1);

    // While the mark is fresh, a walk steps over the track — no retry.
    session.skipNext();
    await flushMicrotasks();
    expect(loadsOf("b")).toBe(1);
    expect(store.state.currentTrack?.id).toBe("a");

    // Once the mark expires, the same track is retried — and mixes.
    vi.advanceTimersByTime(31_000);
    await flushMicrotasks();
    session.skipNext();
    await flushMicrotasks();
    expect(loadsOf("b")).toBe(2);
    expect(store.state.currentTrack?.id).toBe("b");
  });

  it("guarantee 7: every start outcome and session end carries its reason", async () => {
    await session.start([]);
    expect(session.startOutcome).toBe("empty");
    expect(session.isRunning).toBe(false);

    const bad = makeTrack("bad");
    loadsById(new Map([["bad", null]]));
    await session.start([bad]);
    await flushMicrotasks();
    expect(session.startOutcome).toBe("no-playable");
    expect(session.endReason).toBe("start-no-playable");
    expect(toastMock.fn).toHaveBeenCalledWith(
      "None of those tracks could be prepared for mixing.",
      "error",
    );

    const good = makeTrack("good");
    loadsById(new Map([["good", makePrepared(good)]]));
    await session.start([good]);
    await flushMicrotasks();
    expect(session.startOutcome).toBe("started");
    session.stop();
    expect(session.endReason).toBe("user-stop");
  });

  it("guarantee 3: repeated fallback cuts degrade the session, announced in public state", async () => {
    const ids = ["a", "b", "c", "d"];
    const tracks = ids.map((id) => makeTrack(id, 4_000));
    const deferreds = new Map<string, Promise<PreparedTrack | null>>();
    loadMock.fn.mockImplementation((track) => {
      if (track.id === "a") {
        return Promise.resolve(makePrepared(track, 4, plainAnalysis(4)));
      }
      let pending = deferreds.get(track.id);
      if (!pending) {
        pending = new Promise<PreparedTrack | null>((resolve) => {
          setTimeout(
            () => resolve(makePrepared(track, 4, plainAnalysis(4))),
            5_000,
          );
        });
        deferreds.set(track.id, pending);
      }
      return pending;
    });
    await session.start(tracks);
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("a");

    // Each following track is still preparing when its predecessor
    // ends, so the floor lands it with a plain cut — three times.
    for (const [index, id] of ["b", "c", "d"].entries()) {
      clock.now = 5 * (index + 1);
      await tickOnce(); // the end branch starts the floor's walk
      vi.advanceTimersByTime(5_000); // the slow load lands
      await flushMicrotasks();
      expect(store.state.currentTrack?.id).toBe(id);
    }
    expect(session.plainCutCount).toBe(3);
    expect(session.degraded).toBe(true);
    expect(toastMock.fn).toHaveBeenCalledWith(
      expect.stringContaining("degraded"),
      "error",
    );

    // And the end of the queue announces itself too.
    clock.now = 20;
    await tickOnce();
    await flushMicrotasks();
    expect(session.isRunning).toBe(false);
    expect(session.endReason).toBe("queue-exhausted");
    expect(toastMock.fn).toHaveBeenCalledWith(
      expect.stringContaining("set ended"),
      "error",
    );
  });

  it("guarantee 8 (session side): preparation stays on the horizon under a long queue", async () => {
    const tracks = Array.from({ length: 10 }, (_, i) => makeTrack(`t${i}`));
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(makePrepared(track)),
    );
    await session.start(tracks);
    await flushMicrotasks();
    for (let i = 0; i < 3; i += 1) {
      session.skipNext();
      await flushMicrotasks();
    }
    expect(store.state.currentIndex).toBe(3);
    const loadedIds = new Set(
      loadMock.fn.mock.calls.map(([track]) => track.id),
    );
    // The TWO-track horizon (Note 20): start track + the two ahead
    // of it, and each landing promotes the second slot and refills
    // one beyond — never the whole tail.
    expect([...loadedIds].sort()).toEqual(["t0", "t1", "t2", "t3", "t4", "t5"]);
  });

  describe("the brain loop on a friendly pair", () => {
    const trackA = makeTrack("ra", 240_000);
    const trackB = makeTrack("rb", 240_000);
    let preparedA: PreparedTrack;
    let preparedB: PreparedTrack;

    beforeEach(() => {
      preparedA = makePrepared(trackA, 240, richOutgoing());
      preparedB = makePrepared(trackB, 240, richIncoming());
      loadsById(
        new Map([
          ["ra", preparedA],
          ["rb", preparedB],
        ]),
      );
    });

    async function driveToCommit(): Promise<void> {
      await session.start([trackA, trackB]);
      await flushMicrotasks();
      clock.now = 100; // inside the consider window (140 s remaining)
      await tickOnce();
      expect(performMock.recipes).toHaveLength(0); // decided, not yet ripe
      clock.now = 199.6; // the anchor is upon us
      await tickOnce();
      expect(performMock.recipes).toHaveLength(1);
    }

    it("guarantee 4: the pair is joined by a planned blend, not a cut", async () => {
      await driveToCommit();
      const recipe = performMock.recipes[0];
      expect(BLEND_FAMILIES.has(familyOfRecipe(recipe))).toBe(true);
      expect(recipe.overlap.durationMs).toBeGreaterThan(0);
    });

    it("guarantee 6: the tick cannot land the pair early; completion lands exactly once", async () => {
      await driveToCommit();
      clock.now = 241; // the outgoing is over — the end branch must not fire
      await tickOnce();
      expect(store.state.currentTrack?.id).toBe("ra");
      expect(performMock.recipes).toHaveLength(1);

      vi.advanceTimersByTime(12_000); // past the blend's end
      await flushMicrotasks();
      expect(store.state.currentTrack?.id).toBe("rb");
      expect(store.state.currentIndex).toBe(1);
      expect(brain.historySnapshot()).toHaveLength(1);

      vi.advanceTimersByTime(12_000); // nothing lands twice
      await flushMicrotasks();
      expect(store.state.currentTrack?.id).toBe("rb");
      expect(brain.historySnapshot()).toHaveLength(1);
    });

    it("Req 1: a decision is revised when the outgoing's outro arrives early", async () => {
      await session.start([trackA, trackB]);
      await flushMicrotasks();
      clock.now = 100;
      await tickOnce(); // first decision, anchored near the 200 s outro
      // The analysis deepens: the outro actually starts at 120 s.
      preparedA.analysis = richOutgoing(120);
      await tickOnce(); // inputs changed — the brain re-considers
      clock.now = 119.6;
      await tickOnce();
      expect(performMock.recipes).toHaveLength(1);
      // The performed recipe is the REVISED one (anchored ~120 s),
      // not the latched plan (~200 s).
      expect(performMock.recipes[0].overlap.startAMs).toBeLessThan(150_000);
    });

    it("the locked join: signals, requests and curation cannot alter a committed join", async () => {
      const trackC = makeTrack("rc", 240_000);
      loadsById(
        new Map([
          ["ra", preparedA],
          ["rb", preparedB],
          ["rc", makePrepared(trackC, 240, richIncoming())],
        ]),
      );
      await session.start([trackA, trackB, trackC]);
      await flushMicrotasks();
      clock.now = 100;
      await tickOnce();
      clock.now = 199.6;
      await tickOnce();
      expect(performMock.recipes).toHaveLength(1);

      // The room shouts; a guest asks; the host tries to re-curate.
      for (let i = 0; i < 5; i += 1) {
        brain.signals.record({ kind: "skip-early" });
      }
      const request = await session.submitLiveRaveRequest({
        id: "r1",
        guestId: "g1",
        track: trackC,
        requestedAtSec: 0,
      });
      expect(request).not.toBeNull();
      const decisions = await session.evaluateLiveRaveQueue(0);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].status).toBe("waiting");
      expect(
        decisions[0].status === "waiting" && decisions[0].reason,
      ).toContain("locked");
      expect(await session.curateRemaining()).toBe(false);

      // The join still completes exactly as committed.
      vi.advanceTimersByTime(12_000);
      await flushMicrotasks();
      expect(performMock.recipes).toHaveLength(1);
      expect(store.state.currentTrack?.id).toBe("rb");
    });
  });

  it("Req 2 (session level): an early skip moves the weights the next decision uses", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    loadsById(
      new Map([
        ["a", makePrepared(a)],
        ["b", makePrepared(b)],
      ]),
    );
    await session.start([a, b]);
    await flushMicrotasks();
    const before = brain.effectiveProfile().familyCosts["long-blend"];
    clock.now = 3; // 10% into the 30 s track: an early skip
    session.skipNext();
    await flushMicrotasks();
    expect(store.state.currentTrack?.id).toBe("b");
    expect(brain.signals.impatience()).toBeGreaterThan(0);
    expect(brain.effectiveProfile().familyCosts["long-blend"]).toBeGreaterThan(
      before,
    );
  });

  it("may-not: a do-not-play request is refused at maximum signal pressure", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    const c = makeTrack("c");
    loadsById(
      new Map([
        ["a", makePrepared(a)],
        ["b", makePrepared(b)],
        ["c", makePrepared(c)],
      ]),
    );
    await session.start([a, b, c]);
    await flushMicrotasks();
    session.setLiveRaveDoNotPlay(["c"]);
    for (let i = 0; i < 10; i += 1) {
      brain.signals.record({ kind: "skip-early" });
      brain.signals.record({ kind: "party-reaction" });
    }
    const request = await session.submitLiveRaveRequest({
      id: "r1",
      guestId: "g1",
      track: c,
      requestedAtSec: 0,
    });
    expect(request).not.toBeNull();
    const decisions = await session.evaluateLiveRaveQueue(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe("not-tonight");
  });

  it("the party ear: guest reactions reach the brain as signals while a party is open", async () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    loadsById(
      new Map([
        ["a", makePrepared(a)],
        ["b", makePrepared(b)],
      ]),
    );
    await session.start([a, b]);
    await flushMicrotasks();
    const { usePartyStore } = await import("../store/partyStore");
    usePartyStore.getState().setSnapshot({
      open: true,
      addresses: [],
      feed: [],
      reactions: { fire: 6, heart: 2, clap: 0 },
      paused: false,
      doNotPlay: [],
    });
    const reactions = brain.signals
      .journal()
      .filter((event) => event.kind === "party-reaction");
    expect(reactions).toHaveLength(8);
    expect(brain.signals.partyMomentum()).toBeGreaterThan(0);
    usePartyStore.getState().setSnapshot({
      open: false,
      addresses: [],
      feed: [],
      reactions: { fire: 0, heart: 0, clap: 0 },
      paused: false,
      doNotPlay: [],
    });
  });

  it("evaluation weighs the cache, never the whole tail, and loses no track", async () => {
    const tracks = ["a", "b", "c", "d", "e"].map((id) => makeTrack(id));
    loadMock.fn.mockImplementation((track) =>
      Promise.resolve(makePrepared(track)),
    );
    await session.start(tracks);
    await flushMicrotasks();
    const request = await session.submitLiveRaveRequest({
      id: "r1",
      guestId: "g1",
      track: tracks[4],
      requestedAtSec: 0,
    });
    expect(request).not.toBeNull();
    loadMock.fn.mockClear();
    const decisions = await session.evaluateLiveRaveQueue(0);
    expect(decisions).toHaveLength(1);
    // At most the one-track horizon creep may load during evaluation.
    expect(loadMock.fn.mock.calls.length).toBeLessThanOrEqual(1);
    // Uncached tail tracks keep their places; nothing is dropped.
    expect(store.state.queue.map((track) => track.id)).toEqual(
      expect.arrayContaining(["a", "b", "c", "d", "e"]),
    );
    expect(store.state.queue).toHaveLength(5);
    expect(store.state.queue[0].id).toBe("a");
  });

  describe("Note 16 — the field case (0.1.6)", () => {
    it("(a)+(c): every compatible pair in a set is joined by a recipe — no song plays in full by accident, and it is not luck-of-the-pair", async () => {
      const a = makeTrack("na", 240_000);
      const b = makeTrack("nb", 240_000);
      const c = makeTrack("nc", 240_000);
      loadsById(
        new Map([
          ["na", makePrepared(a, 240, richOutgoing(200, "hash-na"))],
          ["nb", makePrepared(b, 240, richOutgoing(200, "hash-nb"))],
          ["nc", makePrepared(c, 240, richIncoming("hash-nc"))],
        ]),
      );
      await session.start([a, b, c]);
      await flushMicrotasks();

      // First boundary: A is joined into B by a performed recipe.
      clock.now = 100;
      await tickOnce();
      clock.now = 199.6;
      await tickOnce();
      expect(performMock.recipes).toHaveLength(1);
      vi.advanceTimersByTime(12_000);
      await flushMicrotasks();
      expect(store.state.currentTrack?.id).toBe("nb");

      // Second boundary: walk B forward in small steps; its join is
      // considered, ripens and commits the same way — the mechanism
      // is per-pair-identical, so "only some songs" cannot recur
      // for compatible pairs.
      for (
        let step = 0;
        step < 90 && performMock.recipes.length < 2;
        step += 1
      ) {
        clock.now += 2;
        await tickOnce();
      }
      expect(performMock.recipes).toHaveLength(2);
      for (const recipe of performMock.recipes) {
        expect(BLEND_FAMILIES.has(familyOfRecipe(recipe))).toBe(true);
        expect(recipe.overlap.durationMs).toBeGreaterThan(0);
      }
      expect(session.plainCutCount).toBe(0);
      vi.advanceTimersByTime(12_000);
      await flushMicrotasks();
      expect(store.state.currentTrack?.id).toBe("nc");
      expect(brain.historySnapshot()).toHaveLength(2);
    });

    it("(b): a hung preparation at a track boundary resolves within the deadline as an announced plain cut — never a silent stall", async () => {
      const a = makeTrack("a");
      const hang = makeTrack("hang");
      const c = makeTrack("c");
      loadMock.fn.mockImplementation((track) => {
        if (track.id === "hang") {
          return new Promise<PreparedTrack | null>(() => {});
        }
        return Promise.resolve(makePrepared(track));
      });
      await session.start([a, hang, c]);
      await flushMicrotasks();
      expect(store.state.currentTrack?.id).toBe("a");

      clock.now = 31; // A ends while "hang" is still preparing
      await tickOnce();
      // The boundary does not wait on the hung fetch: within the
      // preparation deadline the walk gives up on it, and the floor
      // lands C as a plain cut — counted in public session state.
      await vi.advanceTimersByTimeAsync(46_000);
      await flushMicrotasks();
      expect(session.isRunning).toBe(true);
      expect(store.state.currentTrack?.id).toBe("c");
      expect(session.plainCutCount).toBe(1);
    });
  });
});
