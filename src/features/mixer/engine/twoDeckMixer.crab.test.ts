import { describe, expect, it } from "vitest";
import {
  flatCurve,
  OPEN_FILTER_HZ,
  type RecipeLoopBlock,
  type TransitionRecipe,
} from "./recipe";
import { TwoDeckMixer } from "./twoDeckMixer";

// The crab scratch, performed (the revamp's crab slice, on R2's
// machinery). Same recording fake as the R2 scratch suite: every
// rate and gate event is captured and paramAt reconstructs what a
// listener hears, so the crab's identity is asserted on the two
// axes that make it NOT a renamed flare — the gate rests CLOSED
// and is tapped open in finger bursts (a ~15–25% duty cycle
// against the flare's open middle), and the hand is ASYMMETRIC
// (a long forward drag repaid by a return three times as steep).
// The advance-exact invariant holds by the same construction as
// every scratch: the rate integral over the window equals
// unperturbed playback.

interface ParamEvent {
  type: "set" | "ramp" | "exp-ramp" | "curve" | "cancel" | "target";
  value: number | Float32Array;
  time: number;
  duration?: number;
}

class FakeParam {
  value = 0;
  events: ParamEvent[] = [];
  setValueAtTime(value: number, time: number): void {
    this.events.push({ type: "set", value, time });
    this.value = value;
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ type: "ramp", value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.events.push({ type: "exp-ramp", value, time });
  }
  setValueCurveAtTime(
    values: Float32Array,
    time: number,
    duration: number,
  ): void {
    this.events.push({ type: "curve", value: values, time, duration });
  }
  cancelScheduledValues(time: number): void {
    this.events.push({ type: "cancel", value: 0, time });
  }
  setTargetAtTime(value: number, time: number): void {
    this.events.push({ type: "target", value, time });
  }
}

class FakeGain {
  gain = new FakeParam();
  connect(): void {}
}
class FakeFilter {
  type = "";
  frequency = new FakeParam();
  gain = new FakeParam();
  Q = { value: 0 };
  connect(): void {}
}
class FakeDelay {
  delayTime = new FakeParam();
  connect(): void {}
}
class FakeSource {
  buffer: unknown = null;
  playbackRate = new FakeParam();
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  startedWith: { when: number; offset: number } | null = null;
  stoppedAt: number | null = null;
  constructor() {
    this.playbackRate.value = 1;
  }
  connect(): void {}
  start(when: number, offset: number): void {
    this.startedWith = { when, offset };
  }
  stop(when?: number): void {
    this.stoppedAt = when ?? 0;
  }
}
class FakeContext {
  currentTime = 1000;
  destination = {};
  sources: FakeSource[] = [];
  delays: FakeDelay[] = [];
  createGain(): FakeGain {
    return new FakeGain();
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }
  createDelay(): FakeDelay {
    const d = new FakeDelay();
    this.delays.push(d);
    return d;
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

/** The R2 suites' reconstruction: the value heard at time t. */
function paramAt(events: ParamEvent[], t: number): number {
  const ordered = [...events].sort((a, b) => a.time - b.time);
  let prevTime = -Infinity;
  let prevValue = 1;
  let value = 1;
  for (const e of ordered) {
    if (e.type === "curve" || e.type === "cancel" || e.type === "target") {
      continue;
    }
    const target = e.value as number;
    if (e.time > t) {
      if (prevTime === -Infinity) return prevValue;
      const span = e.time - prevTime;
      if (span <= 0) return target;
      const phase = (t - prevTime) / span;
      if (e.type === "ramp") return prevValue + (target - prevValue) * phase;
      if (e.type === "exp-ramp") {
        return prevValue * Math.pow(target / prevValue, phase);
      }
      return prevValue;
    }
    value = target;
    prevTime = e.time;
    prevValue = target;
  }
  return value;
}

/** The position covered between two moments: the rate integral. */
function integrateRate(
  events: ParamEvent[],
  from: number,
  to: number,
  steps = 4000,
): number {
  let sum = 0;
  const dt = (to - from) / steps;
  for (let i = 0; i < steps; i += 1) {
    sum += paramAt(events, from + (i + 0.5) * dt);
  }
  return sum * dt;
}

const buffer = (duration = 240): AudioBuffer =>
  ({ duration }) as unknown as AudioBuffer;

function flatEq() {
  return flatCurve("eq-gain", "decibels", 0);
}

/** A rate-1 cut recipe at 120 BPM, anchored at A=120 s, lead-in 4 s. */
function scratchRecipe(moves: RecipeLoopBlock[]): TransitionRecipe {
  return {
    version: 1,
    preset: "cut",
    overlap: {
      startAMs: 120_000,
      startBMs: 0,
      durationMs: 500,
      durationBars: 0.25,
      beatmatched: false,
      rateA: 1,
      rateB: 1,
      stretchB: null,
      bpmA: 120,
      bpmB: 120,
    },
    leadInSec: 4,
    automation: {
      volumeOut: flatCurve("linear-gain", "linear", 1),
      volumeIn: flatCurve("linear-gain", "linear", 1),
      eqOut: { low: flatEq(), mid: flatEq(), high: flatEq() },
      eqIn: { low: flatEq(), mid: flatEq(), high: flatEq() },
      filterOut: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      filterIn: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      rateB: flatCurve("rate", "ratio", 1),
      echoSendOut: flatCurve("dry-wet", "percent", 0),
      echoSendIn: flatCurve("dry-wet", "percent", 0),
    },
    loops: moves,
    fx: {},
    fingerprints: { aAudioHash: null, bAudioHash: null, analysisVersion: null },
    fallback: { kind: "cut", note: "test fallback" },
    evidence: {
      entryReason: "test",
      exitReason: "test",
      vocalOverlap: 0,
      vocalEvidence: "trusted",
      tempoStretch: 0,
      keyScore: null,
      refereeShortened: false,
    },
  };
}

function newMixer(): { ctx: FakeContext; mixer: TwoDeckMixer } {
  const ctx = new FakeContext();
  const mixer = new TwoDeckMixer(ctx as unknown as AudioContext);
  return { ctx, mixer };
}

/** The scratch gate's recorded events for a deck (post-flip access). */
function gateEvents(deck: unknown): ParamEvent[] {
  return (deck as { scratchGate: { gain: FakeParam } }).scratchGate.gain.events;
}

/** The authored crab shape: 2 beats, 2 strokes, excursion 0.5, 3 taps. */
function crabBlock(side: "A" | "B", startMs: number): RecipeLoopBlock {
  return {
    type: "scratch",
    side,
    startMs,
    endMs: startMs + 1_000,
    beats: 2,
    technique: "crab",
    strokes: 2,
    excursionBeats: 0.5,
    tapsPerStroke: 3,
  };
}

// A crab on B at track time 2 s: B starts at ctx 1004 at rate 1,
// so the window is [1006, 1007] on the clock. Each stroke pair is
// 0.5 s: a forward drag of 0.375 s and a return of 0.125 s. The
// excursion (0.5 beats = 0.25 s of audio) over the forward drag
// is a slope of 2/3: forward at 5/3, return at 1 − 3×(2/3) = −1.
// Taps sit at the centres of the forward drag's thirds: offsets
// 0.0625, 0.1875, 0.3125 within each stroke.
const WINDOW_START = 1006;
const WINDOW_END = 1007;

describe("performRecipe — the crab on the incoming deck", () => {
  it("the gate rests CLOSED and is tapped open in bursts — blips, not an open middle", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    mixer.performRecipe(buffer(), scratchRecipe([crabBlock("B", 2_000)]), {});

    const gate = gateEvents(mixer.currentDeck);
    // Shut at the window's start — the only technique that rests
    // closed (the flare is shut at its extremes but opens through
    // each stroke's middle; sampled mid-stroke the crab is shut).
    expect(paramAt(gate, WINDOW_START)).toBeCloseTo(0, 6);
    expect(paramAt(gate, WINDOW_START + 0.125)).toBeCloseTo(0, 6);
    // Open at every tap centre, in BOTH strokes: six blips.
    for (const offset of [0.0705, 0.1955, 0.3205, 0.5705, 0.6955, 0.8205]) {
      expect(paramAt(gate, WINDOW_START + offset)).toBeCloseTo(1, 6);
    }
    // Shut between taps and through both return quarters — no tap
    // ever falls where the hand flies back.
    expect(paramAt(gate, WINDOW_START + 0.44)).toBeCloseTo(0, 6);
    expect(paramAt(gate, WINDOW_START + 0.94)).toBeCloseTo(0, 6);
    // Exactly six openings were written: strokes × tapsPerStroke.
    expect(gate.filter((e) => e.type === "ramp" && e.value === 1).length).toBe(
      6,
    );
    // Closed-dominant, measured: the share of the window spent
    // above half-open is a blip's share, far under the flare's
    // open middle or the transformer's even alternation.
    let above = 0;
    const samples = 2000;
    for (let i = 0; i < samples; i += 1) {
      const t = WINDOW_START + (i + 0.5) / samples;
      if (paramAt(gate, t) > 0.5) above += 1;
    }
    expect(above / samples).toBeGreaterThan(0.02);
    expect(above / samples).toBeLessThan(0.25);
    // Open at the window's end: the gate is home when the
    // performance is over, as every scratch leaves it.
    expect(paramAt(gate, WINDOW_END)).toBeCloseTo(1, 6);
    // And the deck was not stopped: a scratch returns its deck.
    expect(ctx.sources[1].stoppedAt).toBeNull();
  });

  it("the hand is ASYMMETRIC — a long drag repaid by a return three times as steep — and advance-exact", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    mixer.performRecipe(buffer(), scratchRecipe([crabBlock("B", 2_000)]), {});

    const rate = ctx.sources[1].playbackRate.events;
    // Mid-forward: dragged to 5/3. Mid-return: pulled to −1 —
    // the return's deviation from base (2) is exactly three
    // times the forward's (2/3).
    expect(paramAt(rate, WINDOW_START + 0.1875)).toBeCloseTo(5 / 3, 6);
    expect(paramAt(rate, WINDOW_START + 0.4375)).toBeCloseTo(-1, 6);
    // The forward value still stands late in its phase (0.36 s
    // in — a symmetric hand would already have turned), and the
    // second stroke repeats the shape.
    expect(paramAt(rate, WINDOW_START + 0.36)).toBeCloseTo(5 / 3, 6);
    expect(paramAt(rate, WINDOW_START + 0.6875)).toBeCloseTo(5 / 3, 6);
    expect(paramAt(rate, WINDOW_START + 0.9375)).toBeCloseTo(-1, 6);
    // Home at the window's end, and advance-exact: the position
    // covered inside the window is precisely unperturbed play.
    expect(paramAt(rate, WINDOW_END)).toBeCloseTo(1, 6);
    expect(integrateRate(rate, WINDOW_START, WINDOW_END)).toBeCloseTo(1, 3);
  });

  it("the window rejoins B's written rate curve — a crab inside a 0.96 hold", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = scratchRecipe([]);
    recipe.preset = "beatmatched-fade";
    recipe.overlap = {
      startAMs: 100_000,
      startBMs: 7_680,
      durationMs: 8_000,
      durationBars: 4,
      beatmatched: true,
      rateA: 1,
      rateB: 0.96,
      stretchB: null,
      bpmA: 120,
      bpmB: 125,
    };
    recipe.automation.rateB = {
      kind: "rate",
      unit: "ratio",
      points: [
        { atMs: 0, value: 0.96 },
        { atMs: 8_000, value: 0.96 },
        { atMs: 11_000, value: 1 },
      ],
    };
    // The R2 rejoin fixture's geometry with a crab in it: wall
    // window [1005, 1006], the curve FLAT at 0.96 across it. The
    // excursion (0.5 beats of B at 125 BPM = 0.24 s) over the
    // 0.375 s forward drag is a slope of 0.64: forward at 1.60,
    // return at 0.96 − 3×0.64 = −0.96.
    recipe.loops = [{ ...crabBlock("B", 8_640), endMs: 9_600 }];
    mixer.performRecipe(buffer(), recipe, {});

    const events = ctx.sources[1].playbackRate.events;
    const start = 1004 + 0.96 / 0.96;
    expect(paramAt(events, start + 0.1875)).toBeCloseTo(1.6, 6);
    expect(paramAt(events, start + 0.4375)).toBeCloseTo(-0.96, 6);
    // Rejoined at the CURVE's value at the window's end.
    expect(paramAt(events, start + 1)).toBeCloseTo(0.96, 6);
    // And the curve's own later return to 1 survives.
    expect(paramAt(events, 1004 + 11)).toBeCloseTo(1, 6);
    // The gate tapped its six blips on the incoming deck.
    const gate = gateEvents(mixer.currentDeck);
    expect(gate.filter((e) => e.type === "ramp" && e.value === 1).length).toBe(
      6,
    );
  });
});

describe("performRecipe — the crab on the outgoing deck", () => {
  it("a crab-out performs on A's own controls, and the deck's stop waits for the window", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    // A crab at A's anchor (120 s) inside a written overlap of
    // only 0.5 s: the window outlasts the overlap, so the deck
    // must not be cut off at the blend's written end.
    mixer.performRecipe(buffer(), scratchRecipe([crabBlock("A", 120_000)]), {});

    const rate = ctx.sources[0].playbackRate.events;
    expect(paramAt(rate, 1004.1875)).toBeCloseTo(5 / 3, 6);
    expect(paramAt(rate, 1004.4375)).toBeCloseTo(-1, 6);
    expect(paramAt(rate, 1005)).toBeCloseTo(1, 6);
    expect(integrateRate(rate, 1004, 1005)).toBeCloseTo(1, 3);
    // A is now the idle deck (the mixer flipped): its gate
    // carried the taps.
    const gate = gateEvents(mixer.nextDeck);
    expect(paramAt(gate, 1004.0705)).toBeCloseTo(1, 6);
    expect(paramAt(gate, 1004.44)).toBeCloseTo(0, 6);
    // The stop waits for the window (1005), not the overlap (1004.5).
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(1005.05, 6);
  });

  it("an A-side crab on an anchorless recipe falls back instead of guessing a position", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = scratchRecipe([crabBlock("A", 120_000)]);
    recipe.overlap.startAMs = null;
    const times = mixer.performRecipe(buffer(), recipe, {});
    expect(times.blendEndCtxTime).toBe(times.blendStartCtxTime);
    expect(ctx.sources[0].playbackRate.events).toEqual([]);
    for (const e of gateEvents(mixer.nextDeck)) {
      expect(e.time).toBeLessThan(times.blendStartCtxTime);
    }
  });
});
