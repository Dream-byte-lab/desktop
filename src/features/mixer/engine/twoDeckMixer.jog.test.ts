import { describe, expect, it } from "vitest";
import {
  flatCurve,
  OPEN_FILTER_HZ,
  type RecipeLoopBlock,
  type TransitionRecipe,
} from "./recipe";
import { TwoDeckMixer } from "./twoDeckMixer";

// The revamp's R1 — jog mechanics, performed. The recording fake
// captures every rate event the executor schedules, and rateAt
// reconstructs the rate a listener would hear at a moment, so each
// mechanic's AUDIBLE signature is asserted as a curve: a vinyl stop
// falls fast, a brake falls gradually, a spinback runs negative, a
// nudge bends and comes back.

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

/**
 * The rate a listener hears at time t, reconstructed from the
 * scheduled events with Web Audio semantics: a ramp interpolates
 * from the previous event's endpoint, an exponential ramp follows
 * its power curve, anything else holds the standing value.
 */
function rateAt(events: ParamEvent[], t: number): number {
  let prevTime = -Infinity;
  let prevValue = 1;
  let value = 1;
  for (const e of events) {
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

const buffer = (duration = 240): AudioBuffer =>
  ({ duration }) as unknown as AudioBuffer;

function flatEq() {
  return flatCurve("eq-gain", "decibels", 0);
}

/** A rate-1 cut recipe at 120 BPM, anchored at A=120 s, lead-in 4 s. */
function jogRecipe(moves: RecipeLoopBlock[]): TransitionRecipe {
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

describe("performRecipe — jog moves on the outgoing deck", () => {
  it("vinyl stop: the rate falls FAST to the floor, and the deck's stop waits for the move", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    // A 1-beat stop (0.5 s) inside a written overlap of only 0.25 s:
    // the move outlasts the overlap, so the deck must not be cut
    // off at the blend's written end.
    const recipe = jogRecipe([
      {
        type: "vinyl-stop",
        side: "A",
        startMs: 120_000,
        endMs: 120_500,
        beats: 1,
      },
    ]);
    recipe.overlap.durationMs = 250;
    mixer.performRecipe(buffer(), recipe, {});

    const events = ctx.sources[0].playbackRate.events;
    expect(events).toEqual([
      { type: "set", value: 1, time: 1004 },
      { type: "exp-ramp", value: 0.02, time: 1004.5 },
    ]);
    // Halfway through, an exponential fall is already at ~14% —
    // the pitch has collapsed, not drifted.
    expect(rateAt(events, 1004.25)).toBeCloseTo(Math.sqrt(0.02), 3);
    expect(rateAt(events, 1004.5)).toBeCloseTo(0.02, 6);
    // The deck stops when the MOVE ends (1004.5), not at blendEnd.
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(1004.55, 6);
  });

  it("brake: the rate falls GRADUALLY — still half-speed at the midpoint — then settles", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = jogRecipe([
      { type: "brake", side: "A", startMs: 120_000, endMs: 122_000, beats: 4 },
    ]);
    recipe.overlap.durationMs = 2000;
    mixer.performRecipe(buffer(), recipe, {});

    const events = ctx.sources[0].playbackRate.events;
    expect(events).toEqual([
      { type: "set", value: 1, time: 1004 },
      { type: "ramp", value: 0.3, time: 1005.4 },
      { type: "exp-ramp", value: 0.02, time: 1006 },
    ]);
    // The contrast with the vinyl stop is the point: at the
    // midpoint a brake is still turning at half speed.
    expect(rateAt(events, 1005)).toBeCloseTo(0.5, 6);
    expect(rateAt(events, 1005)).toBeGreaterThan(0.35);
    expect(rateAt(events, 1006)).toBeCloseTo(0.02, 6);
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(1006.05, 6);
  });

  it("spinback: the rate drives NEGATIVE to the peak and the deck stops at the spin's end", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = jogRecipe([
      {
        type: "spinback",
        side: "A",
        startMs: 120_000,
        endMs: 121_000,
        beats: 2,
        peakRate: -3.5,
      },
    ]);
    recipe.overlap.durationMs = 1000;
    mixer.performRecipe(buffer(), recipe, {});

    const events = ctx.sources[0].playbackRate.events;
    expect(events.slice(0, 2)).toEqual([
      { type: "set", value: 1, time: 1004 },
      { type: "ramp", value: -3.5, time: 1004.15 },
    ]);
    // The decay target is peak × 0.8 — a computed value, asserted
    // to tolerance rather than bit-exactness.
    expect(events[2].type).toBe("ramp");
    expect(events[2].time).toBe(1005);
    expect(events[2].value as number).toBeCloseTo(-2.8, 9);
    // Mid-spin the track is running backwards, hard.
    expect(rateAt(events, 1004.5)).toBeLessThan(-2);
    expect(rateAt(events, 1004.15)).toBeCloseTo(-3.5, 6);
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(1005.05, 6);
  });

  it("nudge: the rate bends to base × bend at the midpoint and RETURNS", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = jogRecipe([
      {
        type: "nudge",
        side: "A",
        startMs: 120_000,
        endMs: 121_000,
        beats: 2,
        bend: 1.04,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    const events = ctx.sources[0].playbackRate.events;
    expect(events).toEqual([
      { type: "set", value: 1, time: 1004 },
      { type: "ramp", value: 1.04, time: 1004.5 },
      { type: "ramp", value: 1, time: 1005 },
    ]);
    expect(rateAt(events, 1004.5)).toBeCloseTo(1.04, 6);
    expect(rateAt(events, 1004.25)).toBeCloseTo(1.02, 6);
    // Returned: a nudge is not a tempo change.
    expect(rateAt(events, 1005)).toBeCloseTo(1, 6);
    // And the deck's stop is the JOIN's own (blendEnd + 0.05) — a
    // nudge, unlike a stop move, does not extend it.
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(1004.55, 6);
  });

  it("an A-side move on an anchorless recipe falls back instead of guessing a position", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = jogRecipe([
      {
        type: "vinyl-stop",
        side: "A",
        startMs: 120_000,
        endMs: 120_500,
        beats: 1,
      },
    ]);
    recipe.overlap.startAMs = null;
    const times = mixer.performRecipe(buffer(), recipe, {});
    expect(times.blendEndCtxTime).toBe(times.blendStartCtxTime);
    expect(ctx.sources[0].playbackRate.events).toEqual([]);
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(
      times.blendStartCtxTime + 0.05,
      6,
    );
  });
});

describe("performRecipe — jog moves on the incoming deck", () => {
  it("a nudge folds into B's written rate curve as ONE sampled writer", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = jogRecipe([]);
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
    // A 4-beat push (bend 1.03) starting 1 s of B's track time into
    // the blend: wall offset 1000/0.96 ≈ 1041.67 ms, wall length
    // 4 × 0.48 / 0.96 = 2 s, midpoint at ≈ 2041.67 ms.
    recipe.loops = [
      {
        type: "nudge",
        side: "B",
        startMs: 8_680,
        endMs: 10_600,
        beats: 4,
        bend: 1.03,
      },
    ];
    mixer.performRecipe(buffer(), recipe, {});

    const events = ctx.sources[1].playbackRate.events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("curve");
    expect(events[0].time).toBe(1004);
    expect(events[0].duration).toBe(11);
    const values = events[0].value as Float32Array;
    expect(values[0]).toBeCloseTo(0.96, 6);
    // At the bend's midpoint the written 0.96 is multiplied by 1.03.
    const midIndex = Math.round((2041.67 / 11_000) * (values.length - 1));
    expect(values[midIndex]).toBeCloseTo(0.96 * 1.03, 3);
    // After the bend and the return, the rate is home at 1.
    expect(values[values.length - 1]).toBeCloseTo(1, 6);
  });

  it("a stop move on B takes the rate control from its start and stops the deck at its end", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = jogRecipe([
      {
        type: "spinback",
        side: "B",
        startMs: 2_000,
        endMs: 3_000,
        beats: 2,
        peakRate: -3,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    const events = ctx.sources[1].playbackRate.events;
    // The written curve speaks first, then is cancelled at the
    // move's start (1004 + 2 s at rate 1), then the move speaks.
    expect(events).toContainEqual({ type: "cancel", value: 0, time: 1006 });
    expect(events).toContainEqual({ type: "ramp", value: -3, time: 1006.15 });
    expect(rateAt(events, 1006.5)).toBeLessThan(-2);
    expect(ctx.sources[1].stoppedAt).toBeCloseTo(1007.02, 6);
  });
});
