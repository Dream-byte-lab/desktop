// Where the greeting visualizer's data comes from — and the rules
// that keep it honest.
//
// The visualizer may only ever draw REAL audio: frequency data
// from an AnalyserNode fed by the sound actually playing. Taps
// are the only way in. A tap is a small promise — an analyser
// provider plus an isLive() truth function — and taps live in a
// registry ordered by priority:
//
//   live DJ master tap  >  live player-graph tap  >  rest
//
// Each sample, the registry walks the taps from the top and the
// first one carrying actual signal wins. A tap whose path is
// gone, whose context is suspended, or whose bins read silence
// falls through to the next: the field never freezes on dead
// data, and when no tap carries sound the sample is the resting
// profile — real zeros are treated as rest, never dressed up as
// motion. Registering a tap under an id that already exists
// replaces the old registration (disposing the old tap), which
// is how a later, first-class tap supersedes a pragmatic one
// without the consumer changing at all.
//
// The first registered tap — the player-graph tap below — is the
// one live Web Audio graph the app already has for plain
// playback: the player effects graph (pitch / EQ / reverb). Its
// own module publishes the graph on the window for exactly this
// kind of sharing (its source node and graph are stashed there
// for reuse), and its exported controller says whether it is
// attached at all.
//
// The honest limits, stated plainly:
// - The player graph exists only once the effects chain has been
//   attached (EQ, reverb, or pitch in use). Plain playback with
//   no effects runs on the bare media element — there is no Web
//   Audio graph to tap, so there is no live data, and the
//   visualizer rests. We do NOT force the graph to attach: an
//   overlay must never reroute the app's audio for its own sake.
// - A DJ session runs on the mixer's own private AudioContext;
//   until the mixer's unlock registers a DJ master tap here,
//   there is no live data during a set (the player element is
//   paused; if its graph happens to be attached, the tap
//   truthfully reads the silence on it and falls through to
//   rest). The visualizer rests.
// - When a tap exists but the bins read silence (paused, a
//   silent passage), sample() reports not-live: real zeros are
//   treated as rest, never dressed up as motion.

import { pitchShifter } from "@/features/player/engine/pitchShifter";

/** Frequency bins actually used, of the analyser's fftSize/2. */
const BIN_FLOOR = 2;
const BIN_CEILING = 110;
/** Bins averaged for the bass energy that drives the heartbeat. */
const BASS_BIN_CEILING = 9;
/** A bin must exceed this (of 255) for the signal to count as sound. */
const SIGNAL_BIN_THRESHOLD = 6;

/**
 * Map raw byte frequency bins onto `barCount` bar values (0..1),
 * log-spaced across the musical range so the low end — where the
 * energy lives — gets its share of the field. Pure; tested.
 */
export function mapBinsToBars(
  bins: ArrayLike<number>,
  barCount: number,
  out: Float32Array,
): void {
  const hi = Math.min(BIN_CEILING, bins.length - 1);
  const span = Math.log(hi / BIN_FLOOR);
  for (let bar = 0; bar < barCount; bar += 1) {
    const from = Math.floor(BIN_FLOOR * Math.exp((span * bar) / barCount));
    const to = Math.max(
      from + 1,
      Math.floor(BIN_FLOOR * Math.exp((span * (bar + 1)) / barCount)),
    );
    let sum = 0;
    let count = 0;
    for (let bin = from; bin < to && bin < bins.length; bin += 1) {
      sum += bins[bin];
      count += 1;
    }
    const mean = count > 0 ? sum / count / 255 : 0;
    out[bar] = Math.pow(mean, 0.75);
  }
}

/** Smoothed low-band energy, 0..1 — the heartbeat's musical input. */
export function bassEnergyOf(bins: ArrayLike<number>): number {
  const hi = Math.min(BASS_BIN_CEILING, bins.length);
  if (hi <= 1) return 0;
  let sum = 0;
  for (let bin = 1; bin < hi; bin += 1) sum += bins[bin];
  return Math.pow(sum / (hi - 1) / 255, 0.8);
}

/** True when the bins carry actual sound, not silence. */
export function binsHaveSignal(bins: ArrayLike<number>): boolean {
  const hi = Math.min(BIN_CEILING, bins.length);
  for (let bin = BIN_FLOOR; bin < hi; bin += 1) {
    if (bins[bin] > SIGNAL_BIN_THRESHOLD) return true;
  }
  return false;
}

/**
 * The resting field's profile: a low, still ridge of rolling
 * bumps. Deterministic and unanimated in itself — at rest, all
 * motion comes from the heartbeat envelope, at its idle ceiling.
 */
export function restProfileAt(index: number): number {
  const a = Math.sin(index * 0.9);
  const b = Math.sin(index * 0.37 + 1.7);
  return 0.52 + 0.22 * a * a + 0.14 * b * b;
}

/** Per-bar temporal smoothing: fast rise, heartbeat-slow fall. */
export function smoothBars(
  current: Float32Array,
  target: Float32Array,
  rise: number,
  fall: number,
): void {
  for (let i = 0; i < current.length; i += 1) {
    const goal = target[i] ?? 0;
    const value = current[i];
    current[i] = goal > value ? value + (goal - value) * rise : value * fall;
  }
}

export interface VisualizerSample {
  /** True only when real audio data backs this sample. */
  live: boolean;
  /** Bar values 0..1 (the resting profile when not live). */
  bars: Float32Array;
  /** Bass energy 0..1 when live; null when not. */
  bass: number | null;
}

/**
 * A source of real audio for the visualizer. The whole contract:
 * an analyser provider (the node to read, or null when this tap
 * has nothing to tap right now — creation and connection are the
 * tap's own business) and an isLive() truth function (is the
 * underlying sound path present at all). Whether the path is
 * carrying sound *right now* is decided by the bins, not by
 * isLive(): silence on a live path falls through like any other
 * absence of signal.
 */
export interface VisualizerTap {
  /** Stable identity; registering the same id twice replaces. */
  readonly id: string;
  analyser(): AnalyserNode | null;
  isLive(): boolean;
  /** Release anything the tap connected. Called on replace/dispose. */
  dispose?: () => void;
}

/** Well-known tap ids. */
export const VISUALIZER_TAP_ID = {
  DJ_MASTER: "dj-master",
  PLAYER_GRAPH: "player-graph",
} as const;

/**
 * Well-known tap priorities; higher wins. The DJ master outranks
 * the player graph — during a set the decks are the sound, and
 * the paused player element must never speak over them.
 */
export const VISUALIZER_TAP_PRIORITY = {
  DJ_MASTER: 20,
  PLAYER_GRAPH: 10,
} as const;

/**
 * Build a tap from a bare analyser provider and a live-truth
 * function — the form a module with its own graph writes in one
 * line when it registers itself with the visualizer.
 */
export function createAnalyserTap(
  id: string,
  provideAnalyser: () => AnalyserNode | null,
  isLive: () => boolean,
): VisualizerTap {
  return { id, analyser: provideAnalyser, isLive };
}

interface PlayerGraphShape {
  masterOutputGain?: AudioNode;
}

interface LinerWindowShape {
  __liner_audio_context?: AudioContext;
  __liner_pitch_graph?: PlayerGraphShape;
}

interface GraphConnection {
  graph: PlayerGraphShape;
  analyser: AnalyserNode;
}

/**
 * The player effects graph as a tap. One analyser, created
 * lazily and rebuilt whenever the graph object is replaced,
 * connected from the graph's master output; it is a sink and
 * passes nothing onward, so it cannot colour the sound.
 */
export class PlayerGraphTap implements VisualizerTap {
  readonly id = VISUALIZER_TAP_ID.PLAYER_GRAPH;
  private connection: GraphConnection | null = null;

  /**
   * The graph this tap reads, or null when there is nothing to
   * tap — reconciling as it goes: when the path vanishes (the
   * effects chain detached, the published graph gone), any
   * analyser built on it is dropped here, exactly as the
   * pre-registry source dropped it on the next sample.
   */
  private resolveMaster(): {
    graph: PlayerGraphShape;
    master: AudioNode;
  } | null {
    if (typeof window === "undefined") return null;
    if (!pitchShifter.isAttached()) {
      this.dropConnection();
      return null;
    }
    const win = window as unknown as LinerWindowShape;
    const graph = win.__liner_pitch_graph;
    const master = graph?.masterOutputGain;
    if (!graph || !master) {
      this.dropConnection();
      return null;
    }
    return { graph, master };
  }

  private dropConnection(): void {
    if (!this.connection) return;
    try {
      this.connection.analyser.disconnect();
    } catch {
      // Already detached with its graph; nothing to clean.
    }
    this.connection = null;
  }

  isLive(): boolean {
    return this.resolveMaster() !== null;
  }

  analyser(): AnalyserNode | null {
    const resolved = this.resolveMaster();
    if (!resolved) return null;
    if (this.connection && this.connection.graph === resolved.graph) {
      return this.connection.analyser;
    }
    this.dropConnection();
    try {
      const ctx = resolved.master.context as AudioContext;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      resolved.master.connect(analyser);
      this.connection = { graph: resolved.graph, analyser };
      return analyser;
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.dropConnection();
  }
}

interface TapRegistration {
  tap: VisualizerTap;
  priority: number;
  seq: number;
}

/**
 * The tap registry: an ordered set of taps plus the sampling
 * walk. Priority decides (higher first); equal priorities keep
 * registration order. A tap is skipped when its truth function
 * says its path is gone, when it has no analyser to read, when
 * its context is not running, or when its bins read silence —
 * each skip falls through to the next tap, and when every tap
 * is skipped the sample is the resting profile.
 */
export class VisualizerTapRegistry {
  private entries: TapRegistration[] = [];
  private nextSeq = 0;
  private readonly binsByAnalyser = new WeakMap<
    AnalyserNode,
    Uint8Array<ArrayBuffer>
  >();

  /**
   * Register a tap at a priority. If a tap with the same id is
   * already registered it is disposed and replaced. Returns the
   * unregister function (a no-op once this registration has been
   * replaced or removed).
   */
  register(tap: VisualizerTap, priority: number): () => void {
    const existing = this.entries.find((entry) => entry.tap.id === tap.id);
    if (existing) {
      existing.tap.dispose?.();
      this.entries = this.entries.filter((entry) => entry !== existing);
    }
    const entry: TapRegistration = { tap, priority, seq: this.nextSeq };
    this.nextSeq += 1;
    this.entries.push(entry);
    return () => {
      this.entries = this.entries.filter((candidate) => candidate !== entry);
    };
  }

  /** The current registrations, in the order samples consult them. */
  registrations(): ReadonlyArray<{ id: string; priority: number }> {
    return this.ordered().map((entry) => ({
      id: entry.tap.id,
      priority: entry.priority,
    }));
  }

  private ordered(): TapRegistration[] {
    return [...this.entries].sort(
      (a, b) => b.priority - a.priority || a.seq - b.seq,
    );
  }

  sample(barCount: number): VisualizerSample {
    const bars = new Float32Array(barCount);
    for (const entry of this.ordered()) {
      const { tap } = entry;
      let analyser: AnalyserNode | null = null;
      try {
        if (!tap.isLive()) continue;
        analyser = tap.analyser();
      } catch {
        // A tap that throws while being asked has no truth to
        // offer this frame; fall through rather than freeze.
        continue;
      }
      if (!analyser) continue;
      if (analyser.context.state !== "running") continue;
      let bins = this.binsByAnalyser.get(analyser);
      if (!bins || bins.length !== analyser.frequencyBinCount) {
        bins = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        this.binsByAnalyser.set(analyser, bins);
      }
      analyser.getByteFrequencyData(bins);
      if (!binsHaveSignal(bins)) continue;
      mapBinsToBars(bins, barCount, bars);
      return { live: true, bars, bass: bassEnergyOf(bins) };
    }
    for (let i = 0; i < barCount; i += 1) bars[i] = restProfileAt(i);
    return { live: false, bars, bass: null };
  }

  /** Dispose every registered tap and empty the registry. */
  dispose(): void {
    for (const entry of this.entries) entry.tap.dispose?.();
    this.entries = [];
  }
}

/**
 * The app's one registry — the visualizer consumes from here,
 * and future unlocks register into here. The player-graph tap is
 * its first registration: until another tap is registered, every
 * sample behaves exactly as the pre-registry source did.
 */
export const visualizerTaps = new VisualizerTapRegistry();
visualizerTaps.register(
  new PlayerGraphTap(),
  VISUALIZER_TAP_PRIORITY.PLAYER_GRAPH,
);

/**
 * Register a tap with the app's visualizer registry — the one
 * call an unlock makes to light the visualizer from a new sound
 * path. Returns the unregister function.
 */
export function registerVisualizerTap(
  tap: VisualizerTap,
  priority: number,
): () => void {
  return visualizerTaps.register(tap, priority);
}
