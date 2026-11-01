import { describe, expect, it } from "vitest";
import { levelGainFor, TARGET_LOUDNESS } from "./levelMatch";

describe("levelGainFor", () => {
  it("leaves an on-target track alone", () => {
    expect(levelGainFor(TARGET_LOUDNESS)).toBe(1);
  });

  it("boosts a quiet track and cuts a loud one", () => {
    expect(levelGainFor(TARGET_LOUDNESS / 2)).toBe(2);
    expect(levelGainFor(TARGET_LOUDNESS * 2)).toBe(0.5);
    expect(levelGainFor(TARGET_LOUDNESS / 1.5)).toBeCloseTo(1.5, 5);
  });

  it("clamps the correction to ±6 dB", () => {
    expect(levelGainFor(0.01)).toBe(2);
    expect(levelGainFor(0.99)).toBe(0.5);
  });

  it("falls back to unity for silence or nonsense", () => {
    expect(levelGainFor(0)).toBe(1);
    expect(levelGainFor(Number.NaN)).toBe(1);
  });
});
