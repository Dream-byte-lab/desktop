import { describe, expect, it } from "vitest";
import type { Deck } from "./deck";
import { expandJugglePerformance, type JugglePerformance } from "./juggle";
import type { BeatMap } from "./beatMap";
import { planTransition } from "./transitionPlanner";
import { TwoDeckMixer } from "./twoDeckMixer";

// The revamp's J1 — the juggle executor, performed. Same
// recording fake as the R1/R2 suites: every source start/stop and
// every fader event the executor schedules is captured, and
// paramAt reconstructs the value a listener hears at a moment.
// The claims pinned here are the borrow protocol's executor half:
//   · the segments sound at the written ctx times, from the
//     written offsets, on the written decks — and nowhere else;
//   · at every instant exactly one copy is audible (the faders
//     cut against each other; they never blend);
//   · the borrowed deck is level-matched and chain-neutral, and
//     is returned silent at fader 0 with the mixer's current deck
//     UNFLIPPED — the borrow is not a join;
//   · the track resumes on the playing deck from the exit as an
//     ordinary main source;
//   · every takeover path (stopAll, playNow, a recipe) silences
//     the segments, so a juggle can never bleed into what follows.

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
  disconnect(): void {}
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

/** The value a listener hears at time t (the jog suites' reconstruction). */
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

const buffer = (duration = 240): AudioBuffer =>
  ({ duration }) as unknown as AudioBuffer;

const flat120: BeatMap = {
  bpm: 120,
  firstBeatSec: 0,
  beatsPerBar: 4,
  durationSec: 240,
};

function gainEvents(deck: Deck): ParamEvent[] {
  return (deck.gain.gain as unknown as FakeParam).events;
}
function bassEvents(deck: Deck): ParamEvent[] {
  return (deck.bass.gain as unknown as FakeParam).events;
}
function filterEvents(deck: Deck): ParamEvent[] {
  return (deck.filter.frequency as unknown as FakeParam).events;
}

function newMixer(): { ctx: FakeContext; mixer: TwoDeckMixer } {
  const ctx = new FakeContext();
  const mixer = new TwoDeckMixer(ctx as unknown as AudioContext);
  return { ctx, mixer };
}

const T0 = 1002;

/** A repeat juggle: break at 16 s, 2-beat (1 s) segments ×3. */
function repeatPerformance(): JugglePerformance {
  return expandJugglePerformance({
    pattern: "repeat",
    breakStartBeat: 32,
    segmentBeats: 2,
    segmentCount: 3,
    firstDeck: 0,
    beatMap: flat120,
  });
}

describe("performJuggle — the borrow, performed", () => {
  it("repeat: segments sound at the written times/offsets/decks, faders cut (never blend), and the track resumes from the exit", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const home = mixer.currentDeck;
    const borrowed = mixer.nextDeck;

    const { endCtxTime } = mixer.performJuggle(
      repeatPerformance(),
      buffer(),
      T0,
    );
    expect(endCtxTime).toBe(T0 + 3);

    // Source 0 is the home main source: stopped as the window opens.
    expect(ctx.sources[0].stoppedAt).toBe(T0);
    // The three segment sources: same offset (the break), one per
    // second, alternating decks — home, borrowed, home.
    expect(ctx.sources[1].startedWith).toEqual({ when: T0, offset: 16 });
    expect(ctx.sources[1].stoppedAt).toBe(T0 + 1);
    expect(ctx.sources[2].startedWith).toEqual({ when: T0 + 1, offset: 16 });
    expect(ctx.sources[2].stoppedAt).toBe(T0 + 2);
    expect(ctx.sources[3].startedWith).toEqual({ when: T0 + 2, offset: 16 });
    expect(ctx.sources[3].stoppedAt).toBe(T0 + 3);
    // The resume: an ordinary main source on the home deck, from
    // the exit (the break's own end, 17 s).
    expect(ctx.sources[4].startedWith).toEqual({ when: T0 + 3, offset: 17 });
    expect(ctx.sources[4].stoppedAt).toBeNull();

    // Exactly one copy audible at every instant: mid-segment the
    // sounding deck's fader is 1 and the other's is 0.
    const homeGain = gainEvents(home);
    const borrowedGain = gainEvents(borrowed);
    expect(paramAt(homeGain, T0 + 0.5)).toBeCloseTo(1, 6);
    expect(paramAt(borrowedGain, T0 + 0.5)).toBeCloseTo(0, 6);
    expect(paramAt(homeGain, T0 + 1.5)).toBeCloseTo(0, 6);
    expect(paramAt(borrowedGain, T0 + 1.5)).toBeCloseTo(1, 6);
    expect(paramAt(homeGain, T0 + 2.5)).toBeCloseTo(1, 6);
    expect(paramAt(borrowedGain, T0 + 2.5)).toBeCloseTo(0, 6);
    // After the window: home at 1 (the resume sounds), borrowed
    // returned to 0.
    expect(paramAt(homeGain, T0 + 4)).toBeCloseTo(1, 6);
    expect(paramAt(borrowedGain, T0 + 4)).toBeCloseTo(0, 6);

    // The borrow is not a join: the mixer's current deck never flipped.
    expect(mixer.currentDeck).toBe(home);
    expect(mixer.currentDeckIndex).toBe(0);
  });

  it("the borrowed copy is level-matched to the playing deck and its chain is neutralised at the window's open", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer(), 0, 0.8);
    const home = mixer.currentDeck;
    const borrowed = mixer.nextDeck;
    // Dirty the borrowed deck's chain, as an earlier act could.
    (borrowed.bass.gain as unknown as FakeParam).setValueAtTime(-12, 999);
    (borrowed.filter.frequency as unknown as FakeParam).setValueAtTime(
      800,
      999,
    );

    mixer.performJuggle(repeatPerformance(), buffer(), T0);

    expect(borrowed.level.gain.value).toBe(home.level.gain.value);
    expect(paramAt(bassEvents(borrowed), T0)).toBe(0);
    expect(paramAt(filterEvents(borrowed), T0)).toBe(20_000);
  });

  it("continue: the walk's last segment lands on the borrowed deck and the faders cross back at the exit", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    const home = mixer.currentDeck;
    const borrowed = mixer.nextDeck;
    const performance = expandJugglePerformance({
      pattern: "continue",
      breakStartBeat: 32,
      segmentBeats: 2,
      segmentCount: 4,
      firstDeck: 0,
      beatMap: flat120,
    });

    const { endCtxTime } = mixer.performJuggle(performance, buffer(), T0);
    expect(endCtxTime).toBe(T0 + 4);
    // The walk: consecutive offsets, one per second.
    expect(ctx.sources[1].startedWith).toEqual({ when: T0, offset: 16 });
    expect(ctx.sources[2].startedWith).toEqual({ when: T0 + 1, offset: 17 });
    expect(ctx.sources[3].startedWith).toEqual({ when: T0 + 2, offset: 18 });
    expect(ctx.sources[4].startedWith).toEqual({ when: T0 + 3, offset: 19 });
    // Resume from the walk's end (20 s) on the home deck.
    expect(ctx.sources[5].startedWith).toEqual({ when: T0 + 4, offset: 20 });
    // The last segment sounded on the borrowed deck; after the
    // return cross the faders are home: 1 / 0.
    expect(paramAt(gainEvents(borrowed), T0 + 3.5)).toBeCloseTo(1, 6);
    expect(paramAt(gainEvents(borrowed), T0 + 4.5)).toBeCloseTo(0, 6);
    expect(paramAt(gainEvents(home), T0 + 4.5)).toBeCloseTo(1, 6);
    expect(mixer.currentDeckIndex).toBe(0);
  });
});

describe("performJuggle — the takeover paths silence the segments", () => {
  it("stopAll mid-juggle leaves no live segment source and zeroed faders", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    mixer.performJuggle(repeatPerformance(), buffer(), T0);
    ctx.currentTime = T0 + 1.5; // mid second segment
    mixer.stopAll();

    expect(mixer.currentDeck.segmentCount).toBe(0);
    expect(mixer.nextDeck.segmentCount).toBe(0);
    for (const source of ctx.sources.slice(1, 4)) {
      expect(source.stoppedAt).not.toBeNull();
      expect(source.stoppedAt as number).toBeLessThanOrEqual(T0 + 1.5);
    }
    expect(paramAt(gainEvents(mixer.currentDeck), T0 + 1.5)).toBeCloseTo(0, 6);
    expect(paramAt(gainEvents(mixer.nextDeck), T0 + 1.5)).toBeCloseTo(0, 6);
  });

  it("playNow mid-juggle silences the segments and returns the borrowed fader to 0", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    mixer.performJuggle(repeatPerformance(), buffer(), T0);
    const borrowed = mixer.nextDeck;
    ctx.currentTime = T0 + 1.5; // the borrowed deck is sounding, fader up
    expect(paramAt(gainEvents(borrowed), T0 + 1.5)).toBeCloseTo(1, 6);

    mixer.playNow(buffer());
    expect(mixer.currentDeck.segmentCount).toBe(0);
    expect(borrowed.segmentCount).toBe(0);
    for (const source of ctx.sources.slice(1, 4)) {
      expect(source.stoppedAt).not.toBeNull();
      expect(source.stoppedAt as number).toBeLessThanOrEqual(T0 + 1.5);
    }
    // The borrowed deck was left raised by the juggle; the plain
    // start's neutralisation takes its fader home.
    expect(paramAt(gainEvents(borrowed), T0 + 1.5)).toBeCloseTo(0, 6);
  });

  it("a recipe performed after a juggle starts from silenced segments", () => {
    const { ctx, mixer } = newMixer();
    mixer.playNow(buffer());
    mixer.performJuggle(repeatPerformance(), buffer(), T0);
    ctx.currentTime = T0 + 1.5;
    const plan = planTransition({
      outgoing: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
      outgoingPositionSec: 60,
      incoming: { bpm: 125, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
      incomingEntryBeat: 32,
    });
    if (!plan) throw new Error("fixture plan should exist");
    mixer.transitionTo(buffer(), plan);

    expect(mixer.currentDeck.segmentCount + mixer.nextDeck.segmentCount).toBe(
      0,
    );
    for (const source of ctx.sources.slice(1, 4)) {
      expect(source.stoppedAt).not.toBeNull();
      expect(source.stoppedAt as number).toBeLessThanOrEqual(T0 + 1.5);
    }
  });

  it("with no juggle sounding, playNow writes no segment-silencing events (the pre-juggle path is untouched)", () => {
    const { mixer } = newMixer();
    mixer.playNow(buffer());
    const borrowedGain = gainEvents(mixer.nextDeck);
    const before = borrowedGain.length;
    mixer.playNow(buffer());
    // stopDeckSegments wrote nothing on the borrowed deck: no
    // cancel, no set — its fader events are exactly what the two
    // plain starts themselves wrote (nothing: playNow touches
    // only the current deck).
    expect(gainEvents(mixer.nextDeck).length).toBe(before);
  });
});
