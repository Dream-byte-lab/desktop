// session.test.ts — the liveRave session state machine against
// fakes for performer / supply / source / store / clock (the
// createSession factory exists for exactly this). The brain is a
// deterministic stub for the state-machine tests, and the REAL
// brain + authors for the manual-move and reachability tests.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import { visualizerTaps } from "@/features/greeting/lib/visualizerSource";
import { createBrain, type Brain, type ConsiderResult } from "./brain";
import type { TrackRead } from "./facts";
import {
  createBehaviourLog,
  createInMemoryBehaviourStore,
  createPerformanceMemory,
  type BehaviourLog,
} from "./memory";
import type { PerformerLike } from "./session";
import {
  createDefaultTrackSource,
  createPlayerAccess,
  createSession,
  PREPARING_DECISION_MS,
  PREPARING_HARD_CAP_MS,
  type LiveRaveSession,
  type PlayerAccess,
  type SessionClock,
} from "./session";
import { usePlayerStore } from "@/features/player/store/playerStore";
import type { JoinRecipe } from "./recipe";
import {
  NEUTRAL_SLIDERS,
  resolveShaping,
  SLIDER_IDS,
  type SliderId,
} from "./shaping";
import { buildFixtureRead, type FixtureSpec } from "./testFixtures";

// The authors are wrapped (not replaced) so triggerDeckMove tests
// can prove the session asks the SAME authors as the draw.
vi.mock("./authors", async (importOriginal) => {
  const original = await importOriginal<typeof import("./authors")>();
  return { ...original, authorCandidates: vi.fn(original.authorCandidates) };
});
import { authorCandidates } from "./authors";
const authorSpy = vi.mocked(authorCandidates);

// ---------------------------------------------------------------------
// Tracks, reads, recipes
// ---------------------------------------------------------------------

function makeTrack(id: string, durationMs = 240_000): Track {
  return {
    id,
    title: `Track ${id.toUpperCase()}`,
    artists: "Artist",
    coverUrl: "",
    durationMs,
    playCount: 0,
  };
}

const KEY_C = {
  tonic: 0,
  mode: "major" as const,
  camelot: "8B",
  confidence: 0.9,
};

function makeRead(overrides: Partial<TrackRead> = {}): TrackRead {
  const beatsMs: number[] = [];
  for (let b = 0; b <= 480; b += 1) beatsMs.push(b * 500);
  const downbeatsMs: number[] = [];
  for (let b = 0; b <= 480; b += 4) downbeatsMs.push(b * 500);
  const contour: { atMs: number; rms: number }[] = [];
  for (let atMs = 0; atMs < 240_000; atMs += 10_000) {
    contour.push({ atMs, rms: (atMs / 10_000) % 2 === 0 ? 0.1 : 0.3 });
  }
  return {
    audioHash: "hash-shared",
    analysisVersion: 1,
    depth: "deep",
    durationSec: 240,
    bpm: 120,
    tempoConfidence: 0.9,
    grid: { beatsMs, downbeatsMs, beatsPerBar: 4, confidence: 0.9 },
    key: KEY_C,
    sections: [
      { kind: "intro", startMs: 0, endMs: 30_000, meanEnergy: 0.08 },
      { kind: "verse", startMs: 30_000, endMs: 120_000, meanEnergy: 0.2 },
      { kind: "chorus", startMs: 120_000, endMs: 225_000, meanEnergy: 0.3 },
      { kind: "outro", startMs: 225_000, endMs: 240_000, meanEnergy: 0.1 },
    ],
    energyCurvePerSec: [],
    energyContour: contour,
    vocalActivity: [
      { startMs: 0, endMs: 240_000, activity: 0.1, confidence: 0.9 },
    ],
    drops: [],
    loudnessRms: 0.2,
    ...overrides,
  };
}

/** A read whose genuine minimum-play floor sits at 210 s. */
function floorRead(): TrackRead {
  return makeRead({
    sections: [
      { kind: "intro", startMs: 0, endMs: 10_000, meanEnergy: 0.08 },
      { kind: "verse", startMs: 10_000, endMs: 210_000, meanEnergy: 0.2 },
      { kind: "outro", startMs: 210_000, endMs: 240_000, meanEnergy: 0.1 },
    ],
  });
}

function untrustedRead(): TrackRead {
  return makeRead({
    tempoConfidence: 0.05,
    grid: {
      beatsMs: makeRead().grid.beatsMs,
      downbeatsMs: [],
      beatsPerBar: 4,
      confidence: 0.05,
    },
  });
}

function makeRecipe(
  outId: string,
  inId: string,
  overrides: Partial<JoinRecipe> = {},
): JoinRecipe {
  return {
    id: `join-${outId}-${inId}`,
    family: "blend",
    outgoing: {
      trackId: outId,
      audioHash: null,
      exitAnchorMs: 180_000,
      exitBeat: 360,
    },
    incoming: {
      trackId: inId,
      audioHash: null,
      entryAnchorMs: 0,
      entryBeat: 0,
    },
    overlapBeats: 16,
    rates: { rateA: 1, rateB: 1, beatmatched: false },
    curves: {
      gainA: [{ atBeat: 0, value: 1 }],
      gainB: [{ atBeat: 0, value: 1 }],
      eqA: {
        low: [{ atBeat: 0, value: 1 }],
        mid: [{ atBeat: 0, value: 1 }],
        high: [{ atBeat: 0, value: 1 }],
      },
      eqB: {
        low: [{ atBeat: 0, value: 1 }],
        mid: [{ atBeat: 0, value: 1 }],
        high: [{ atBeat: 0, value: 1 }],
      },
      filterA: [{ atBeat: 0, value: 20_000 }],
      filterB: [{ atBeat: 0, value: 20_000 }],
    },
    blocks: [],
    authored: {
      evidence: {
        tempoFit: 0.9,
        keyFit: 0.9,
        phraseFit: 0.8,
        structureFit: 0.8,
        energyFit: 0.8,
        vocalSafety: 0.9,
      },
      notes: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

class FakeClock implements SessionClock {
  nowMs = 1_000_000;
  private seq = 0;
  private readonly intervals = new Map<number, () => void>();
  now(): number {
    return this.nowMs;
  }
  setInterval(fn: () => void): unknown {
    const id = (this.seq += 1);
    this.intervals.set(id, fn);
    return id;
  }
  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }
  tick(times = 1): void {
    for (let i = 0; i < times; i += 1) {
      for (const fn of Array.from(this.intervals.values())) fn();
    }
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

class FakePerformer implements PerformerLike {
  onDeckEnded?: ((side: "A" | "B") => void) | undefined;
  deckTracks: Record<"A" | "B", string | null> = { A: null, B: null };
  positions: Record<"A" | "B", number> = { A: 0, B: 0 };
  playing: Record<"A" | "B", boolean> = { A: false, B: false };
  performedRecipes: JoinRecipe[] = [];
  manualLoops: {
    side: "A" | "B";
    span: { startMs: number; endMs: number } | null;
  }[] = [];
  masterGainValues: number[] = [];
  unloaded: ("A" | "B")[] = [];
  stopAllCount = 0;
  swapCount = 0;
  contextEnsureCalls = 0;

  ensureContextRunning(): void {
    this.contextEnsureCalls += 1;
  }

  loadDeck(side: "A" | "B", load: { trackId: string }): void {
    this.deckTracks[side] = load.trackId;
    this.positions[side] = 0;
    this.playing[side] = false;
  }
  unloadDeck(side: "A" | "B"): void {
    this.unloaded.push(side);
    this.deckTracks[side] = null;
    this.playing[side] = false;
  }
  playDeck(side: "A" | "B"): void {
    this.playing[side] = true;
  }
  pauseDeck(side: "A" | "B"): void {
    this.playing[side] = false;
  }
  seekTo(side: "A" | "B", ms: number): void {
    this.positions[side] = ms;
  }
  positionMs(side: "A" | "B"): number {
    return this.positions[side];
  }
  isPlaying(side: "A" | "B"): boolean {
    return this.playing[side];
  }
  snapshot(side: "A" | "B") {
    return {
      trackId: this.deckTracks[side],
      positionMs: this.positions[side],
      playing: this.playing[side],
      rate: 1,
    };
  }
  masterAnalyser(): AnalyserNode {
    return { context: { state: "running" } } as unknown as AnalyserNode;
  }
  swapRoles(): void {
    this.swapCount += 1;
    const tracks = { A: this.deckTracks.B, B: this.deckTracks.A };
    const positions = { A: this.positions.B, B: this.positions.A };
    const playing = { A: this.playing.B, B: this.playing.A };
    this.deckTracks = tracks;
    this.positions = positions;
    this.playing = playing;
  }
  async performRecipe(recipe: JoinRecipe): Promise<void> {
    this.performedRecipes.push(recipe);
    this.playing.B = true;
  }
  stopAll(): void {
    this.stopAllCount += 1;
    this.playing = { A: false, B: false };
  }
  setMasterGain(value: number): void {
    this.masterGainValues.push(value);
  }
  setManualLoop(
    side: "A" | "B",
    span: { startMs: number; endMs: number } | null,
  ): void {
    this.manualLoops.push({ side, span });
  }
  /** Test helper: the sounding deck reaches a track position. */
  setPosition(ms: number): void {
    this.positions.A = ms;
  }
}

type SourcePlan =
  | { kind: "ok" }
  | { kind: "null-audio" }
  /** Resolution never settles (fix2-0119: the hung preparation). */
  | { kind: "hang" }
  | { kind: "bufferless-then-ok"; bufferlessCalls: number }
  | { kind: "bufferless-always" };

class FakeWorld {
  readonly reads = new Map<string, TrackRead | null>();
  readonly plans = new Map<string, SourcePlan>();
  readonly sourceCalls = new Map<string, number>();
  private readonly codes = new Map<string, number>();

  private codeOf(id: string): number {
    let code = this.codes.get(id);
    if (code === undefined) {
      code = this.codes.size + 1;
      this.codes.set(id, code);
    }
    return code;
  }
  private idOfSamples(samples: Float32Array): string | null {
    const code = samples[0];
    for (const [id, value] of this.codes) if (value === code) return id;
    return null;
  }

  readonly source = {
    resolveTrackAudio: async (track: Track) => {
      const calls = (this.sourceCalls.get(track.id) ?? 0) + 1;
      this.sourceCalls.set(track.id, calls);
      const plan = this.plans.get(track.id) ?? { kind: "ok" as const };
      if (plan.kind === "null-audio") return null;
      if (plan.kind === "hang") return new Promise<never>(() => {});
      const samples = new Float32Array(8).fill(this.codeOf(track.id));
      const withBuffer =
        plan.kind === "ok" ||
        (plan.kind === "bufferless-then-ok" && calls > plan.bufferlessCalls);
      return {
        samples,
        sampleRate: 22_050,
        audioHash: `hash-${track.id}`,
        buffer: withBuffer
          ? ({ __trackId: track.id } as unknown as AudioBuffer)
          : (null as unknown as AudioBuffer),
      };
    },
  };

  readonly supply = {
    supplyRead: async (request: {
      samples: Float32Array;
      sampleRate: number;
      depth: "fast" | "deep";
    }) => {
      const id = this.idOfSamples(request.samples);
      if (!id) return null;
      const read = this.reads.get(id);
      if (read === null) return null;
      return { read: read ?? makeRead(), source: "local" as const };
    },
    supplyPair: async () => null,
  };
}

class FakePlayer implements PlayerAccess {
  private state: {
    queue: Track[];
    currentIndex: number;
    currentTrack: Track | null;
    status: string;
    repeat: "off" | "all" | "one";
    volume: number;
    positionMs: number;
    durationMs: number;
  };
  private readonly listeners = new Set<() => void>();
  /** Every playback-state publish the session made, in order. */
  readonly publishedPositions: number[] = [];
  readonly publishedDurations: number[] = [];
  readonly publishedStatuses: string[] = [];
  constructor(init: {
    queue: Track[];
    currentTrack: Track | null;
    currentIndex: number;
    repeat?: "off" | "all" | "one";
    volume?: number;
  }) {
    this.state = {
      queue: init.queue,
      currentIndex: init.currentIndex,
      currentTrack: init.currentTrack,
      status: "playing",
      repeat: init.repeat ?? "off",
      volume: init.volume ?? 0.8,
      positionMs: 0,
      durationMs: 0,
    };
  }
  getState() {
    return { ...this.state, queue: [...this.state.queue] };
  }
  setQueue(queue: Track[]): void {
    this.state.queue = queue;
    this.emit();
  }
  setCurrentTrack(track: Track | null, index: number): void {
    // Mirrors the real store: a different track resets position.
    if (this.state.currentTrack?.id !== track?.id) {
      this.state.positionMs = 0;
    }
    this.state.currentTrack = track;
    this.state.currentIndex = index;
    this.emit();
  }
  setPosition(positionMs: number): void {
    this.publishedPositions.push(positionMs);
    this.state.positionMs = positionMs;
  }
  setDuration(durationMs: number): void {
    this.publishedDurations.push(durationMs);
    this.state.durationMs = durationMs;
  }
  setStatus(status: string): void {
    this.publishedStatuses.push(status);
    this.state.status = status;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
  setRepeat(repeat: "off" | "all" | "one"): void {
    this.state.repeat = repeat;
  }
  setVolume(volume: number): void {
    this.state.volume = volume;
    this.emit();
  }
}

// ---------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------

async function flush(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

interface Harness {
  session: LiveRaveSession;
  performer: FakePerformer;
  clock: FakeClock;
  player: FakePlayer;
  world: FakeWorld;
  brain: Brain;
  behaviourLog: BehaviourLog;
  registerMasterTap: ReturnType<typeof vi.fn>;
  tracks: Track[];
}

function stubBrain(
  consider?: Brain["consider"],
  assembleSet?: Brain["assembleSet"],
): Brain {
  return {
    suitability: () => 0.8,
    consider: consider ?? ((async () => null) as unknown as Brain["consider"]),
    assembleSet:
      assembleSet ??
      (((factsList: { trackId: string }[]) => ({
        orderedIds: factsList.map((f) => f.trackId),
        joins: [],
      })) as unknown as Brain["assembleSet"]),
  } as Brain;
}

/** A stub brain that always draws the first ready option. */
function drawingBrain(): Brain {
  return stubBrain((args) => {
    const target = args.optionsB[0];
    if (!target) return null;
    const recipe = makeRecipe(args.factsA.trackId, target.trackId);
    const result: ConsiderResult = {
      trackB: target,
      recipe,
      suitability: 0.8,
      poolSize: 1,
      pool: [
        {
          trackId: target.trackId,
          family: "blend",
          fxKinds: [],
          suitability: 0.8,
          evidence: { ...recipe.authored.evidence },
        },
      ],
    };
    return result;
  });
}

function buildHarness(
  tracks: Track[],
  opts: {
    brain?: Brain;
    repeat?: "off" | "all" | "one";
    storeTrack?: Track | null;
    storeIndex?: number;
    reads?: Map<string, TrackRead | null>;
    plans?: Map<string, SourcePlan>;
    withMasterTapDep?: boolean;
  } = {},
): Harness {
  const performer = new FakePerformer();
  const clock = new FakeClock();
  const world = new FakeWorld();
  if (opts.reads) for (const [k, v] of opts.reads) world.reads.set(k, v);
  if (opts.plans) for (const [k, v] of opts.plans) world.plans.set(k, v);
  const player = new FakePlayer({
    queue: tracks,
    currentTrack: opts.storeTrack !== undefined ? opts.storeTrack : tracks[0],
    currentIndex: opts.storeIndex ?? 0,
    repeat: opts.repeat ?? "off",
  });
  const behaviourLog = createBehaviourLog(createInMemoryBehaviourStore());
  const brain = opts.brain ?? drawingBrain();
  const registerMasterTap = vi.fn();
  const session = createSession({
    createPerformer: () => performer,
    supply: world.supply as never,
    source: world.source,
    brain,
    memory: createPerformanceMemory(),
    behaviourLog,
    player,
    clock,
    ...(opts.withMasterTapDep === false
      ? {}
      : { registerMasterTap: registerMasterTap as never }),
  });
  return {
    session,
    performer,
    clock,
    player,
    world,
    brain,
    behaviourLog,
    registerMasterTap,
    tracks,
  };
}

/** Starts a harness and drives deck A into its planning horizon. */
async function startInHorizon(h: Harness): Promise<void> {
  await h.session.start(h.tracks, 0);
  await flush();
  h.performer.setPosition(200_000);
}

beforeEach(() => {
  authorSpy.mockClear();
});

// ---------------------------------------------------------------------
// Start, identity, and the full join flow
// ---------------------------------------------------------------------

describe("session start and the autonomous join flow", () => {
  it("start → consider → perform → swap, with preview and records", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks);
    const blendingNotices: boolean[] = [];
    h.session.onBlendingChange = (b) => blendingNotices.push(b);

    await h.session.start(tracks, 0);
    await flush();
    expect(h.session.isRunning).toBe(true);
    expect(h.performer.deckTracks.A).toBe("a");
    expect(h.performer.playing.A).toBe(true);
    expect(h.registerMasterTap).toHaveBeenCalledTimes(1);
    // Volume follows the player store from the first beat.
    expect(h.performer.masterGainValues).toContain(0.8);
    // Background preparation landed for the successors.
    expect(h.world.supply).toBeDefined();
    expect(h.session.setArc().upcoming.length).toBeGreaterThan(0);

    await startInHorizon(h);
    h.clock.tick();
    await flush();
    // The brain drew, the performer is performing, preview is up.
    expect(h.performer.performedRecipes).toHaveLength(1);
    expect(h.performer.performedRecipes[0].incoming.trackId).toBe("b");
    expect(h.session.blending).toBe(true);
    expect(blendingNotices).toContain(true);
    const preview = h.session.nextJoinPreview;
    expect(preview?.trackId).toBe("b");
    expect(preview?.poolSize).toBe(1);
    expect(preview?.pool).toHaveLength(1);
    expect(preview?.pool[0].evidence.tempoFit).toBe(0.9);

    // The overlap ends (position already past the grid end) — swap.
    h.clock.tick();
    await flush();
    expect(h.session.blending).toBe(false);
    expect(h.session.nextJoinPreview).toBeNull();
    expect(h.performer.deckTracks.A).toBe("b");
    expect(h.player.getState().currentTrack?.id).toBe("b");
    const log = h.behaviourLog.getBehaviourLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      family: "blend",
      pairTrackIds: ["a", "b"],
      suitability: 0.8,
      poolSize: 1,
      reason: "performed",
    });
    expect(h.session.degraded).toBe(false);
    expect(h.session.fallbackCount).toBe(0);
    const kinds = h.session.activityFeed.events().map((e) => e.kind);
    expect(kinds).toContain("started");
    expect(kinds).toContain("preparing");
    expect(kinds).toContain("authoring");
    expect(kinds).toContain("drawn");
    expect(kinds).toContain("performing");
  });

  it("registers the DJ master tap with the greeting registry by default", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, { withMasterTapDep: false });
    await h.session.start(tracks, 0);
    await flush();
    const ids = visualizerTaps.registrations().map((r) => r.id);
    expect(ids).toContain("dj-master");
  });

  it("follows the player store's volume while running", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    h.player.setVolume(0.3);
    expect(h.performer.masterGainValues.at(-1)).toBe(0.3);
  });

  it("start while running replaces the old set first", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();
    const other = [makeTrack("x"), makeTrack("y")];
    h.player.setQueue(other);
    h.player.setCurrentTrack(other[0], 0);
    await h.session.start(other, 0);
    await flush();
    expect(h.session.isRunning).toBe(true);
    expect(h.performer.deckTracks.A).toBe("x");
  });
});

describe("Note 32 — identity validation", () => {
  it("realigns the opener to the store's actual current track", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks, { storeTrack: tracks[1], storeIndex: 1 });
    await h.session.start(tracks, 0);
    await flush();
    expect(h.performer.deckTracks.A).toBe("b");
    expect(h.player.getState().currentTrack?.id).toBe("b");
    const corrected = h.session.activityFeed
      .events()
      .find((e) => e.kind === "corrected");
    expect(corrected?.text).toContain("Note 32");
  });

  it("resume after the store's track changed ends 'replaced'", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();
    h.session.pause();
    expect(h.session.isPaused).toBe(true);
    // The user picked another track in the plain player meanwhile.
    h.player.setCurrentTrack(tracks[1], 1);
    h.session.resume();
    expect(h.session.isRunning).toBe(false);
    expect(h.session.endReason).toBe("replaced");
  });

  it("resume with identity intact simply resumes", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();
    h.session.pause();
    h.session.resume();
    expect(h.session.isRunning).toBe(true);
    expect(h.session.isPaused).toBe(false);
    expect(h.performer.playing.A).toBe(true);
  });
});

describe("the minimum-play floor — binds the DJ, never the user", () => {
  it("autonomous considers wait for the floor; skipNext bypasses it", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const brain = drawingBrain();
    const considerSpy = vi.spyOn(brain, "consider");
    const h = buildHarness(tracks, {
      brain,
      reads: new Map([["a", floorRead()]]),
    });
    await h.session.start(tracks, 0);
    await flush();
    // In the horizon (remaining 40 s) but short of the 210 s floor.
    h.performer.setPosition(200_000);
    h.clock.tick();
    await flush();
    expect(considerSpy).not.toHaveBeenCalled();
    expect(h.performer.performedRecipes).toHaveLength(0);

    // The user skips anyway — floor-exempt, plain start, user-act.
    h.session.skipNext();
    await flush();
    expect(h.player.getState().currentTrack?.id).toBe("b");
    const log = h.behaviourLog.getBehaviourLog();
    expect(log.at(-1)?.reason).toBe("user-act");
  });

  it("once the floor passes, the autonomous decision proceeds", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const brain = drawingBrain();
    const considerSpy = vi.spyOn(brain, "consider");
    const h = buildHarness(tracks, {
      brain,
      reads: new Map([["a", floorRead()]]),
    });
    await h.session.start(tracks, 0);
    await flush();
    h.performer.setPosition(215_000);
    h.clock.tick();
    await flush();
    expect(considerSpy).toHaveBeenCalled();
    expect(h.performer.performedRecipes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// Buy-time
// ---------------------------------------------------------------------

describe("bufferless entries and the draw (fix2-0119)", () => {
  // These two pins REPLACE the round-1 buy-time pins. The later
  // field evidence changed the contract: a facts-but-no-buffer
  // entry must never be DRAWN (so it can never produce a
  // fallback-unprepared or a buy-time at join time) — it is
  // excluded from the draw with the reason narrated, a repair
  // re-preparation is kicked, and it joins candidacy when its
  // buffer lands. Buy-time remains only as the commit-time
  // safety net. Outcomes preserved: the join still performs,
  // and a permanently bufferless track is simply never joined
  // into — the set plays on through the joinable pool.
  it("excludes the bufferless entry, repairs it, then performs the join when its buffer lands", async () => {
    // B is the ONLY candidate this window, so the window cannot
    // be satisfied by anyone else: exclusion first, then — once
    // the repair lands the buffer — the draw performs into B.
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, {
      plans: new Map([
        ["b", { kind: "bufferless-then-ok", bufferlessCalls: 1 }],
      ]),
    });
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    // The exclusion was narrated; buy-time never engaged (no
    // loop was set) and nothing was recorded as a fallback.
    const events = h.session.activityFeed.events();
    expect(events.some((e) => e.text.includes("not decoded yet"))).toBe(true);
    expect(events.map((e) => e.kind)).not.toContain("buy-time");
    expect(h.performer.manualLoops).toHaveLength(0);
    expect(h.session.fallbackCount).toBe(0);
    // The repair re-preparation landed the buffer; the next
    // decision draws B and the join performs.
    h.clock.tick();
    await flush();
    h.clock.tick();
    await flush();
    expect(h.performer.performedRecipes).toHaveLength(1);
    expect(h.performer.performedRecipes[0].incoming.trackId).toBe("b");
    const log = h.behaviourLog.getBehaviourLog();
    expect(log.at(-1)?.reason).toBe("performed");
    expect(h.session.fallbackCount).toBe(0);
  });

  it("a permanently bufferless track is never joined into — the draw performs through the joinable pool", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks, {
      plans: new Map([["b", { kind: "bufferless-always" }]]),
    });
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    // B's exclusion is narrated; the window's draw runs over the
    // joinable pool (C) and performs — no fallback, no buy-time,
    // no plain cut.
    expect(
      h.session.activityFeed
        .events()
        .some((e) => e.text.includes("not decoded yet")),
    ).toBe(true);
    h.clock.tick();
    await flush();
    expect(h.performer.performedRecipes).toHaveLength(1);
    expect(h.performer.performedRecipes[0].incoming.trackId).toBe("c");
    const log = h.behaviourLog.getBehaviourLog();
    expect(log.at(-1)?.reason).toBe("performed");
    expect(h.session.fallbackCount).toBe(0);
    expect(h.session.activityFeed.events().map((e) => e.kind)).not.toContain(
      "buy-time",
    );
  });
});

// ---------------------------------------------------------------------
// Fallbacks, degradation, exhaustion
// ---------------------------------------------------------------------

describe("fallbacks and degradation honesty", () => {
  it("deck-end with nothing committed is a recorded plain cut", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, { brain: stubBrain(() => null) });
    await h.session.start(tracks, 0);
    await flush();
    h.performer.setPosition(239_999);
    h.clock.tick();
    await flush();
    expect(h.player.getState().currentTrack?.id).toBe("b");
    expect(h.behaviourLog.getBehaviourLog().at(-1)?.reason).toBe(
      "fallback-unprepared",
    );
    expect(h.session.fallbackCount).toBe(1);
  });

  it("an invalid drawn recipe re-draws once, then plain-cuts fallback-invalid", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    let calls = 0;
    const brain = stubBrain((args) => {
      calls += 1;
      if (calls === 1) {
        const target = args.optionsB[0];
        return {
          trackB: target,
          recipe: makeRecipe(args.factsA.trackId, target.trackId, {
            rates: { rateA: 3, rateB: 1, beatmatched: false },
          }),
          suitability: 0.8,
          poolSize: 1,
          pool: [],
        } as ConsiderResult;
      }
      return null;
    });
    const h = buildHarness(tracks, { brain });
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    expect(calls).toBe(2); // the original draw + exactly one re-draw
    const log = h.behaviourLog.getBehaviourLog();
    expect(log.at(-1)?.reason).toBe("fallback-invalid");
    expect(h.session.fallbackCount).toBe(1);
    expect(h.performer.performedRecipes).toHaveLength(0);
  });

  it("a valid re-draw after an invalid first draw performs normally", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    let calls = 0;
    const brain = stubBrain((args) => {
      calls += 1;
      const target = args.optionsB[0];
      if (!target) return null;
      return {
        trackB: target,
        recipe:
          calls === 1
            ? makeRecipe(args.factsA.trackId, target.trackId, {
                rates: { rateA: 3, rateB: 1, beatmatched: false },
              })
            : makeRecipe(args.factsA.trackId, target.trackId),
        suitability: 0.8,
        poolSize: 1,
        pool: [],
      } as ConsiderResult;
    });
    const h = buildHarness(tracks, { brain });
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    expect(calls).toBe(2);
    expect(h.performer.performedRecipes).toHaveLength(1);
    expect(h.performer.performedRecipes[0].incoming.trackId).toBe("c");
    expect(h.session.fallbackCount).toBe(0);
  });

  it("an untrusted pair performs but records degraded-untrusted", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, {
      reads: new Map([["b", untrustedRead()]]),
    });
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    h.clock.tick();
    await flush();
    const log = h.behaviourLog.getBehaviourLog();
    expect(log.at(-1)?.reason).toBe("degraded-untrusted");
    expect(h.session.degraded).toBe(true);
    expect(
      h.session.activityFeed.events().some((e) => e.kind === "degraded"),
    ).toBe(true);
  });

  it("reason precedence: a fallback outranks degradation on the same record", async () => {
    // B is untrusted AND its recipe is invalid: the record must be
    // the fallback, not the degradation.
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    let calls = 0;
    const brain = stubBrain((args) => {
      calls += 1;
      if (calls > 1) return null;
      const target = args.optionsB[0];
      return {
        trackB: target,
        recipe: makeRecipe(args.factsA.trackId, target.trackId, {
          rates: { rateA: 3, rateB: 1, beatmatched: false },
        }),
        suitability: 0.8,
        poolSize: 1,
        pool: [],
      } as ConsiderResult;
    });
    const h = buildHarness(tracks, {
      brain,
      reads: new Map([["b", untrustedRead()]]),
    });
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    expect(h.behaviourLog.getBehaviourLog().at(-1)?.reason).toBe(
      "fallback-invalid",
    );
  });
});

describe("exhaustion follows the repeat setting (Addendum B)", () => {
  async function playToLastTrackEnd(h: Harness): Promise<void> {
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    h.clock.tick(); // complete the join into B
    await flush();
    expect(h.player.getState().currentTrack?.id).toBe("b");
  }

  it("repeat off: the set ends queue-exhausted with a set-end record", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const brain = drawingBrain();
    const h = buildHarness(tracks, { brain });
    await playToLastTrackEnd(h);
    // Brain now finds nothing (no unplayed options are passed, but
    // the deck end is what ends the night).
    h.performer.setPosition(239_999);
    h.clock.tick();
    await flush();
    expect(h.session.isRunning).toBe(false);
    expect(h.session.endReason).toBe("queue-exhausted");
    const reasons = h.behaviourLog.getBehaviourLog().map((r) => r.reason);
    expect(reasons).toContain("set-end");
  });

  it("repeat all: the queue cycles and the set continues", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, { repeat: "all" });
    await playToLastTrackEnd(h);
    h.performer.setPosition(239_999);
    h.clock.tick();
    await flush();
    expect(h.session.isRunning).toBe(true);
    expect(h.session.endReason).toBeNull();
    // A is upcoming again: drive B into its horizon and join back.
    h.performer.setPosition(200_000);
    h.clock.tick();
    await flush();
    expect(h.performer.performedRecipes.at(-1)?.incoming.trackId).toBe("a");
  });

  it("repeat one: the session declines to start", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, { repeat: "one" });
    await h.session.start(tracks, 0);
    await flush();
    expect(h.session.isRunning).toBe(false);
    expect(h.performer.deckTracks.A).toBeNull();
    const texts = h.session.activityFeed.events().map((e) => e.text);
    expect(texts.some((t) => t.includes("repeat-one"))).toBe(true);
  });

  it("no playable track at all ends start-no-playable", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, {
      plans: new Map([
        ["a", { kind: "null-audio" }],
        ["b", { kind: "null-audio" }],
      ]),
    });
    const notices: boolean[] = [];
    h.session.onRunningChange = (r) => notices.push(r);
    await h.session.start(tracks, 0);
    await flush();
    expect(h.session.isRunning).toBe(false);
    expect(h.session.endReason).toBe("start-no-playable");
    expect(notices).toContain(false);
  });
});

// ---------------------------------------------------------------------
// Cold start (fix-0119): press DJ on a fresh store, plain player
// playing — the session must go live and mix, not die at a gate
// ---------------------------------------------------------------------

describe("cold start: the preparing phase and takeover (fix-0119)", () => {
  it("press DJ on a cold queue → session live in preparing → decks take over → a real join is performed", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks, { brain: drawingBrain() });

    await h.session.start(tracks, 0);
    // Live from the press, in the preparing phase: ON AIR state
    // reached, decks not yet taken over, no failure recorded.
    expect(h.session.isRunning).toBe(true);
    expect(h.session.preparing).toBe(true);
    expect(h.session.startState).toBe("starting");
    expect(h.session.startFailure).toBeNull();
    expect(h.performer.deckTracks.A).toBeNull();

    // Preparation lands → takeover on the current track.
    await flush();
    expect(h.session.preparing).toBe(false);
    expect(h.session.startState).toBe("ready");
    expect(h.performer.deckTracks.A).toBe("a");
    expect(h.performer.playing.A).toBe(true);

    // Into the horizon: the brain draws and the performer
    // performs a real technique join into B — not a plain cut.
    h.performer.setPosition(200_000);
    h.clock.tick();
    await flush();
    expect(h.performer.performedRecipes).toHaveLength(1);
    expect(h.performer.performedRecipes[0].incoming.trackId).toBe("b");
    expect(h.session.blending).toBe(true);

    // The overlap completes: the set is on B, performed.
    h.clock.tick();
    await flush();
    expect(h.player.getState().currentTrack?.id).toBe("b");
    const log = h.behaviourLog.getBehaviourLog();
    expect(log.at(-1)).toMatchObject({
      family: "blend",
      pairTrackIds: ["a", "b"],
      reason: "performed",
    });
    expect(h.session.fallbackCount).toBe(0);
  });

  it("a mid-track takeover keeps the audible position the plain player had reached", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    // The plain player is 30 s into A (its published position).
    h.player.setPosition(30_000);
    await h.session.start(tracks, 0);
    await flush();
    expect(h.performer.deckTracks.A).toBe("a");
    expect(h.performer.positions.A).toBe(30_000);
  });

  it("every preparation failing ends start-no-playable with the first failure reason on the visible seam", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, {
      plans: new Map([
        ["a", { kind: "null-audio" }],
        ["b", { kind: "null-audio" }],
      ]),
    });
    const notices: boolean[] = [];
    h.session.onRunningChange = (r) => notices.push(r);
    await h.session.start(tracks, 0);
    // (The fake's preparations fail within the await's
    // microtasks, so the mid-attempt state is not asserted here —
    // the first cold-start test pins the visible preparing phase
    // with preparations that take real hops.)
    await flush();
    expect(h.session.isRunning).toBe(false);
    expect(h.session.endReason).toBe("start-no-playable");
    expect(h.session.startState).toBe("failed");
    // The engine's own recorded reason, verbatim — not invented.
    expect(h.session.startFailure).toBe(
      "audio could not be resolved or decoded",
    );
    // The running-change notice fired both ways, so the intent
    // wiring arms its track-change retry on this end.
    expect(notices).toContain(true);
    expect(notices.at(-1)).toBe(false);
  });

  it("one unresolvable track does not kill the set: the boundary takeover lands on the next track and joins proceed", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks, {
      brain: drawingBrain(),
      plans: new Map([["a", { kind: "null-audio" }]]),
    });
    await h.session.start(tracks, 0);
    await flush();
    // A failed, B prepared, the plain player still on A: the set
    // stays live in preparing — not failed, not dead.
    expect(h.session.isRunning).toBe(true);
    expect(h.session.preparing).toBe(true);
    expect(h.session.startState).toBe("starting");

    // The plain player reaches B: boundary takeover.
    h.player.setCurrentTrack(tracks[1], 1);
    h.clock.tick();
    await flush();
    expect(h.session.preparing).toBe(false);
    expect(h.session.startState).toBe("ready");
    expect(h.performer.deckTracks.A).toBe("b");
    expect(h.performer.playing.A).toBe(true);

    // And the set mixes onward from B into C.
    h.performer.setPosition(200_000);
    h.clock.tick();
    await flush();
    expect(h.performer.performedRecipes).toHaveLength(1);
    expect(h.performer.performedRecipes[0].incoming.trackId).toBe("c");
  });

  it("the default track source resolves audio before any session exists — the decode context is created on first need", async () => {
    // The shipped cold-start killer: the source's context came
    // from a performer that only a successful start created, so
    // preparation returned null for every track, forever. The
    // factory's ensurePerformer must be callable — and called —
    // by preparation itself.
    let ensureCalls = 0;
    const fakeContext = {
      decodeAudioData: async (_data: ArrayBuffer) => ({
        length: 8,
        sampleRate: 22_050,
        numberOfChannels: 1,
        duration: 1,
        getChannelData: () => new Float32Array(8).fill(0.25),
      }),
    };
    const source = createDefaultTrackSource(
      () => {
        ensureCalls += 1;
        return {
          masterAnalyser: () => ({ context: fakeContext }),
        } as unknown as PerformerLike;
      },
      {
        fetchBytes: async () => new ArrayBuffer(16),
        recordAttribution: () => {},
      },
    );
    const audio = await source.resolveTrackAudio(makeTrack("a"));
    expect(audio).not.toBeNull();
    expect(audio?.buffer).toBeTruthy();
    expect(ensureCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------
// User acts and the seek simplification
// ---------------------------------------------------------------------

describe("user acts", () => {
  it("skipNext with a committed join performs it immediately, recorded user-act", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks);
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    expect(h.session.blending).toBe(true);
    h.session.skipNext();
    await flush();
    expect(h.player.getState().currentTrack?.id).toBe("b");
    expect(h.session.blending).toBe(false);
    expect(h.behaviourLog.getBehaviourLog().at(-1)?.reason).toBe("user-act");
  });

  it("skipPrevious plain-starts the previously played track", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks);
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    h.clock.tick(); // join into B completes
    await flush();
    expect(h.player.getState().currentTrack?.id).toBe("b");
    h.session.skipPrevious();
    await flush();
    expect(h.player.getState().currentTrack?.id).toBe("a");
    expect(h.behaviourLog.getBehaviourLog().at(-1)?.reason).toBe("user-act");
  });

  it("seek during a sounding join cancels the incoming deck (named simplification)", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks);
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    expect(h.session.blending).toBe(true);
    h.session.seekTo(5_000);
    expect(h.session.blending).toBe(false);
    expect(h.session.nextJoinPreview).toBeNull();
    expect(h.performer.unloaded).toContain("B");
    expect(h.performer.positions.A).toBe(5_000);
    expect(h.player.getState().currentTrack?.id).toBe("a");
    const texts = h.session.activityFeed.events().map((e) => e.text);
    expect(
      texts.some((t) => t.includes("Seek cancelled the sounding join")),
    ).toBe(true);
  });

  it("stop ends the set with the given reason and total silence", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    const notices: boolean[] = [];
    h.session.onRunningChange = (r) => notices.push(r);
    await h.session.start(tracks, 0);
    await flush();
    h.session.stop();
    expect(h.session.isRunning).toBe(false);
    expect(h.session.endReason).toBe("user-stop");
    expect(h.performer.stopAllCount).toBeGreaterThan(0);
    expect(notices).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------
// Curation
// ---------------------------------------------------------------------

describe("curateRemaining — honest refusals, real reordering", () => {
  it("refuses with not-enough-ready when fewer than two upcoming are ready", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();
    await expect(h.session.curateRemaining()).resolves.toEqual({
      ok: false,
      reason: "not-enough-ready",
    });
  });

  it("refuses with join-locked while a join is sounding", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks);
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    expect(h.session.blending).toBe(true);
    await expect(h.session.curateRemaining()).resolves.toEqual({
      ok: false,
      reason: "join-locked",
    });
  });

  it("applies the assembled order to the session and the player queue", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const brain = stubBrain(undefined, (factsList) => ({
      orderedIds: [
        factsList[0].trackId,
        ...factsList
          .slice(1)
          .map((f) => f.trackId)
          .reverse(),
      ],
      joins: [],
    }));
    // drawing consider + reversing assemble
    const drawing = drawingBrain();
    brain.consider = drawing.consider;
    const h = buildHarness(tracks, { brain });
    await h.session.start(tracks, 0);
    await flush();
    await expect(h.session.curateRemaining()).resolves.toEqual({ ok: true });
    expect(h.player.getState().queue.map((t) => t.id)).toEqual(["a", "c", "b"]);
    expect(h.player.getState().currentTrack?.id).toBe("a");
    // The next autonomous decision now draws C first.
    h.performer.setPosition(200_000);
    h.clock.tick();
    await flush();
    expect(h.performer.performedRecipes.at(-1)?.incoming.trackId).toBe("c");
  });
});

// ---------------------------------------------------------------------
// triggerDeckMove — the same authors, bypassing draw + floor only
// ---------------------------------------------------------------------

const scratchSpecA: FixtureSpec = {
  bpm: 124,
  totalBeats: 512,
  key: KEY_C,
  tempoConfidence: 0.8,
  gridConfidence: 0.85,
  sections: [
    { kind: "intro", fromBeat: 0, toBeat: 32, energy: 0.07 },
    { kind: "verse", fromBeat: 32, toBeat: 128, energy: 0.2 },
    { kind: "chorus", fromBeat: 128, toBeat: 256, energy: 0.34 },
    { kind: "breakdown", fromBeat: 256, toBeat: 320, energy: 0.1 },
    { kind: "chorus", fromBeat: 320, toBeat: 448, energy: 0.34 },
    { kind: "outro", fromBeat: 448, toBeat: 512, energy: 0.13 },
  ],
  drops: [{ atBeat: 128, strength: 2.2 }],
  vocalAtBeat: (b) => (b < 32 ? 0.08 : b < 448 ? 0.5 : 0.08),
  transientZones: [
    [0, 32],
    [448, 512],
  ],
};

const scratchSpecB: FixtureSpec = {
  ...scratchSpecA,
  key: { tonic: 7, mode: "major", camelot: "9B", confidence: 0.9 },
  vocalAtBeat: (b) => (b < 32 ? 0.08 : b < 448 ? 0.5 : 0.08),
};

const vocalSpecB: FixtureSpec = {
  ...scratchSpecB,
  vocalAtBeat: () => 0.85,
  transientZones: [],
};

function fixtureHarness(specB: FixtureSpec): Harness {
  const readA = buildFixtureRead(scratchSpecA);
  const readB = buildFixtureRead(specB);
  const a = makeTrack("a", Math.round(readA.durationSec * 1000));
  const b = makeTrack("b", Math.round(readB.durationSec * 1000));
  return buildHarness([a, b], {
    brain: createBrain({ rng: () => 0.42 }),
    reads: new Map([
      ["a", readA],
      ["b", readB],
    ]),
  });
}

describe("triggerDeckMove", () => {
  it("authors through authorCandidates (spy) and records user-act", async () => {
    const h = fixtureHarness(scratchSpecB);
    await h.session.start(h.tracks, 0);
    await flush();
    const result = await h.session.triggerDeckMove({ kind: "scratch-in" });
    expect(authorSpy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.recipe.family).toBe("scratch-in");
    expect(h.performer.performedRecipes.at(-1)?.family).toBe("scratch-in");
    // Complete the move: the record lands as a user act.
    h.performer.setPosition(10_000_000);
    h.clock.tick();
    await flush();
    const log = h.behaviourLog.getBehaviourLog();
    expect(log.at(-1)?.reason).toBe("user-act");
    expect(log.at(-1)?.family).toBe("scratch-in");
  });

  it("filters by technique when one is named", async () => {
    const h = fixtureHarness(scratchSpecB);
    await h.session.start(h.tracks, 0);
    await flush();
    const result = await h.session.triggerDeckMove({
      kind: "scratch-in",
      technique: "baby",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.recipe.technique).toBe("baby");
  });

  it("returns the authors' rejection reasons when no candidate exists", async () => {
    const h = fixtureHarness(vocalSpecB);
    await h.session.start(h.tracks, 0);
    await flush();
    const result = await h.session.triggerDeckMove({ kind: "scratch-in" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).toMatch(/vocal|witnessed/i);
    }
    expect(h.performer.performedRecipes).toHaveLength(0);
  });

  it("refuses honestly when no session is running", async () => {
    const h = fixtureHarness(scratchSpecB);
    const result = await h.session.triggerDeckMove({ kind: "stop-exit" });
    expect(result).toEqual({ ok: false, reason: "no session is running" });
  });
});

// ---------------------------------------------------------------------
// The party seam at session level
// ---------------------------------------------------------------------

describe("party seam", () => {
  it("schedules a fitting request, spaces guests, and refuses absolutely", async () => {
    const tracks = [
      makeTrack("a"),
      makeTrack("x"),
      makeTrack("g1"),
      makeTrack("g2"),
    ];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();

    const first = h.session.submitGuestRequest(tracks[2], "guest-1");
    expect(first.votes).toBe(1);
    expect(h.session.guestStatus("g1")).toBe("scheduled");
    h.session.submitGuestRequest(tracks[3], "guest-2");
    // Only one host track (x) separates guests: g1 takes the
    // trailing slot, g2 must wait rather than sit back-to-back.
    expect(h.session.guestStatus("g1")).toBe("scheduled");
    expect(h.session.guestStatus("g2")).toBe("waiting");
    expect(h.session.liveRaveOpenRequests).toHaveLength(2);

    // Do-not-play is absolute — it un-schedules a scheduled track.
    h.session.setDoNotPlay(["g1"]);
    expect(h.session.guestStatus("g1")).toBe("not-tonight");
    expect(h.session.liveRaveOpenRequests.map((r) => r.track.id)).toEqual([
      "g2",
    ]);

    // Already-played is absolute too.
    h.session.submitGuestRequest(tracks[0], "guest-3");
    expect(h.session.guestStatus("a")).toBe("not-tonight");
  });

  it("votes accumulate by distinct guests through the session seam", async () => {
    const tracks = [makeTrack("a"), makeTrack("x"), makeTrack("g1")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();
    h.session.submitGuestRequest(tracks[2], "guest-1");
    h.session.submitGuestRequest(tracks[2], "guest-1");
    const third = h.session.submitGuestRequest(tracks[2], "guest-2");
    expect(third.votes).toBe(2);
  });
});

// ---------------------------------------------------------------------
// Playback-state publishing — the session is the producer of the
// player store's position / duration / status while a set plays
// (mediaClock's contract: it reads exactly these fields, keyed off
// the session's 250 ms tick). These tests assert at the
// PlayerAccess seam with the fake, plus one integration test
// against the REAL player store below.
// ---------------------------------------------------------------------

describe("playback-state publishing", () => {
  it("start publishes playing + the opener's duration; a tick publishes the sounding deck's position + duration", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();
    expect(h.player.publishedStatuses.at(-1)).toBe("playing");
    expect(h.player.getState().status).toBe("playing");
    expect(h.player.publishedDurations.at(-1)).toBe(240_000);
    expect(h.player.getState().durationMs).toBe(240_000);
    expect(h.player.publishedPositions.at(-1)).toBe(0);

    h.performer.setPosition(12_345);
    h.clock.tick();
    await flush();
    expect(h.player.publishedPositions.at(-1)).toBe(12_345);
    expect(h.player.getState().positionMs).toBe(12_345);
    expect(h.player.publishedDurations.at(-1)).toBe(240_000);
  });

  it("pause publishes the frozen position + paused; resume publishes playing", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();
    h.performer.setPosition(50_000);
    h.session.pause();
    expect(h.player.publishedStatuses.at(-1)).toBe("paused");
    expect(h.player.getState().status).toBe("paused");
    expect(h.player.publishedPositions.at(-1)).toBe(50_000);

    h.session.resume();
    expect(h.player.publishedStatuses.at(-1)).toBe("playing");
    expect(h.player.getState().status).toBe("playing");
    expect(h.player.publishedPositions.at(-1)).toBe(50_000);
  });

  it("a performed join's swap moves publication to the incoming deck/track", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks);
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    expect(h.session.blending).toBe(true);
    expect(h.player.getState().currentTrack?.id).toBe("a");
    // The incoming deck is already 8 s into track B by the overlap;
    // the outgoing deck is at 200 s when the swap lands.
    h.performer.positions.B = 8_000;
    h.clock.tick();
    await flush();
    expect(h.player.getState().currentTrack?.id).toBe("b");
    // Just before the swap the tick published the OUTGOING deck
    // (the store's current track was still A)…
    expect(h.player.publishedPositions.at(-2)).toBe(200_000);
    // …and the swap's own publish is the INCOMING deck's position —
    // not the 0 setCurrentTrack reset it to, and not A's 200 s.
    expect(h.player.publishedPositions.at(-1)).toBe(8_000);
    expect(h.player.getState().positionMs).toBe(8_000);
    expect(h.player.publishedDurations.at(-1)).toBe(240_000);
    expect(h.player.publishedStatuses.at(-1)).toBe("playing");
  });

  it("stop publishes a settled state: the final position/duration and paused", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();
    h.performer.setPosition(33_000);
    h.clock.tick();
    await flush();
    h.session.stop();
    expect(h.session.isRunning).toBe(false);
    expect(h.player.publishedPositions.at(-1)).toBe(33_000);
    expect(h.player.publishedDurations.at(-1)).toBe(240_000);
    expect(h.player.publishedStatuses.at(-1)).toBe("paused");
    expect(h.player.getState().status).toBe("paused");
    // The store keeps the track the set ended on, at the position
    // the set actually reached.
    expect(h.player.getState().currentTrack?.id).toBe("a");
    expect(h.player.getState().positionMs).toBe(33_000);
  });

  it("a declined start publishes nothing (the plain player's state is not clobbered)", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, { repeat: "one" });
    await h.session.start(tracks, 0);
    await flush();
    expect(h.session.isRunning).toBe(false);
    expect(h.player.publishedPositions).toEqual([]);
    expect(h.player.publishedDurations).toEqual([]);
    expect(h.player.publishedStatuses).toEqual([]);
  });
});

describe("playback publishing against the real player store", () => {
  it("a factory session over createPlayerAccess drives usePlayerStore's position/duration/status", async () => {
    // The unmocked producer seam: real session + the real
    // PlayerAccess adapter + the real store mediaClock, MiniPlayer
    // and FocusMode read. mediaClock's own read of these fields is
    // covered in mediaClock.test.ts — but there its session
    // liveness is mocked, because the clock keys off the
    // liveRaveSession singleton, whose real dependencies
    // (AudioContext decode, network supply) cannot run in this
    // environment. A factory session is not that singleton, so the
    // clock cannot be driven end-to-end here; what CAN be asserted
    // unmocked is exactly the half that was missing: the producer
    // writing the real store.
    const tracks = [makeTrack("a"), makeTrack("b")];
    usePlayerStore.setState({
      queue: tracks,
      currentTrack: tracks[0],
      currentIndex: 0,
      status: "paused",
      positionMs: 999,
      durationMs: 111,
      repeat: "off",
      volume: 0.8,
    });
    const performer = new FakePerformer();
    const clock = new FakeClock();
    const world = new FakeWorld();
    const session = createSession({
      createPerformer: () => performer,
      supply: world.supply as never,
      source: world.source,
      brain: drawingBrain(),
      memory: createPerformanceMemory(),
      behaviourLog: createBehaviourLog(createInMemoryBehaviourStore()),
      player: createPlayerAccess(),
      clock,
      registerMasterTap: (() => {}) as never,
    });
    try {
      await session.start(tracks, 0);
      await flush();
      expect(usePlayerStore.getState().status).toBe("playing");
      expect(usePlayerStore.getState().durationMs).toBe(240_000);
      // The deck's position, not the 999 the store was left with.
      expect(usePlayerStore.getState().positionMs).toBe(0);

      performer.setPosition(42_000);
      clock.tick();
      await flush();
      expect(usePlayerStore.getState().positionMs).toBe(42_000);

      session.pause();
      expect(usePlayerStore.getState().status).toBe("paused");
      session.resume();
      expect(usePlayerStore.getState().status).toBe("playing");
      session.stop();
      expect(usePlayerStore.getState().status).toBe("paused");
      expect(usePlayerStore.getState().positionMs).toBe(42_000);
    } finally {
      if (session.isRunning) session.stop();
      usePlayerStore.setState({
        queue: [],
        currentTrack: null,
        currentIndex: -1,
        status: "idle",
        positionMs: 0,
        durationMs: 0,
      });
    }
  });
});

// ---------------------------------------------------------------------
// Stage snapshot + arc (the §10 visibility seams)
// ---------------------------------------------------------------------

describe("visibility seams", () => {
  it("stageSnapshot reports decks, the current move, and control level", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks);
    expect(h.session.stageSnapshot()).toBeNull();
    await startInHorizon(h);
    const idle = h.session.stageSnapshot();
    expect(idle?.decks[0].trackId).toBe("a");
    expect(idle?.controlLevel).toBe("autonomous");
    // The loaded deck carries its measured facts summary; the
    // unloaded deck honestly carries none.
    expect(idle?.decks[0].facts).toMatchObject({
      bpm: 120,
      keyCamelot: "8B",
      beatmatchTrusted: true,
    });
    expect(idle?.decks[0].facts?.energyContour.length).toBeGreaterThan(0);
    expect(typeof idle?.decks[0].facts?.energyNow).toBe("number");
    expect(idle?.decks[1].facts).toBeNull();
    h.clock.tick();
    await flush();
    const blending = h.session.stageSnapshot();
    expect(blending?.currentMove?.family).toBe("blend");
    expect(blending?.currentMove?.label).toContain("Track B");
    h.session.setControlLevel("assisted");
    expect(h.session.stageSnapshot()?.controlLevel).toBe("assisted");
    h.session.setControlLevel("bogus" as never);
    expect(h.session.controlLevel).toBe("assisted");
  });

  it("setArc reports played and upcoming energies from real facts", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();
    const arc = h.session.setArc();
    expect(arc.played).toHaveLength(1);
    expect(arc.upcoming.length).toBeGreaterThanOrEqual(1);
    for (const value of [...arc.played, ...arc.upcoming]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("activity feed subscribers receive events as they happen", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    const seen: string[] = [];
    const unsubscribe = h.session.activityFeed.subscribe((e) =>
      seen.push(e.kind),
    );
    await h.session.start(tracks, 0);
    // Fix-0119: the start's first live event is the preparing
    // phase itself; "started" lands with the takeover, once the
    // opener's preparation resolves.
    expect(seen).toContain("preparing");
    await flush();
    expect(seen).toContain("started");
    unsubscribe();
    h.session.stop();
    expect(seen).not.toContain("ended");
    expect(h.session.activityFeed.latest()?.kind).toBe("ended");
  });
});

// ---------------------------------------------------------------------
// Bounded preparing (fix2-0119): a preparation that never settles
// must not hold the phase open forever
// ---------------------------------------------------------------------

describe("bounded preparing (fix2-0119)", () => {
  it("a preparation that never settles cannot block the give-up: no prospect → visible failure at the decision bound", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, {
      plans: new Map([
        ["a", { kind: "hang" }],
        ["b", { kind: "hang" }],
      ]),
    });
    const notices: boolean[] = [];
    h.session.onRunningChange = (r) => notices.push(r);
    await h.session.start(tracks, 0);
    await flush();
    expect(h.session.isRunning).toBe(true);
    expect(h.session.preparing).toBe(true);

    // Just inside the bound: still deciding, nothing ended.
    h.clock.advance(PREPARING_DECISION_MS - 1);
    h.clock.tick();
    expect(h.session.isRunning).toBe(true);
    expect(h.session.preparing).toBe(true);

    // At the bound the phase ends — even though both
    // preparations are STILL in flight (they never settle, so
    // the settled-failures give-up could never fire). The
    // failure names the truth: preparation did not finish.
    h.clock.advance(1);
    h.clock.tick();
    expect(h.session.isRunning).toBe(false);
    expect(h.session.endReason).toBe("start-no-playable");
    expect(h.session.startState).toBe("failed");
    expect(h.session.startFailure).toBe(
      'preparation of "Track A" did not finish in time',
    );
    expect(notices.at(-1)).toBe(false);
  });

  it("a hung opener with a prepared later track still takes over at the boundary — a prospect holds the phase past the decision bound", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks, {
      brain: drawingBrain(),
      plans: new Map([["a", { kind: "hang" }]]),
    });
    await h.session.start(tracks, 0);
    await flush();
    expect(h.session.preparing).toBe(true);

    // Past the decision bound: B and C are prepared with
    // buffers — a takeover prospect exists — so the phase does
    // NOT fail; the boundary remains the road in.
    h.clock.advance(PREPARING_DECISION_MS + 1_000);
    h.clock.tick();
    await flush();
    expect(h.session.isRunning).toBe(true);
    expect(h.session.preparing).toBe(true);
    expect(h.session.startState).toBe("starting");

    // The plain player reaches B: boundary takeover, exactly
    // the round-1 behaviour for a track that never prepares.
    h.player.setCurrentTrack(tracks[1], 1);
    h.clock.tick();
    await flush();
    expect(h.session.preparing).toBe(false);
    expect(h.session.startState).toBe("ready");
    expect(h.performer.deckTracks.A).toBe("b");
    expect(h.performer.playing.A).toBe(true);
  });

  it("even with a prospect, the hard cap ends a preparing phase whose boundary never arrives", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks, {
      plans: new Map([["a", { kind: "hang" }]]),
    });
    await h.session.start(tracks, 0);
    await flush();
    expect(h.session.preparing).toBe(true);

    h.clock.advance(PREPARING_HARD_CAP_MS);
    h.clock.tick();
    expect(h.session.isRunning).toBe(false);
    expect(h.session.startState).toBe("failed");
    expect(h.session.startFailure).toBe(
      "no prepared track was reached in time",
    );
  });
});

// ---------------------------------------------------------------------
// Regression pins (fix2-0119): the healthy path is unchanged —
// the pool is a decision-window artefact, deck B loads only
// when a join executes
// ---------------------------------------------------------------------

describe("healthy path unchanged (fix2-0119 regression pins)", () => {
  it("pool and deck B stay empty until the decision window; the draw fills the preview and the join loads B", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks, { brain: drawingBrain() });
    await h.session.start(tracks, 0);
    await flush();
    // Live on A, mid-track: no preview, no pool, deck B empty —
    // by design, and unchanged by the fix2 bounds.
    expect(h.session.preparing).toBe(false);
    expect(h.session.nextJoinPreview).toBeNull();
    expect(h.performer.deckTracks.B).toBeNull();

    // Into the horizon: the brain draws, the preview names the
    // pool, and the performed join is what loads deck B.
    h.performer.setPosition(200_000);
    h.clock.tick();
    await flush();
    expect(h.performer.performedRecipes).toHaveLength(1);
    expect(h.performer.performedRecipes[0].incoming.trackId).toBe("b");
    expect(h.performer.deckTracks.B).toBe("b");
    expect(h.session.nextJoinPreview?.pool.length).toBeGreaterThan(0);
    expect(h.session.fallbackCount).toBe(0);
  });
});

// ---------------------------------------------------------------------
// Performer context recovery (fix2-0119): the session checks the
// performer's context at start, takeover and resume
// ---------------------------------------------------------------------

describe("performer context recovery (fix2-0119)", () => {
  it("the session asks the performer to run its context at start, at takeover and on resume", async () => {
    const tracks = [makeTrack("a"), makeTrack("b")];
    const h = buildHarness(tracks);
    await h.session.start(tracks, 0);
    await flush();
    // Start checked once; the takeover checked again.
    expect(h.performer.contextEnsureCalls).toBeGreaterThanOrEqual(2);
    const afterTakeover = h.performer.contextEnsureCalls;
    h.session.pause();
    h.session.resume();
    expect(h.performer.contextEnsureCalls).toBeGreaterThan(afterTakeover);
  });
});

// ---------------------------------------------------------------------
// Plain-element discipline (fix2-0119): the preparing-phase
// pause silences BOTH elements, so the resume must restart the
// element actually carrying the song — whichever one that is
// ---------------------------------------------------------------------

describe("createPlayerAccess — plain element discipline (fix2-0119)", () => {
  function installPlainElements() {
    const a = document.createElement("audio");
    a.id = "liner-audio";
    const b = document.createElement("audio");
    b.id = "liner-audio-b";
    document.body.append(a, b);
    const plays = {
      a: vi.fn(() => Promise.resolve()),
      b: vi.fn(() => Promise.resolve()),
    };
    const pauses = { a: vi.fn(), b: vi.fn() };
    a.play = plays.a as () => Promise<void>;
    a.pause = pauses.a as () => void;
    b.play = plays.b as () => Promise<void>;
    b.pause = pauses.b as () => void;
    return {
      a,
      b,
      plays,
      pauses,
      remove() {
        a.remove();
        b.remove();
      },
    };
  }

  it("the song on the second element: pause silences both, resume restarts the second element", () => {
    const els = installPlainElements();
    try {
      // The engine has advanced onto the second element: the
      // first element's source was cleared at the hand-off and
      // the current song lives on liner-audio-b.
      els.b.src = "blob:current-song";
      const access = createPlayerAccess();
      access.pausePlainPlayback?.();
      expect(els.pauses.a).toHaveBeenCalledTimes(1);
      expect(els.pauses.b).toHaveBeenCalledTimes(1);
      access.resumePlainPlayback?.();
      // Before the fix this called play() on liner-audio only
      // and the song sat loaded and silent until a manual
      // pause/play cycle.
      expect(els.plays.b).toHaveBeenCalledTimes(1);
      expect(els.plays.a).not.toHaveBeenCalled();
    } finally {
      els.remove();
    }
  });

  it("the song on the first element: resume restarts the first element only", () => {
    const els = installPlainElements();
    try {
      els.a.src = "blob:current-song";
      const access = createPlayerAccess();
      access.pausePlainPlayback?.();
      access.resumePlainPlayback?.();
      expect(els.plays.a).toHaveBeenCalledTimes(1);
      expect(els.plays.b).not.toHaveBeenCalled();
    } finally {
      els.remove();
    }
  });

  it("mid-overlap, both elements carry a source: resume restarts both legs", () => {
    const els = installPlainElements();
    try {
      els.a.src = "blob:outgoing";
      els.b.src = "blob:incoming";
      const access = createPlayerAccess();
      access.pausePlainPlayback?.();
      access.resumePlainPlayback?.();
      expect(els.plays.a).toHaveBeenCalledTimes(1);
      expect(els.plays.b).toHaveBeenCalledTimes(1);
    } finally {
      els.remove();
    }
  });

  it("session level: preparing-phase pause → resume leaves the current element playing", async () => {
    const els = installPlainElements();
    const tracks = [makeTrack("a"), makeTrack("b")];
    usePlayerStore.setState({
      queue: tracks,
      currentTrack: tracks[0],
      currentIndex: 0,
      status: "playing",
      positionMs: 0,
      durationMs: 240_000,
      repeat: "off",
      volume: 0.8,
    });
    // The engine is mid-overlap onto the second element: the
    // incoming song — the one that must be audible after the
    // resume — is on liner-audio-b.
    els.a.src = "blob:outgoing";
    els.b.src = "blob:incoming";
    const performer = new FakePerformer();
    const clock = new FakeClock();
    const world = new FakeWorld();
    const session = createSession({
      createPerformer: () => performer,
      supply: world.supply as never,
      // Preparation never lands: the session stays in its
      // preparing phase for the whole test.
      source: {
        resolveTrackAudio: () => new Promise(() => {}),
      } as never,
      brain: drawingBrain(),
      memory: createPerformanceMemory(),
      behaviourLog: createBehaviourLog(createInMemoryBehaviourStore()),
      player: createPlayerAccess(),
      clock,
      registerMasterTap: (() => {}) as never,
    });
    try {
      await session.start(tracks, 0);
      expect(session.preparing).toBe(true);

      session.pause();
      expect(els.pauses.a).toHaveBeenCalledTimes(1);
      expect(els.pauses.b).toHaveBeenCalledTimes(1);
      expect(usePlayerStore.getState().status).toBe("paused");

      session.resume();
      // The current element — the second one — is playing
      // again, with no manual pause/play cycle needed.
      expect(els.plays.b).toHaveBeenCalledTimes(1);
      expect(usePlayerStore.getState().status).toBe("playing");
      expect(session.preparing).toBe(true);
    } finally {
      if (session.isRunning) session.stop();
      els.remove();
      usePlayerStore.setState({
        queue: [],
        currentTrack: null,
        currentIndex: -1,
        status: "idle",
        positionMs: 0,
        durationMs: 0,
      });
    }
  });
});

// ---------------------------------------------------------------------
// AUTHORITY (fix2-0119): while a session is live there is exactly
// ONE sounding source and ONE position — the deck. The user's
// photographed states are the specification: one track at two
// positions (DJ surface 0:25, plain player 2:03), and moving
// progress over total silence. Both must be impossible by
// construction.
// ---------------------------------------------------------------------

/** Deterministic seeded RNG (mulberry32) for reproducible draws. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("authority — one track, two positions (fix2-0119)", () => {
  function installAuthorityElements() {
    const a = document.createElement("audio");
    a.id = "liner-audio";
    const b = document.createElement("audio");
    b.id = "liner-audio-b";
    document.body.append(a, b);
    // The plain engine has the song on liner-audio, mid-track:
    // sounding, at 123 s of the track.
    const sounding = { a: true, b: false };
    const pauses = {
      a: vi.fn(() => {
        sounding.a = false;
      }),
      b: vi.fn(() => {
        sounding.b = false;
      }),
    };
    a.pause = pauses.a as () => void;
    b.pause = pauses.b as () => void;
    a.play = vi.fn(() => Promise.resolve()) as () => Promise<void>;
    b.play = vi.fn(() => Promise.resolve()) as () => Promise<void>;
    Object.defineProperty(a, "paused", {
      configurable: true,
      get: () => !sounding.a,
    });
    Object.defineProperty(a, "ended", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(a, "currentTime", {
      configurable: true,
      get: () => 123,
    });
    a.src = "blob:current-song";
    return {
      a,
      b,
      sounding,
      pauses,
      remove() {
        a.remove();
        b.remove();
      },
    };
  }

  function resetStore() {
    usePlayerStore.setState({
      queue: [],
      currentTrack: null,
      currentIndex: -1,
      status: "idle",
      positionMs: 0,
      durationMs: 0,
    });
  }

  it("takeover adopts the element's live position, the element stays silent, and repeated foreign sound ends the session visibly", async () => {
    const els = installAuthorityElements();
    const tracks = [makeTrack("a"), makeTrack("b")];
    usePlayerStore.setState({
      queue: tracks,
      currentTrack: tracks[0],
      currentIndex: 0,
      status: "playing",
      // The store's published position lags the element (250 ms
      // publish cadence): 120 s in the store, 123 s on the
      // element. The deck must adopt the ELEMENT's 123 s.
      positionMs: 120_000,
      durationMs: 240_000,
      repeat: "off",
      volume: 0.8,
    });
    const performer = new FakePerformer();
    const clock = new FakeClock();
    const world = new FakeWorld();
    const session = createSession({
      createPerformer: () => performer,
      supply: world.supply as never,
      source: world.source,
      brain: drawingBrain(),
      memory: createPerformanceMemory(),
      behaviourLog: createBehaviourLog(createInMemoryBehaviourStore()),
      player: createPlayerAccess(),
      clock,
      registerMasterTap: (() => {}) as never,
    });
    try {
      await session.start(tracks, 0);
      await flush();
      // TAKEOVER: the deck adopted the element's live position —
      // not the store's stale copy, never a restart near zero.
      expect(performer.positionMs("A")).toBe(123_000);
      // …and the element was silenced in the same step.
      expect(els.pauses.a).toHaveBeenCalledTimes(1);
      expect(session.isRunning).toBe(true);
      // The store's position is now the deck's — the only one.
      clock.tick();
      await flush();
      expect(usePlayerStore.getState().positionMs).toBe(123_000);
      performer.setPosition(150_000);
      clock.tick();
      await flush();
      expect(usePlayerStore.getState().positionMs).toBe(150_000);
      // The element, paused at 123 s, does not move the store —
      // the photographed 0:25-vs-2:03 divergence has no writer.
      //
      // Foreign sound under the live session: re-silenced per
      // tick, a strike each time…
      els.sounding.a = true;
      clock.tick();
      await flush();
      expect(els.pauses.a).toHaveBeenCalledTimes(2);
      expect(session.isRunning).toBe(true);
      els.sounding.a = true;
      clock.tick();
      await flush();
      expect(session.isRunning).toBe(true);
      // …and at the third strike the session ends VISIBLY
      // instead of shadow-running against a second transport.
      els.sounding.a = true;
      clock.tick();
      await flush();
      expect(session.isRunning).toBe(false);
      expect(session.endReason).toBe("replaced");
      expect(session.startState).toBe("failed");
      expect(session.startFailure).toContain("plain player");
    } finally {
      if (session.isRunning) session.stop();
      els.remove();
      resetStore();
    }
  });

  it("takeover refuses to silence the elements when the deck's context cannot run — visible failure, plain player keeps the sound", async () => {
    const els = installAuthorityElements();
    const tracks = [makeTrack("a"), makeTrack("b")];
    usePlayerStore.setState({
      queue: tracks,
      currentTrack: tracks[0],
      currentIndex: 0,
      status: "playing",
      positionMs: 120_000,
      durationMs: 240_000,
      repeat: "off",
      volume: 0.8,
    });
    const performer = new FakePerformer();
    // The deck's context is stuck suspended: resume is attempted
    // (the fake counts the calls) but the state never flips.
    (performer as unknown as { contextState: () => string }).contextState =
      () => "suspended";
    const clock = new FakeClock();
    const world = new FakeWorld();
    const session = createSession({
      createPerformer: () => performer,
      supply: world.supply as never,
      source: world.source,
      brain: drawingBrain(),
      memory: createPerformanceMemory(),
      behaviourLog: createBehaviourLog(createInMemoryBehaviourStore()),
      player: createPlayerAccess(),
      clock,
      registerMasterTap: (() => {}) as never,
    });
    try {
      await session.start(tracks, 0);
      await flush();
      // The start failed VISIBLY, with the reason…
      expect(session.isRunning).toBe(false);
      expect(session.endReason).toBe("start-no-playable");
      expect(session.startState).toBe("failed");
      expect(session.startFailure).toContain("audio could not start");
      expect(performer.contextEnsureCalls).toBeGreaterThan(0);
      // …and the elements were NEVER silenced: no moving
      // progress over total silence — the plain player simply
      // keeps the song it was already playing.
      expect(els.pauses.a).not.toHaveBeenCalled();
      expect(els.pauses.b).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().status).toBe("playing");
    } finally {
      if (session.isRunning) session.stop();
      els.remove();
      resetStore();
    }
  });
});

describe("authority — silent motion (fix2-0119)", () => {
  it("a deck that stops advancing is warned, then hands the sound back and ends visibly", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks, { brain: stubBrain(() => null) });
    const dispatched: { type: string; track?: Track }[] = [];
    (
      h.player as unknown as {
        dispatchCommand: (c: { type: string; track?: Track }) => void;
      }
    ).dispatchCommand = (c) => {
      dispatched.push(c);
    };
    await startInHorizon(h);
    // Deck A's position never moves again (its context died):
    // the fake only advances when a test tells it to.
    h.clock.tick();
    await flush();
    const ensureBeforeWarn = h.performer.contextEnsureCalls;
    h.clock.advance(2_500);
    h.clock.tick();
    await flush();
    // Past the warn bound: a resume was attempted, the session
    // is still alive, and the loss is narrated.
    expect(h.session.isRunning).toBe(true);
    expect(h.performer.contextEnsureCalls).toBeGreaterThan(ensureBeforeWarn);
    h.clock.advance(6_000);
    h.clock.tick();
    await flush();
    // Past the fail bound (8 s frozen): the session ends
    // VISIBLY and hands the current song back to the plain
    // player through the normal command channel.
    expect(h.session.isRunning).toBe(false);
    expect(h.session.endReason).toBe("replaced");
    expect(h.session.startState).toBe("failed");
    expect(h.session.startFailure).toContain("stopped rendering");
    expect(
      dispatched.some(
        (c) => c.type === "PLAY_REQUESTED" && c.track?.id === "a",
      ),
    ).toBe(true);
  });
});

describe("the deciding race (fix2-0119)", () => {
  it("a deck end arriving mid-commit does not pre-empt the drawn join with a plain cut", async () => {
    const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const h = buildHarness(tracks);
    // The rendition renders slowly: performRecipe stays pending
    // until the test releases it (on the user's ARM Surface a
    // beatmatched rendition can take seconds — the window in
    // which deck A's end used to fire a plain cut underneath).
    let releaseRecipe: (() => void) | null = null;
    const originalPerform = h.performer.performRecipe.bind(h.performer);
    h.performer.performRecipe = (recipe) =>
      new Promise<void>((resolve) => {
        releaseRecipe = () => {
          void originalPerform(recipe);
          resolve();
        };
      });
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    // The decision is in flight, awaiting the rendition.
    expect(releaseRecipe).not.toBeNull();
    // Deck A ends mid-commit.
    h.performer.setPosition(239_999);
    h.clock.tick();
    await flush();
    // NO plain cut pre-empted the join: still on A, no fallback.
    expect(h.player.getState().currentTrack?.id).toBe("a");
    expect(h.session.fallbackCount).toBe(0);
    expect(
      h.behaviourLog
        .getBehaviourLog()
        .some((r) => r.reason === "fallback-unprepared"),
    ).toBe(false);
    // The rendition lands; the drawn join performs and completes.
    releaseRecipe!();
    await flush();
    expect(h.performer.performedRecipes).toHaveLength(1);
    h.clock.tick();
    await flush();
    expect(h.player.getState().currentTrack?.id).toBe("b");
    expect(h.behaviourLog.getBehaviourLog().at(-1)?.reason).toBe("performed");
    expect(h.session.fallbackCount).toBe(0);
  });
});

describe("autonomous acceptance — the photographed configuration (fix2-0119)", () => {
  // The user's field fingerprint, reproduced against the REAL
  // brain and authors: a playlist of prepared tracks, the
  // session live, the window reached — and the outcome must be
  // an AUTONOMOUS performed join (pool non-zero at decision
  // time, deck B loaded), not six pool-0 fallbacks and not a
  // join that only happens when the user acts.
  const ids = ["a", "b", "c", "d", "e", "f"];

  async function runToPerformedJoin(
    sliders: Record<SliderId, number>,
  ): Promise<Harness> {
    const tracks = ids.map((id) => makeTrack(id));
    const h = buildHarness(tracks, {
      brain: createBrain({ rng: mulberry32(7) }),
    });
    h.session.setShaping(resolveShaping("autonomous", sliders));
    await startInHorizon(h);
    h.clock.tick();
    await flush();
    return h;
  }

  it("many prepared tracks, autonomous draw at the window: performed join, pool > 0, deck B loaded — no user act", async () => {
    const h = await runToPerformedJoin(NEUTRAL_SLIDERS);
    // A join was drawn from a NON-EMPTY pool and is performing.
    expect(h.session.nextJoinPreview?.poolSize).toBeGreaterThan(0);
    expect(h.performer.performedRecipes.length).toBeGreaterThanOrEqual(1);
    expect(h.performer.deckTracks.B).not.toBeNull();
    // Complete the overlap: the ledger records a PERFORMED join
    // (reason "performed" — the autonomous reason, not
    // "user-act"), and nothing fell back.
    h.performer.setPosition(239_999);
    h.clock.tick();
    await flush();
    const log = h.behaviourLog.getBehaviourLog();
    expect(log.at(-1)?.reason).toBe("performed");
    expect(h.session.fallbackCount).toBe(0);
  });

  it("sliders maxed (the photographed dials): joins perform AND the shaping reaches the performed recipe", async () => {
    const maxed = Object.fromEntries(SLIDER_IDS.map((id) => [id, 1])) as Record<
      SliderId,
      number
    >;
    const neutral = await runToPerformedJoin(NEUTRAL_SLIDERS);
    const pushed = await runToPerformedJoin(maxed);
    // Both runs perform autonomously…
    expect(neutral.performer.performedRecipes.length).toBeGreaterThanOrEqual(1);
    expect(pushed.performer.performedRecipes.length).toBeGreaterThanOrEqual(1);
    // …and the maxed run's performed recipe is NOT the neutral
    // run's recipe: with every dial at full, the shaping
    // observably reaches the join that gets performed (a
    // different pick, family, technique or shape). "Every dial
    // at full, nothing happens" is not a reachable state.
    const neutralRecipe = JSON.stringify(neutral.performer.performedRecipes[0]);
    const pushedRecipe = JSON.stringify(pushed.performer.performedRecipes[0]);
    expect(pushedRecipe).not.toBe(neutralRecipe);
    pushed.performer.setPosition(239_999);
    pushed.clock.tick();
    await flush();
    expect(pushed.behaviourLog.getBehaviourLog().at(-1)?.reason).toBe(
      "performed",
    );
    expect(pushed.session.fallbackCount).toBe(0);
  });
});
