import { describe, expect, it } from "vitest";
import type { TrackAnalysis } from "./analyseTrack";
import type { KeyEstimate } from "./detectKey";
import { recipeFromPlan, type TransitionRecipe } from "./recipe";
import { authorRecipe, planTransition } from "./transitionPlanner";
import { TwoDeckMixer } from "./twoDeckMixer";

// The S5-2 executor, performed against a recording fake AudioContext:
// every automation call the mixer makes is captured, so "what was
// decided is what is heard" is asserted as scheduled events.

interface ParamEvent {
  type: "set" | "ramp" | "curve" | "cancel" | "target";
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

/** The mixer's decks, viewed through the fake nodes they really hold. */
interface FakeDeck {
  gain: { gain: FakeParam };
  bass: { gain: FakeParam };
  mid: { gain: FakeParam };
  high: { gain: FakeParam };
  filter: { frequency: FakeParam };
  bassTrim: { gain: FakeParam };
  echoSend: { gain: FakeParam };
}
const asDeck = (deck: unknown): FakeDeck => deck as FakeDeck;

const buffer = (duration = 240): AudioBuffer =>
  ({ duration }) as unknown as AudioBuffer;

function key(camelot: string, pitchClass: number): KeyEstimate {
  return { tonic: "C", mode: "major", pitchClass, camelot, confidence: 0.9 };
}

function analysis(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: "hash-a",
    ...overrides,
  };
}

/** A clean 120 → 125 pair whose authored recipe is a 16-beat blend. */
function blendFixture(): {
  outgoing: TrackAnalysis;
  incoming: TrackAnalysis;
  recipe: TransitionRecipe;
} {
  const outgoing = analysis();
  const incoming = analysis({
    audioHash: "hash-b",
    beatMap: { bpm: 125, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    drops: [{ timeSec: 15.36, beat: 32, strength: 2 }],
  });
  const recipe = authorRecipe({ outgoing, outgoingPositionSec: 60, incoming });
  if (!recipe) throw new Error("fixture recipe should exist");
  return { outgoing, incoming, recipe };
}

function newMixer(): { ctx: FakeContext; mixer: TwoDeckMixer } {
  const ctx = new FakeContext();
  const mixer = new TwoDeckMixer(ctx as unknown as AudioContext);
  return { ctx, mixer };
}

/** Event lists with times rounded to centiseconds, for exact comparison. */
function rounded(
  events: ParamEvent[],
): { type: string; value: number | Float32Array; time: number }[] {
  return events.map((e) => ({
    type: e.type,
    value: e.value,
    time: Math.round(e.time * 100) / 100,
  }));
}

describe("performRecipe", () => {
  it("performs the authored blend: volume curves, bass swap, rate hold and return", () => {
    const { ctx, mixer } = newMixer();
    const { outgoing, incoming, recipe } = blendFixture();
    mixer.playNow(buffer());
    const inDeck = asDeck(mixer.nextDeck);
    const outDeck = asDeck(mixer.currentDeck);

    const times = mixer.performRecipe(buffer(), recipe, {
      levelGain: 0.8,
      outgoing,
      incoming,
    });

    // Exit at 64 s authored from position 60 → blend 1004 → 1012.
    expect(times).toEqual({ blendStartCtxTime: 1004, blendEndCtxTime: 1012 });
    expect(mixer.currentDeckIndex).toBe(1);

    const gainEvents = inDeck.gain.gain.events;
    expect(gainEvents).toHaveLength(1);
    expect(gainEvents[0].type).toBe("curve");
    expect(gainEvents[0].time).toBe(1004);
    expect(gainEvents[0].duration).toBe(8);
    const values = gainEvents[0].value as Float32Array;
    expect(values[0]).toBeCloseTo(0, 3);
    expect(values[values.length - 1]).toBeCloseTo(1, 3);

    // Bass swap at 8 beats (4 s) into the blend, 20 ms ramp.
    expect(rounded(inDeck.bass.gain.events)).toEqual([
      { type: "set", value: -32, time: 1004 },
      { type: "set", value: -32, time: 1008 },
      { type: "ramp", value: 0, time: 1008.02 },
    ]);
    expect(rounded(outDeck.bass.gain.events)).toEqual([
      { type: "set", value: 0, time: 1000 }, // playNow's own bass reset
      { type: "set", value: 0, time: 1004 },
      { type: "set", value: 0, time: 1008 },
      { type: "ramp", value: -32, time: 1008.02 },
    ]);

    // B started at its anchor (beat 16 at 125 bpm), rate held at
    // 0.96 across the blend, returned over the authored 8 beats.
    const source = ctx.sources[1];
    expect(source.startedWith?.when).toBe(1004);
    expect(source.startedWith?.offset).toBeCloseTo(7.68, 6);
    expect(rounded(source.playbackRate.events)).toEqual([
      { type: "set", value: 0.96, time: 1004 },
      { type: "set", value: 0.96, time: 1012 },
      { type: "ramp", value: 1, time: 1015.84 },
    ]);
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(1012.05, 6);
  });

  it("performs a cut recipe as a point join at the authored lead-in", () => {
    const { ctx, mixer } = newMixer();
    const outgoing = analysis();
    const incoming = analysis({
      audioHash: "hash-b",
      beatMap: { bpm: 140, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
      drops: [{ timeSec: 13.71, beat: 32, strength: 2.2 }],
    });
    const recipe = authorRecipe({
      outgoing,
      outgoingPositionSec: 60,
      incoming,
    });
    if (!recipe || recipe.preset !== "cut") throw new Error("expected a cut");
    mixer.playNow(buffer());
    const inDeck = asDeck(mixer.nextDeck);
    const times = mixer.performRecipe(buffer(), recipe, { outgoing, incoming });
    expect(times.blendStartCtxTime).toBe(1004);
    expect(times.blendEndCtxTime).toBe(1004);
    expect(inDeck.gain.gain.events).toEqual([
      { type: "set", value: 1, time: 1004 },
    ]);
    expect(ctx.sources[1].startedWith?.offset).toBeCloseTo(13.714, 2);
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(1004.05, 6);
  });

  it("arms a loop block on the outgoing deck's live source", () => {
    const { ctx, mixer } = newMixer();
    const outgoing = analysis({
      beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 76 },
      sections: [
        {
          kind: "breakdown",
          startSec: 60,
          endSec: 76,
          startBeat: 120,
          endBeat: 152,
          meanRms: 0.3,
          vocalActivity: 0,
          confidence: 0.9,
        },
      ],
    });
    const incoming = analysis({
      audioHash: "hash-b",
      drops: [{ timeSec: 16, beat: 32, strength: 2 }],
    });
    const recipe = authorRecipe({
      outgoing,
      outgoingPositionSec: 68,
      incoming,
    });
    if (!recipe || recipe.loops.length !== 1)
      throw new Error("expected a loop");
    mixer.playNow(buffer(76));
    mixer.performRecipe(buffer(), recipe, { outgoing, incoming });
    expect(ctx.sources[0].loop).toBe(true);
    expect(ctx.sources[0].loopStart).toBe(60);
    expect(ctx.sources[0].loopEnd).toBe(76);
  });

  it("applies the recipe's echo tuning, and echoOutCurrent restores the defaults", () => {
    const { ctx, mixer } = newMixer();
    const { outgoing, incoming, recipe } = blendFixture();
    recipe.fx.echo = {
      delaySec: 0.375,
      feedback: 0.5,
      wet: 0.4,
      divisionBeats: 0.75,
    };
    mixer.playNow(buffer());
    mixer.performRecipe(buffer(), recipe, { outgoing, incoming });
    const delay = ctx.delays[0];
    expect(delay.delayTime.events).toContainEqual({
      type: "set",
      value: 0.375,
      time: 1004,
    });
    // The network's feedback/wet are private fields; reach in to pin
    // the restore contract (the echo-out's sound must not inherit a
    // recipe's tuning).
    const internals = mixer as unknown as {
      echoFeedback: FakeGain;
      echoWet: FakeGain;
    };
    mixer.echoOutCurrent(120);
    expect(internals.echoFeedback.gain.events).toContainEqual({
      type: "set",
      value: 0.38,
      time: 1000,
    });
    expect(internals.echoWet.gain.events).toContainEqual({
      type: "set",
      value: 0.55,
      time: 1000,
    });
  });

  it("keeps hands off the automation: the manual stage writes only its own nodes", () => {
    const { mixer } = newMixer();
    const { outgoing, incoming, recipe } = blendFixture();
    mixer.playNow(buffer());
    const inDeck = asDeck(mixer.nextDeck);
    const outDeck = asDeck(mixer.currentDeck);
    mixer.performRecipe(buffer(), recipe, { outgoing, incoming });
    const counts = [
      inDeck.gain.gain.events.length,
      inDeck.bass.gain.events.length,
      outDeck.gain.gain.events.length,
      outDeck.bass.gain.events.length,
    ];
    mixer.setCrossfade(0.5);
    mixer.setDeckTrim(0, 0.5);
    mixer.setDeckBassCut(0, true);
    expect([
      inDeck.gain.gain.events.length,
      inDeck.bass.gain.events.length,
      outDeck.gain.gain.events.length,
      outDeck.bass.gain.events.length,
    ]).toEqual(counts);
    expect(outDeck.bassTrim.gain.events.length).toBeGreaterThan(0);
  });

  it("performs the fallback cut when the analyses no longer match the recipe's fingerprints", () => {
    const { ctx, mixer } = newMixer();
    const { outgoing, incoming, recipe } = blendFixture();
    mixer.playNow(buffer());
    const inDeck = asDeck(mixer.nextDeck);
    const times = mixer.performRecipe(buffer(), recipe, {
      outgoing,
      incoming: { ...incoming, audioHash: "a-different-file" },
    });
    expect(times.blendEndCtxTime).toBe(times.blendStartCtxTime);
    expect(inDeck.gain.gain.events).toEqual([
      { type: "set", value: 1, time: times.blendStartCtxTime },
    ]);
    expect(ctx.sources[1].playbackRate.events).toEqual([]);
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(
      times.blendStartCtxTime + 0.05,
      6,
    );
  });

  it("performs the fallback cut for a structurally invalid recipe", () => {
    const { ctx, mixer } = newMixer();
    const { recipe } = blendFixture();
    recipe.overlap.durationMs = -5;
    mixer.playNow(buffer());
    const times = mixer.performRecipe(buffer(), recipe, {});
    expect(times.blendStartCtxTime).toBeCloseTo(1000.1, 6);
    expect(ctx.sources[1].startedWith?.when).toBeCloseTo(1000.1, 6);
  });
});

describe("transitionTo (the legacy seam)", () => {
  it("schedules the same key events as performing the adapted recipe directly", () => {
    const plan = planTransition({
      outgoing: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
      outgoingPositionSec: 60,
      incoming: { bpm: 125, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
      incomingEntryBeat: 32,
    });
    if (!plan) throw new Error("fixture plan should exist");

    const a = newMixer();
    a.mixer.playNow(buffer());
    const aIn = asDeck(a.mixer.nextDeck);
    const aTimes = a.mixer.transitionTo(buffer(), plan, 0.9);

    const b = newMixer();
    b.mixer.playNow(buffer());
    const bIn = asDeck(b.mixer.nextDeck);
    const bTimes = b.mixer.performRecipe(buffer(), recipeFromPlan(plan), {
      levelGain: 0.9,
    });

    expect(aTimes).toEqual(bTimes);
    expect(aIn.bass.gain.events).toEqual(bIn.bass.gain.events);
    expect(aIn.gain.gain.events[0].duration).toBe(
      bIn.gain.gain.events[0].duration,
    );
    expect(a.ctx.sources[1].startedWith).toEqual(b.ctx.sources[1].startedWith);
    expect(a.ctx.sources[1].playbackRate.events).toEqual(
      b.ctx.sources[1].playbackRate.events,
    );
    expect(a.ctx.sources[0].stoppedAt).toBe(b.ctx.sources[0].stoppedAt);
  });
});
