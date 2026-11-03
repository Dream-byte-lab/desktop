import { describe, it, expect } from "vitest";
import {
  clampCrossfadeSeconds,
  crossfadeGains,
  MAX_CROSSFADE_SECONDS,
} from "./crossfade";

describe("clampCrossfadeSeconds", () => {
  it("keeps ordinary values, rounding to whole seconds", () => {
    expect(clampCrossfadeSeconds(0)).toBe(0);
    expect(clampCrossfadeSeconds(5)).toBe(5);
    expect(clampCrossfadeSeconds(4.6)).toBe(5);
    expect(clampCrossfadeSeconds(12)).toBe(12);
  });

  it("clamps below 0 to off and above the cap to the cap", () => {
    expect(clampCrossfadeSeconds(-3)).toBe(0);
    expect(clampCrossfadeSeconds(45)).toBe(MAX_CROSSFADE_SECONDS);
    expect(clampCrossfadeSeconds(30)).toBe(30);
  });

  it("treats non-finite input as off", () => {
    expect(clampCrossfadeSeconds(Number.NaN)).toBe(0);
    expect(clampCrossfadeSeconds(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("crossfadeGains — equal power across the overlap", () => {
  it("starts fully on the outgoing leg and ends fully on the incoming", () => {
    const start = crossfadeGains(0);
    expect(start.outGain).toBeCloseTo(1);
    expect(start.inGain).toBeCloseTo(0);
    const end = crossfadeGains(1);
    expect(end.outGain).toBeCloseTo(0);
    expect(end.inGain).toBeCloseTo(1);
  });

  it("meets at the equal-power centre (both legs at ~0.707)", () => {
    const mid = crossfadeGains(0.5);
    expect(mid.outGain).toBeCloseTo(Math.SQRT1_2);
    expect(mid.inGain).toBeCloseTo(Math.SQRT1_2);
  });

  it("keeps the sum of squares at 1 for the whole sweep (no centre dip)", () => {
    for (let i = 0; i <= 20; i++) {
      const { outGain, inGain } = crossfadeGains(i / 20);
      expect(outGain * outGain + inGain * inGain).toBeCloseTo(1);
    }
  });

  it("moves monotonically: outgoing only falls, incoming only rises", () => {
    let prevOut = Number.POSITIVE_INFINITY;
    let prevIn = Number.NEGATIVE_INFINITY;
    for (let i = 0; i <= 20; i++) {
      const { outGain, inGain } = crossfadeGains(i / 20);
      expect(outGain).toBeLessThanOrEqual(prevOut + 1e-12);
      expect(inGain).toBeGreaterThanOrEqual(prevIn - 1e-12);
      prevOut = outGain;
      prevIn = inGain;
    }
  });

  it("clamps out-of-range progress", () => {
    expect(crossfadeGains(-0.5)).toEqual(crossfadeGains(0));
    expect(crossfadeGains(1.5)).toEqual(crossfadeGains(1));
  });
});
