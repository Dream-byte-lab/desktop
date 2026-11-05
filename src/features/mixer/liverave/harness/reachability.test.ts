// reachability.test.ts — Wave 10 reachability settlement.
//
// Settles the three performed legs the official distribution runs
// left as small-sample flags — spinback, loop-blend, vinyl-stop —
// with counts instead of sampling arguments.
//
// Method, from what the engine itself proved along the way:
//  - The session sequences TRACKS, not queue positions: a queue
//    repeating one pair collapses after each track has sounded
//    (verified against the session's own activity feed). So the
//    settlement device is MANY SHORT SESSIONS: one autonomous
//    two-track session per draw, fresh brain seed and fresh
//    performance memory each time, counted from the behaviour
//    records and the performer's performed recipes.
//  - A brain-level scan over every ordered pair in the fixture
//    library (draws + author-level generation) picks the session
//    pairs from measured draw rates, not guesses.
//  - Vinyl-stop generates on NO library pair (the jog rule is
//    tail-length: brake/spinback on long tails, vinyl-stop on
//    short ones; the library's only outro tail is ≈26 beats, i.e.
//    long). Its generation is proven in authors.test.ts on a
//    hand-built pair with a 16-beat outro, so the settlement runs
//    its sessions over an equivalent hand-built pair of TrackReads
//    (buildFixtureRead, the same builder the authors' fixtures
//    use), labelled as hand-built wherever reported.
//
// Verdicts are findings, written to /tmp/reachability-settlement.json
// for the coordinator's addendum — assertions here check the
// harness's own accounting (scan coverage, session completion,
// record/recipe agreement), never that the engine hits a number.

import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { authorCandidates } from "../authors";
import { createBrain } from "../brain";
import { buildTrackFacts, type TrackRead } from "../facts";
import {
  createBehaviourLog,
  createInMemoryBehaviourStore,
  createPerformanceMemory,
  type BehaviourLog,
  type BehaviourRecord,
} from "../memory";
import type { JoinRecipe } from "../recipe";
import { createSession } from "../session";
import type {
  LiveRaveSession,
  PerformerLike,
  PlayerAccess,
  SessionClock,
} from "../session";
import { NEUTRAL_SHAPING } from "../shaping";
import { buildFixtureRead, type FixtureSpec } from "../testFixtures";
import { fixtureFacts, fixtureReads, fixtureTracks } from "./fixtures";
import { mulberry32 } from "./distribution";

// ---------------------------------------------------------------------
// The hand-built short-tail pair (vinyl-stop's generation ground)
// ---------------------------------------------------------------------

const SHORT_TAIL_A_SPEC: FixtureSpec = {
  bpm: 126,
  totalBeats: 256,
  key: { tonic: 9, mode: "minor", camelot: "8A", confidence: 0.9 },
  tempoConfidence: 0.85,
  gridConfidence: 0.9,
  sections: [
    { kind: "intro", fromBeat: 0, toBeat: 32, energy: 0.08 },
    { kind: "verse", fromBeat: 32, toBeat: 96, energy: 0.2 },
    { kind: "chorus", fromBeat: 96, toBeat: 192, energy: 0.33 },
    { kind: "breakdown", fromBeat: 192, toBeat: 224, energy: 0.1 },
    { kind: "chorus", fromBeat: 224, toBeat: 240, energy: 0.33 },
    // 16-beat outro: the short tail vinyl-stop is authored for.
    { kind: "outro", fromBeat: 240, toBeat: 256, energy: 0.12 },
  ],
  drops: [{ atBeat: 96, strength: 2.0 }],
  vocalAtBeat: (b) => (b >= 240 ? 0.08 : b < 32 ? 0.1 : 0.45),
  transientZones: [
    [0, 32],
    [240, 256],
  ],
};
const SHORT_TAIL_B_SPEC: FixtureSpec = {
  bpm: 127,
  totalBeats: 256,
  key: { tonic: 2, mode: "minor", camelot: "7A", confidence: 0.9 },
  tempoConfidence: 0.85,
  gridConfidence: 0.9,
  sections: [
    { kind: "intro", fromBeat: 0, toBeat: 16, energy: 0.07 },
    { kind: "drop", fromBeat: 16, toBeat: 128, energy: 0.36 },
    { kind: "verse", fromBeat: 128, toBeat: 192, energy: 0.2 },
    { kind: "outro", fromBeat: 192, toBeat: 256, energy: 0.12 },
  ],
  drops: [{ atBeat: 16, strength: 3.0 }],
  vocalAtBeat: (b) => (b < 24 ? 0.08 : 0.45),
  transientZones: [[0, 16]],
};
const SHORT_TAIL_A_ID = "short-tail-a";
const SHORT_TAIL_B_ID = "short-tail-b";
const shortTailReadA = buildFixtureRead(SHORT_TAIL_A_SPEC);
const shortTailReadB = buildFixtureRead(SHORT_TAIL_B_SPEC);

/** Every read the settlement world can serve, by track id. */
const ALL_READS: Map<string, TrackRead> = new Map([
  ...fixtureReads,
  [SHORT_TAIL_A_ID, shortTailReadA],
  [SHORT_TAIL_B_ID, shortTailReadB],
]);

// ---------------------------------------------------------------------
// Session fakes (distribution.test.ts patterns)
// ---------------------------------------------------------------------

function makeTrack(id: string): Track {
  const read = ALL_READS.get(id);
  if (!read) throw new Error(`reachability: no read for ${id}`);
  return {
    id,
    title: id,
    artists: "Fixture",
    coverUrl: "",
    durationMs: Math.round(read.durationSec * 1000),
    playCount: 0,
  };
}

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
}

class FakePerformer implements PerformerLike {
  onDeckEnded?: ((side: "A" | "B") => void) | undefined;
  deckTracks: Record<"A" | "B", string | null> = { A: null, B: null };
  positions: Record<"A" | "B", number> = { A: 0, B: 0 };
  playing: Record<"A" | "B", boolean> = { A: false, B: false };
  performedRecipes: JoinRecipe[] = [];
  loadDeck(side: "A" | "B", load: { trackId: string }): void {
    this.deckTracks[side] = load.trackId;
    this.positions[side] = 0;
    this.playing[side] = false;
  }
  unloadDeck(side: "A" | "B"): void {
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
    this.playing = { A: false, B: false };
  }
  setMasterGain(): void {}
  setManualLoop(): void {}
  setPosition(ms: number): void {
    this.positions.A = ms;
  }
}

class FakePlayer implements PlayerAccess {
  private state: {
    queue: Track[];
    currentIndex: number;
    currentTrack: Track | null;
    status: string;
    repeat: "off" | "all" | "one";
    volume: number;
  };
  private readonly listeners = new Set<() => void>();
  constructor(queue: Track[]) {
    this.state = {
      queue,
      currentIndex: 0,
      currentTrack: queue[0] ?? null,
      status: "playing",
      repeat: "off",
      volume: 0.8,
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
    this.state.currentTrack = track;
    this.state.currentIndex = index;
    this.emit();
  }
  setPosition(): void {}
  setDuration(): void {}
  setStatus(status: string): void {
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
}

class FakeWorld {
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
    resolveTrackAudio: async (track: Track) => ({
      samples: new Float32Array(8).fill(this.codeOf(track.id)),
      sampleRate: 22_050,
      audioHash: `hash-${track.id}`,
      buffer: { __trackId: track.id } as unknown as AudioBuffer,
    }),
  };
  readonly supply = {
    supplyRead: async (request: { samples: Float32Array }) => {
      const id = this.idOfSamples(request.samples);
      if (!id) return null;
      const read: TrackRead | undefined = ALL_READS.get(id);
      if (!read) return null;
      return { read, source: "local" as const };
    },
    supplyPair: async () => null,
  };
}

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------
// Technique extraction (same accounting as the distribution suite)
// ---------------------------------------------------------------------

function jogKindsOf(recipe: JoinRecipe): Set<string> {
  const kinds = new Set<string>();
  for (const block of recipe.blocks) {
    if (block.type === "jog") kinds.add(block.kind);
  }
  return kinds;
}

const TARGETS = ["spinback", "loop-blend", "vinyl-stop"] as const;
type Target = (typeof TARGETS)[number];

function recipeHits(recipe: JoinRecipe, target: Target): boolean {
  if (target === "loop-blend") return recipe.family === "loop-blend";
  return jogKindsOf(recipe).has(target);
}

// ---------------------------------------------------------------------
// One two-track session, autonomously (the settlement device)
// ---------------------------------------------------------------------

interface PairSessionResult {
  completed: boolean;
  recipes: JoinRecipe[];
  performedRecords: number;
  fallbackRecords: number;
}

async function runPairSession(
  aId: string,
  bId: string,
  seed: number,
): Promise<PairSessionResult> {
  const tracks = [makeTrack(aId), makeTrack(bId)];
  const performer = new FakePerformer();
  const clock = new FakeClock();
  const world = new FakeWorld();
  const player = new FakePlayer(tracks);
  const behaviourLog: BehaviourLog = createBehaviourLog(
    createInMemoryBehaviourStore(),
  );
  const session: LiveRaveSession = createSession({
    createPerformer: () => performer,
    supply: world.supply as never,
    source: world.source,
    brain: createBrain({ rng: mulberry32(seed) }),
    memory: createPerformanceMemory(),
    behaviourLog,
    player,
    clock,
    registerMasterTap: () => {},
  });
  session.setShaping(NEUTRAL_SHAPING);
  await session.start(tracks, 0);
  await flush(40);

  let guard = 0;
  while (session.isRunning && guard < 500) {
    guard += 1;
    if (session.blending) {
      performer.setPosition(10_000_000);
      clock.tick();
      await flush(20);
      continue;
    }
    const currentId = player.getState().currentTrack?.id;
    if (!currentId) break;
    const durationMs = makeTrack(currentId).durationMs;
    let progressed = false;
    for (
      let step = 0;
      step < 240 && session.isRunning && !session.blending;
      step += 1
    ) {
      const next = Math.min(performer.positionMs("A") + 500, durationMs);
      performer.setPosition(next);
      clock.tick();
      await flush(8);
      if (
        !session.isRunning ||
        session.blending ||
        player.getState().currentTrack?.id !== currentId
      ) {
        progressed = true;
        break;
      }
      if (next >= durationMs) {
        progressed = true;
        break;
      }
    }
    if (!progressed && session.isRunning && !session.blending) {
      performer.setPosition(durationMs + 1_000);
      clock.tick();
      await flush(20);
      if (
        session.isRunning &&
        !session.blending &&
        player.getState().currentTrack?.id === currentId
      ) {
        break;
      }
    }
  }
  const completed =
    !session.isRunning && session.endReason === "queue-exhausted";
  if (session.isRunning) session.stop();
  const records: BehaviourRecord[] = behaviourLog.getBehaviourLog();
  return {
    completed,
    recipes: performer.performedRecipes,
    performedRecords: records.filter((r) => r.reason === "performed").length,
    fallbackRecords: records.filter((r) => r.reason.startsWith("fallback-"))
      .length,
  };
}

// ---------------------------------------------------------------------
// Scan + settlement
// ---------------------------------------------------------------------

interface TargetSettlement {
  target: Target;
  pair: string;
  pairKind: "library" | "hand-built";
  sessions: number;
  sessionsCompleted: number;
  joinsPerformed: number;
  performedRecords: number;
  fallbackRecords: number;
  performedTarget: number;
  scanDraws: number;
  scanDrawnTarget: number;
  scanDrawRate: number;
  expectedAtScanRate: number;
}

const SCAN_DRAWS = 60;
const HAND_SCAN_DRAWS = 300;
let libraryScanPairs = 0;
let settlements: TargetSettlement[] = [];

async function settleTarget(
  target: Target,
  aId: string,
  bId: string,
  pairKind: "library" | "hand-built",
  sessions: number,
  seedBase: number,
  scanDraws: number,
  scanDrawnTarget: number,
): Promise<TargetSettlement> {
  const out: TargetSettlement = {
    target,
    pair: `${aId}→${bId}`,
    pairKind,
    sessions,
    sessionsCompleted: 0,
    joinsPerformed: 0,
    performedRecords: 0,
    fallbackRecords: 0,
    performedTarget: 0,
    scanDraws,
    scanDrawnTarget,
    scanDrawRate: scanDraws > 0 ? scanDrawnTarget / scanDraws : 0,
    expectedAtScanRate: 0,
  };
  for (let i = 0; i < sessions; i += 1) {
    const run = await runPairSession(aId, bId, seedBase + i);
    if (run.completed) out.sessionsCompleted += 1;
    out.joinsPerformed += run.recipes.length;
    out.performedRecords += run.performedRecords;
    out.fallbackRecords += run.fallbackRecords;
    out.performedTarget += run.recipes.filter((r) =>
      recipeHits(r, target),
    ).length;
  }
  out.expectedAtScanRate =
    Math.round(out.joinsPerformed * out.scanDrawRate * 100) / 100;
  return out;
}

beforeAll(async () => {
  // --- library scan: draws + generation over every ordered pair ---
  const ids = fixtureTracks.map((t) => t.id);
  const drawnByTarget: Record<Target, Map<string, number>> = {
    spinback: new Map(),
    "loop-blend": new Map(),
    "vinyl-stop": new Map(),
  };
  const generatedByTarget: Record<Target, Set<string>> = {
    spinback: new Set(),
    "loop-blend": new Set(),
    "vinyl-stop": new Set(),
  };
  for (const aId of ids) {
    for (const bId of ids) {
      if (aId === bId) continue;
      libraryScanPairs += 1;
      const factsA = fixtureFacts.get(aId);
      const factsB = fixtureFacts.get(bId);
      if (!factsA || !factsB) continue;
      const pair = `${aId}→${bId}`;
      const brain = createBrain({ rng: mulberry32(777) });
      for (let d = 0; d < SCAN_DRAWS; d += 1) {
        const result = brain.consider({
          factsA,
          optionsB: [factsB],
          arcPosition: 0.5,
          shaping: NEUTRAL_SHAPING,
        });
        if (!result) continue;
        for (const target of TARGETS) {
          if (recipeHits(result.recipe, target)) {
            drawnByTarget[target].set(
              pair,
              (drawnByTarget[target].get(pair) ?? 0) + 1,
            );
          }
        }
      }
      const authored = authorCandidates(factsA, factsB, {
        arcPosition: 0.5,
        shaping: NEUTRAL_SHAPING,
      });
      for (const candidate of authored.candidates) {
        for (const target of TARGETS) {
          if (recipeHits(candidate, target)) {
            generatedByTarget[target].add(pair);
          }
        }
      }
    }
  }
  const bestPair = (target: Target): { pair: string; drawn: number } => {
    let best = { pair: "", drawn: -1 };
    for (const [pair, drawn] of drawnByTarget[target]) {
      if (drawn > best.drawn) best = { pair, drawn };
    }
    return best;
  };

  // --- hand-pair scan (vinyl-stop's generation ground) ---
  const handFactsA = buildTrackFacts(
    SHORT_TAIL_A_ID,
    shortTailReadA,
    shortTailReadA.durationSec * 1000,
  );
  const handFactsB = buildTrackFacts(
    SHORT_TAIL_B_ID,
    shortTailReadB,
    shortTailReadB.durationSec * 1000,
  );
  const handAuthored = authorCandidates(handFactsA, handFactsB, {
    arcPosition: 0.5,
    shaping: NEUTRAL_SHAPING,
  });
  const handGenerates = TARGETS.filter((target) =>
    handAuthored.candidates.some((c) => recipeHits(c, target)),
  );
  let handDrawnVinyl = 0;
  {
    const brain = createBrain({ rng: mulberry32(4242) });
    for (let d = 0; d < HAND_SCAN_DRAWS; d += 1) {
      const result = brain.consider({
        factsA: handFactsA,
        optionsB: [handFactsB],
        arcPosition: 0.5,
        shaping: NEUTRAL_SHAPING,
      });
      if (result && recipeHits(result.recipe, "vinyl-stop")) {
        handDrawnVinyl += 1;
      }
    }
  }

  // --- sessions ---
  const spin = bestPair("spinback");
  const [spinA, spinB] = spin.pair.split("→");
  const loop = bestPair("loop-blend");
  const [loopA, loopB] = loop.pair.split("→");
  settlements = [
    await settleTarget(
      "spinback",
      spinA,
      spinB,
      "library",
      90,
      11000,
      SCAN_DRAWS,
      spin.drawn,
    ),
    await settleTarget(
      "loop-blend",
      loopA,
      loopB,
      "library",
      150,
      22000,
      SCAN_DRAWS,
      loop.drawn,
    ),
    await settleTarget(
      "vinyl-stop",
      SHORT_TAIL_A_ID,
      SHORT_TAIL_B_ID,
      "hand-built",
      120,
      33000,
      HAND_SCAN_DRAWS,
      handDrawnVinyl,
    ),
  ];

  writeFileSync(
    "/tmp/reachability-settlement.json",
    JSON.stringify(
      {
        method:
          "many short autonomous two-track sessions (fresh seed + memory each), " +
          "after the session proved to sequence tracks, not queue positions",
        libraryScan: {
          pairs: libraryScanPairs,
          drawsPerPair: SCAN_DRAWS,
          generatedPairs: Object.fromEntries(
            TARGETS.map((t) => [t, generatedByTarget[t].size]),
          ),
          bestDrawPairs: Object.fromEntries(
            TARGETS.map((t) => [t, bestPair(t)]),
          ),
        },
        handPair: {
          pair: `${SHORT_TAIL_A_ID}→${SHORT_TAIL_B_ID}`,
          generates: handGenerates,
          scanDraws: HAND_SCAN_DRAWS,
          drawnVinylStop: handDrawnVinyl,
        },
        settlements,
      },
      null,
      2,
    ),
    "utf8",
  );
}, 1_200_000);

describe("reachability settlement — harness accounting", () => {
  it("scanned the full ordered-pair matrix", () => {
    expect(libraryScanPairs).toBe(
      fixtureTracks.length * (fixtureTracks.length - 1),
    );
  });

  it("settled all three targets with completed sessions", () => {
    expect(settlements.map((s) => s.target)).toEqual([
      "spinback",
      "loop-blend",
      "vinyl-stop",
    ]);
    for (const s of settlements) {
      // eslint-disable-next-line no-console
      console.log(
        `[settlement] ${s.target}: pair=${s.pair} (${s.pairKind}) sessions=${s.sessions} ` +
          `completed=${s.sessionsCompleted} joins=${s.joinsPerformed} performed=${s.performedTarget} ` +
          `scanRate=${s.scanDrawRate.toFixed(3)} expected=${s.expectedAtScanRate} ` +
          `records=${s.performedRecords} fallbacks=${s.fallbackRecords}`,
      );
      expect(s.sessionsCompleted).toBe(s.sessions);
    }
  });
});
