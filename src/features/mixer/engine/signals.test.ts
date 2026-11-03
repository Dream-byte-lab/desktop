import { describe, expect, it } from "vitest";
import { SignalBank } from "./signals";

// Signals (S5-4): the room's readings. Every assertion here is a
// clause of the blueprint §3.4 signal model: each signal has a
// defined effect (or a documented non-effect), signals decay, and a
// single weak move is noise while a pattern is data.

const T0 = 1_000_000;

function bank(): { signals: SignalBank; setNow: (ms: number) => void } {
  let now = T0;
  return {
    signals: new SignalBank(() => now),
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

describe("impatience", () => {
  it("rises on early skips, saturates, and is relieved by completions", () => {
    const { signals } = bank();
    expect(signals.impatience(T0)).toBe(0);
    signals.record({ kind: "skip-early", atMs: T0 });
    expect(signals.impatience(T0)).toBeCloseTo(0.7);
    signals.record({ kind: "skip-early", atMs: T0 });
    signals.record({ kind: "skip-early", atMs: T0 });
    expect(signals.impatience(T0)).toBe(1); // clamped, never beyond
    signals.record({ kind: "completion", atMs: T0 });
    expect(signals.impatience(T0)).toBeCloseTo(0.65);
  });

  it("decays with its stated half-life", () => {
    const { signals } = bank();
    signals.record({ kind: "skip-early", atMs: T0 });
    expect(signals.impatience(T0 + 90_000)).toBeCloseTo(0.35);
    expect(signals.impatience(T0 + 180_000)).toBeCloseTo(0.175);
  });

  it("treats a late skip as satiation, not impatience", () => {
    const { signals } = bank();
    signals.record({ kind: "skip-late", atMs: T0 });
    expect(signals.impatience(T0)).toBe(0);
    expect(signals.engagement(T0)).toBe(0);
    // …but it is on the record: a near-non-effect, not an absence.
    expect(signals.journal()).toHaveLength(1);
  });
});

describe("engagement", () => {
  it("rewards completions and repeats; a volume pattern outweighs a move", () => {
    const { signals } = bank();
    signals.record({ kind: "volume-up", atMs: T0 });
    const singleMove = signals.engagement(T0);
    expect(singleMove).toBeCloseTo(0.25);
    signals.record({ kind: "volume-up", atMs: T0 });
    signals.record({ kind: "volume-up", atMs: T0 });
    signals.record({ kind: "volume-up", atMs: T0 });
    expect(signals.engagement(T0)).toBeGreaterThan(singleMove);
    signals.record({ kind: "volume-down", atMs: T0 });
    expect(signals.engagement(T0)).toBeCloseTo(0.7);
  });

  it("a ridden-out blend speaks for the set", () => {
    const { signals } = bank();
    signals.record({ kind: "blend-completed", atMs: T0 });
    expect(signals.engagement(T0)).toBeCloseTo(0.3);
  });
});

describe("family charges", () => {
  it("lays a skip against the join family that delivered the track", () => {
    const { signals } = bank();
    signals.record({ kind: "skip-early", family: "long-blend", atMs: T0 });
    expect(signals.familyCharges(T0).get("long-blend")).toBeCloseTo(0.6);
    signals.record({
      kind: "blend-interrupted",
      family: "long-blend",
      atMs: T0,
    });
    expect(signals.familyCharges(T0).get("long-blend")).toBeCloseTo(1.4);
  });

  it("credits the family a repeat approves of", () => {
    const { signals } = bank();
    signals.record({ kind: "repeat", family: "standard-blend", atMs: T0 });
    expect(signals.familyCharges(T0).get("standard-blend")).toBeCloseTo(-0.5);
  });

  it("an unattributed skip charges no family", () => {
    const { signals } = bank();
    signals.record({ kind: "skip-early", atMs: T0 });
    expect(signals.familyCharges(T0).size).toBe(0);
  });
});

describe("party momentum", () => {
  it("reads a surge, a lull, and silence", () => {
    const { signals } = bank();
    expect(signals.partyMomentum(T0)).toBe(0);
    for (let i = 0; i < 8; i += 1) {
      signals.record({ kind: "party-reaction", atMs: T0 - 10_000 });
    }
    expect(signals.partyMomentum(T0)).toBeCloseTo(1);
    // Seventy seconds later the same burst is the PRIOR window: a lull.
    expect(signals.partyMomentum(T0 + 70_000)).toBeCloseTo(-1);
    // And once it has aged out of both windows, silence again.
    expect(signals.partyMomentum(T0 + 300_000)).toBe(0);
  });

  it("a steady room has no momentum — level is not change", () => {
    const { signals } = bank();
    for (let i = 0; i < 6; i += 1) {
      signals.record({ kind: "party-reaction", atMs: T0 - 30_000 });
      signals.record({ kind: "party-reaction", atMs: T0 - 90_000 });
    }
    expect(signals.partyMomentum(T0)).toBe(0);
  });
});

describe("arc bias and non-effects", () => {
  it("combines engagement and momentum into a small energy bias", () => {
    const { signals } = bank();
    signals.record({ kind: "repeat", atMs: T0 });
    for (let i = 0; i < 8; i += 1) {
      signals.record({ kind: "party-reaction", atMs: T0 - 5_000 });
    }
    // engagement 0.8 → +0.04; momentum 1 → +0.12.
    expect(signals.arcBias(T0)).toBeCloseTo(0.16);
  });

  it("a seek-back is recorded context and moves nothing", () => {
    const { signals } = bank();
    signals.record({ kind: "seek-back", atMs: T0 });
    expect(signals.seekBacks()).toEqual([T0]);
    expect(signals.impatience(T0)).toBe(0);
    expect(signals.engagement(T0)).toBe(0);
    expect(signals.familyCharges(T0).size).toBe(0);
    expect(signals.arcBias(T0)).toBe(0);
  });

  it("bounds its journal", () => {
    const { signals } = bank();
    for (let i = 0; i < 300; i += 1) {
      signals.record({ kind: "volume-up", atMs: T0 + i });
    }
    expect(signals.journal().length).toBe(240);
  });
});
