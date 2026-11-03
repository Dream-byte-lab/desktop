import { describe, expect, it } from "vitest";
import {
  clampUserVolume,
  FULL_VOLUME_LEVEL,
  MAX_USER_VOLUME,
  toVolumeGain,
  toVolumeLevel,
} from "./volume";

describe("volume mapping — 100% at 70% travel, boost to 500%", () => {
  it("exports the fixed contract constants", () => {
    expect(MAX_USER_VOLUME).toBe(5);
    expect(FULL_VOLUME_LEVEL).toBe(0.7);
  });

  it("maps the key slider levels to gains", () => {
    expect(toVolumeGain(0)).toBe(0);
    expect(toVolumeGain(0.7)).toBe(1);
    expect(toVolumeGain(1)).toBe(5);
  });

  it("maps the key gains back to slider levels", () => {
    expect(toVolumeLevel(0)).toBe(0);
    expect(toVolumeLevel(1)).toBe(0.7);
    expect(toVolumeLevel(5)).toBe(1);
    expect(toVolumeLevel(0.25)).toBeCloseTo(0.35, 10);
  });

  it("keeps the square perceptual law in the 0..100% zone", () => {
    // halfway through the 0..100% zone (level 0.35) is gain 0.25
    expect(toVolumeGain(0.35)).toBeCloseTo(0.25, 10);
    expect(toVolumeGain(0.175)).toBeCloseTo(0.0625, 10);
  });

  it("round-trips level -> gain -> level across the whole travel", () => {
    for (let i = 0; i <= 100; i++) {
      const level = i / 100;
      expect(toVolumeLevel(toVolumeGain(level))).toBeCloseTo(level, 10);
    }
  });

  it("round-trips gain -> level -> gain across the whole gain range", () => {
    for (let i = 0; i <= 100; i++) {
      const gain = (i / 100) * MAX_USER_VOLUME;
      expect(toVolumeGain(toVolumeLevel(gain))).toBeCloseTo(gain, 10);
    }
  });

  it("clamps levels and gains beyond their ranges", () => {
    expect(toVolumeGain(-0.5)).toBe(0);
    expect(toVolumeGain(2)).toBe(MAX_USER_VOLUME);
    expect(toVolumeLevel(-1)).toBe(0);
    expect(toVolumeLevel(99)).toBe(1);
    expect(clampUserVolume(-1)).toBe(0);
    expect(clampUserVolume(6)).toBe(MAX_USER_VOLUME);
    expect(clampUserVolume(3)).toBe(3);
  });

  it("is monotonic across the 100% seam", () => {
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const gain = toVolumeGain(i / 100);
      expect(gain).toBeGreaterThan(previous);
      previous = gain;
    }
    expect(toVolumeGain(0.69)).toBeLessThan(1);
    expect(toVolumeGain(0.71)).toBeGreaterThan(1);
  });
});
