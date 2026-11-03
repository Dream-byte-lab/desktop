import { describe, expect, it } from "vitest";
import {
  flatCurve,
  OPEN_FILTER_HZ,
  type RecipeLoopBlock,
  type TransitionRecipe,
} from "./recipe";
import { TwoDeckMixer } from "./twoDeckMixer";

// The revamp's R2 — the scratch engine, performed. Same recording
// fake as the R1 jog suites: every rate and gate event the
// executor schedules is captured, and paramAt reconstructs the
// value a listener hears at a moment, so each technique's AUDIBLE
// signature is asserted as a pair of curves — the hand (rate) and
// the fader (gate). The invariant under every technique: the hand
// is advance-exact (the position integral over the window equals
// unperturbed playback) and both controls are home at the
// window's end.

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
 * The value a listener hears at time t, reconstructed from the
 * scheduled events with Web Audio semantics (the jog suites'
 * rateAt, applied to any parameter): a ramp interpolates from the
 * previous event's endpoint, an exponential ramp follows its
 * power curve, anything else holds the standing value. The fake
 * records events in CALL order, but a real parameter's timeline
 * is time-ordered — and the scratch executor deliberately
 * schedules out of order (a take-over cancels, then a tail is
 * re-scheduled) — so the reconstruction sorts first, stably:
 * events at the same time apply in the order they were scheduled.
 */
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

/**
 * The position a deck's playhead covers between two moments: the
 * integral of its rate curve. The advance-exact invariant is the
 * claim that this equals base × span over a scratch window.
 */
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

// A 2-beat baby/chirp/flare window on B at track time 2 s: B starts
// at ctx 1004 at rate 1, so the window is [1006, 1007] on the
// clock, strokes are 0.25 s each way, and an excursion of 0.75
// beats (0.375 s of audio) over a 0.25 s stroke is a slope of 1.5:
// forward at 2.5, back at −0.5 — the record audibly reverses.
const WINDOW_START = 1006;
const WINDOW_END = 1007;

describe("performRecipe — scratches on the incoming deck", () => {
  it("baby: the rate oscillates through zero, the gate NEVER moves, and the position is advance-exact", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = scratchRecipe([
      {
        type: "scratch",
        side: "B",
        startMs: 2_000,
        endMs: 3_000,
        beats: 2,
        technique: "baby",
        strokes: 2,
        excursionBeats: 0.75,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    const events = ctx.sources[1].playbackRate.events;
    // Forward stroke: pushed to 2.5. Return stroke: pulled to
    // −0.5 — backwards through zero, the baby scratch's sound.
    expect(paramAt(events, WINDOW_START + 0.125)).toBeCloseTo(2.5, 6);
    expect(paramAt(events, WINDOW_START + 0.375)).toBeCloseTo(-0.5, 6);
    expect(paramAt(events, WINDOW_START + 0.625)).toBeCloseTo(2.5, 6);
    // Home at the window's end: the written rate, exactly.
    expect(paramAt(events, WINDOW_END)).toBeCloseTo(1, 6);
    // Advance-exact: the position covered inside the window is
    // precisely what unperturbed playback would have covered.
    expect(integrateRate(events, WINDOW_START, WINDOW_END)).toBeCloseTo(1, 3);
    // The fader never moved — a baby scratch is all hand.
    expect(gateEvents(mixer.currentDeck)).toEqual([]);
    // And the deck was not stopped: a scratch returns its deck.
    expect(ctx.sources[1].stoppedAt).toBeNull();
  });

  it("chirp: the gate CLOSES on the push and OPENS on the pull, over the same hand", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = scratchRecipe([
      {
        type: "scratch",
        side: "B",
        startMs: 2_000,
        endMs: 3_000,
        beats: 2,
        technique: "chirp",
        strokes: 2,
        excursionBeats: 0.75,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    const rate = ctx.sources[1].playbackRate.events;
    expect(paramAt(rate, WINDOW_START + 0.125)).toBeCloseTo(2.5, 6);
    expect(paramAt(rate, WINDOW_START + 0.375)).toBeCloseTo(-0.5, 6);

    const gate = gateEvents(mixer.currentDeck);
    expect(gate.length).toBeGreaterThan(0);
    // Mid-forward (the push): the gate is SHUT — the forward
    // stroke is silent. Mid-return (the pull): the gate is OPEN —
    // the pull is what a chirp lets you hear.
    expect(paramAt(gate, WINDOW_START + 0.125)).toBeCloseTo(0, 6);
    expect(paramAt(gate, WINDOW_START + 0.375)).toBeCloseTo(1, 6);
    expect(paramAt(gate, WINDOW_START + 0.625)).toBeCloseTo(0, 6);
    expect(paramAt(gate, WINDOW_START + 0.875)).toBeCloseTo(1, 6);
    // Open at the window's end: the deck returns to honest play.
    expect(paramAt(gate, WINDOW_END)).toBeCloseTo(1, 6);
  });

  it("transformer: a SLOW hand under a gate clicking at the stated rhythm", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    // Four beats (2 s), one slow cycle, excursion 0.4 beats over a
    // 1 s stroke: slope 0.2 — the hand drags at 1.2 / 0.8 and
    // never reverses. The rhythm is the fader's: 2 clicks per
    // beat, 8 clicks across the window.
    const recipe = scratchRecipe([
      {
        type: "scratch",
        side: "B",
        startMs: 2_000,
        endMs: 4_000,
        beats: 4,
        technique: "transformer",
        strokes: 1,
        excursionBeats: 0.4,
        clicksPerBeat: 2,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    const rate = ctx.sources[1].playbackRate.events;
    expect(paramAt(rate, WINDOW_START + 0.5)).toBeCloseTo(1.2, 6);
    expect(paramAt(rate, WINDOW_START + 1.5)).toBeCloseTo(0.8, 6);
    expect(paramAt(rate, WINDOW_START + 2)).toBeCloseTo(1, 6);
    expect(integrateRate(rate, WINDOW_START, WINDOW_START + 2)).toBeCloseTo(
      2,
      3,
    );

    const gate = gateEvents(mixer.currentDeck);
    // Clicks land every quarter second: shut after the first,
    // open after the second, alternating — and the odd count is
    // corrected so the gate is OPEN at the window's end.
    expect(paramAt(gate, WINDOW_START + 0.3)).toBeCloseTo(0, 6);
    expect(paramAt(gate, WINDOW_START + 0.6)).toBeCloseTo(1, 6);
    expect(paramAt(gate, WINDOW_START + 0.85)).toBeCloseTo(0, 6);
    expect(paramAt(gate, WINDOW_START + 2)).toBeCloseTo(1, 6);
  });

  it("flare: the gate is shut AT each stroke extreme and open through the middle", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = scratchRecipe([
      {
        type: "scratch",
        side: "B",
        startMs: 2_000,
        endMs: 3_000,
        beats: 2,
        technique: "flare",
        strokes: 2,
        excursionBeats: 0.75,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    const gate = gateEvents(mixer.currentDeck);
    // The leading extreme: shut. Mid-stroke: open. The next
    // extreme (0.25 s later): shut again — the 1-click flare's
    // signature, clicks at the ends and sound in the middle.
    expect(paramAt(gate, WINDOW_START)).toBeCloseTo(0, 6);
    expect(paramAt(gate, WINDOW_START + 0.125)).toBeCloseTo(1, 6);
    expect(paramAt(gate, WINDOW_START + 0.25)).toBeCloseTo(0, 6);
    expect(paramAt(gate, WINDOW_START + 0.375)).toBeCloseTo(1, 6);
    // The final extreme is the release: open exactly at the end.
    expect(paramAt(gate, WINDOW_END)).toBeCloseTo(1, 6);
    // The hand is the baby's hand underneath the fader work.
    const rate = ctx.sources[1].playbackRate.events;
    expect(paramAt(rate, WINDOW_START + 0.125)).toBeCloseTo(2.5, 6);
    expect(integrateRate(rate, WINDOW_START, WINDOW_END)).toBeCloseTo(1, 3);
  });

  it("the window rejoins B's written rate curve — a later rate return still happens on schedule", () => {
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
    // A 2-beat baby starting 960 ms of B's track time into the
    // blend: wall offset 960/0.96 = 1000 ms, wall length
    // 2 × 0.48 / 0.96 = 1 s. The curve is FLAT across the window
    // (0.96), so the hand bends around 0.96: slope
    // (0.75 × 0.48) / 0.25 = 1.44 → 2.4 forward, −0.48 back.
    recipe.loops = [
      {
        type: "scratch",
        side: "B",
        startMs: 8_640,
        endMs: 9_600,
        beats: 2,
        technique: "baby",
        strokes: 2,
        excursionBeats: 0.75,
      },
    ];
    mixer.performRecipe(buffer(), recipe, {});

    const events = ctx.sources[1].playbackRate.events;
    // Knot-scheduled, not sampled: no setValueCurveAtTime owns
    // this parameter (that is the nudge fold's writer, not ours).
    expect(events.some((e) => e.type === "curve")).toBe(false);
    const start = 1004 + 0.96 / 0.96;
    expect(paramAt(events, start + 0.125)).toBeCloseTo(2.4, 3);
    expect(paramAt(events, start + 0.375)).toBeCloseTo(-0.48, 3);
    // At the window's end the rate is the CURVE's value there —
    // rejoined, not merely returned to 1.
    expect(paramAt(events, start + 1)).toBeCloseTo(0.96, 6);
    // And the curve's own return, three seconds later, survives.
    expect(paramAt(events, 1004 + 11)).toBeCloseTo(1, 6);
  });
});

describe("performRecipe — scratches on the outgoing deck", () => {
  it("a scratch-out performs on A's own controls, and the deck's stop waits for the window", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    // A 2-beat chirp at A's anchor (120 s), inside a written
    // overlap of only 0.5 s: the window outlasts the overlap, so
    // the deck must not be cut off at the blend's written end.
    const recipe = scratchRecipe([
      {
        type: "scratch",
        side: "A",
        startMs: 120_000,
        endMs: 121_000,
        beats: 2,
        technique: "chirp",
        strokes: 2,
        excursionBeats: 0.75,
      },
    ]);
    mixer.performRecipe(buffer(), recipe, {});

    const rate = ctx.sources[0].playbackRate.events;
    expect(paramAt(rate, 1004.125)).toBeCloseTo(2.5, 6);
    expect(paramAt(rate, 1004.375)).toBeCloseTo(-0.5, 6);
    expect(paramAt(rate, 1005)).toBeCloseTo(1, 6);
    expect(integrateRate(rate, 1004, 1005)).toBeCloseTo(1, 3);
    // A is now the idle deck (the mixer flipped): its gate
    // carried the chirp's pattern.
    const gate = gateEvents(mixer.nextDeck);
    expect(paramAt(gate, 1004.125)).toBeCloseTo(0, 6);
    expect(paramAt(gate, 1004.375)).toBeCloseTo(1, 6);
    // The stop waits for the window (1005), not the overlap (1004.5).
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(1005.05, 6);
  });

  it("an A-side scratch on an anchorless recipe falls back instead of guessing a position", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const recipe = scratchRecipe([
      {
        type: "scratch",
        side: "A",
        startMs: 120_000,
        endMs: 121_000,
        beats: 2,
        technique: "baby",
        strokes: 2,
        excursionBeats: 0.75,
      },
    ]);
    recipe.overlap.startAMs = null;
    const times = mixer.performRecipe(buffer(), recipe, {});
    expect(times.blendEndCtxTime).toBe(times.blendStartCtxTime);
    expect(ctx.sources[0].playbackRate.events).toEqual([]);
    // The outgoing gate carries nothing past playNow's reset —
    // the fallback performed no fader work on it.
    for (const e of gateEvents(mixer.nextDeck)) {
      expect(e.time).toBeLessThan(times.blendStartCtxTime);
    }
  });
});
