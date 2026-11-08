// waveDistribution.test.ts — acceptance (b) for the optimisation
// wave: what the DEFAULT configuration actually selects.
//
// One long scripted session over the fixture library (19 tracks,
// real analysed reads — club / pop / drop / folk pairs at their
// real BPMs, keys and vocal shapes), driven through the real
// session on the wave path (slate → hands → ladder) with the
// default shaping: autonomous personality, neutral sliders,
// seeded brain. The tallies come from the session's own stamped
// behaviour records — technique/family distribution, ladder-rung
// distribution, provenance sources — plus the Cooldown Shelf's
// readable state sampled mid-run and the artist-repeat distances
// the shelf produced. This is the standing verification rule
// applied to the wave: a distribution, not an instance.

import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { createBrain } from "../brain";
import type { TrackRead } from "../facts";
import {
  createBehaviourLog,
  createInMemoryBehaviourStore,
  createPerformanceMemory,
  type BehaviourLog,
  type BehaviourRecord,
} from "../memory";
import type { JoinRecipe } from "../recipe";
import {
  createSession,
  type LiveRaveSession,
  type PerformerLike,
  type PlayerAccess,
  type SessionClock,
} from "../session";
import { NEUTRAL_SLIDERS, resolveShaping } from "../shaping";
import { fixturePlaylists, fixtureReads } from "./fixtures";
import { mulberry32 } from "./synthetics";

// ---------------------------------------------------------------------
// Fakes (the distribution.test.ts session-simulation patterns)
// ---------------------------------------------------------------------

const ARTISTS = ["Amara", "Bode", "Chidi", "Dalila", "Emeka"];
const artistOf = (index: number): string => ARTISTS[index % ARTISTS.length];

function makeTrack(id: string, index: number): Track {
  const read = fixtureReads.get(id);
  if (!read) throw new Error(`wave distribution: no fixture read for ${id}`);
  return {
    id,
    title: id,
    artists: artistOf(index),
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
    this.intervals.delete(handle as unknown as number);
  }
  tick(times = 1): void {
    for (let i = 0; i < times; i += 1) {
      this.nowMs += 250;
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
  publishedPositionMs = 0;
  publishedDurationMs = 0;
  setPosition(positionMs: number): void {
    this.publishedPositionMs = positionMs;
  }
  setDuration(durationMs: number): void {
    this.publishedDurationMs = durationMs;
  }
  setStatus(status: string): void {
    this.state.status = status as typeof this.state.status;
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
      const read: TrackRead | undefined = fixtureReads.get(id);
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
// The scripted session
// ---------------------------------------------------------------------

function tally(
  records: BehaviourRecord[],
  key: (r: BehaviourRecord) => string,
) {
  const out: Record<string, number> = {};
  for (const record of records) out[key(record)] = (out[key(record)] ?? 0) + 1;
  return out;
}

describe("wave distribution — the default configuration, measured", () => {
  it("runs a 19-track scripted session and reports what the default settings select", async () => {
    const ids: string[] = [];
    for (const playlist of fixturePlaylists) {
      for (const id of playlist.trackIds) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
    const queueIds = ids.slice(0, 24);
    const tracks = queueIds.map((id, i) => makeTrack(id, i));
    const artistById = new Map(tracks.map((t) => [t.id, t.artists]));
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
      brain: createBrain({ rng: mulberry32(11) }),
      memory: createPerformanceMemory(),
      behaviourLog,
      player,
      clock,
      registerMasterTap: () => {},
    });
    session.setShaping(resolveShaping("autonomous", NEUTRAL_SLIDERS));
    await session.start(tracks, 0);
    await flush(60);

    let shelfMidRun: string[] = [];
    let guard = 0;
    while (session.isRunning && guard < 600) {
      guard += 1;
      const recordsSoFar = behaviourLog.getBehaviourLog().length;
      if (recordsSoFar >= 6 && shelfMidRun.length === 0) {
        shelfMidRun = session.cooldownState?.() ?? [];
      }
      if (session.blending) {
        performer.setPosition(10_000_000);
        clock.tick();
        await flush(20);
        continue;
      }
      const currentId = player.getState().currentTrack?.id;
      if (!currentId) break;
      const durationMs =
        tracks.find((t) => t.id === currentId)?.durationMs ?? 240_000;
      let moved = false;
      for (
        let step = 0;
        step < 120 && session.isRunning && !session.blending;
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
          moved = true;
          break;
        }
        if (next >= durationMs) {
          moved = true;
          break;
        }
      }
      if (!moved && session.isRunning && !session.blending) {
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
    const stillRunning = session.isRunning;
    const endReason = session.endReason;
    if (session.isRunning) session.stop();

    const all = behaviourLog.getBehaviourLog();
    const joins = all.filter((r) => r.reason !== "set-end");
    const byFamily = tally(joins, (r) => r.family ?? "none");
    const byTechnique = tally(joins, (r) => r.technique ?? "—");
    const byReason = tally(joins, (r) => r.reason);
    const byRung = tally(joins, (r) =>
      r.provenance?.ladderRung != null
        ? `rung ${r.provenance.ladderRung}`
        : "unstamped",
    );
    const bySource = tally(joins, (r) => r.provenance?.source ?? "unstamped");
    const artistSequence = joins.map(
      (r) => artistById.get(r.pairTrackIds[1]) ?? "?",
    );
    const artistDistances: number[] = [];
    for (let i = 0; i < artistSequence.length; i += 1) {
      for (let j = i - 1; j >= 0; j -= 1) {
        if (artistSequence[j] === artistSequence[i]) {
          artistDistances.push(i - j);
          break;
        }
      }
    }
    const benchedLines = shelfMidRun.filter((l) => l.includes("BENCHED NOW"));
    console.log(
      [
        `WAVE DISTRIBUTION (default autonomous, neutral sliders, seed 11)`,
        `queue ${queueIds.length} tracks · joins recorded ${joins.length} · session ${stillRunning ? "still running at drive end" : `ended: ${endReason}`}`,
        `families ${JSON.stringify(byFamily)}`,
        `techniques ${JSON.stringify(byTechnique)}`,
        `reasons ${JSON.stringify(byReason)}`,
        `ladder rungs ${JSON.stringify(byRung)}`,
        `sources ${JSON.stringify(bySource)}`,
        `artist repeats ${artistDistances.length} · min repeat distance ${artistDistances.length ? Math.min(...artistDistances) : "—"} · distances ${JSON.stringify(artistDistances)}`,
        `shelf mid-run: ${shelfMidRun.length} lines, ${benchedLines.length} BENCHED NOW`,
        ...benchedLines.slice(0, 4).map((l) => `  ${l}`),
      ].join("\n"),
    );

    // Invariants the numbers above must satisfy.
    expect(joins.length).toBeGreaterThanOrEqual(12);
    expect(endReason === null || endReason === "queue-exhausted").toBe(true);
    for (const record of joins) {
      expect(record.provenance?.cratesVersion).toBe("crates-v1");
      expect(record.provenance?.ladderRung).not.toBeNull();
    }
    const rung1or2 = (byRung["rung 1"] ?? 0) + (byRung["rung 2"] ?? 0);
    expect(rung1or2 / joins.length).toBeGreaterThanOrEqual(0.6);
    expect(Object.keys(byFamily).length).toBeGreaterThanOrEqual(2);
    expect(shelfMidRun.length).toBeGreaterThan(0);
  }, 180_000);
});
