import { describe, expect, it } from "vitest";
import type { KeyEstimate } from "./detectKey";
import { keyCompatibility } from "./keyCompatibility";

function key(
  tonic: string,
  mode: "major" | "minor",
  pitchClass: number,
  camelot: string,
): KeyEstimate {
  return { tonic, mode, pitchClass, camelot, confidence: 0.9 };
}

const cMajor = key("C", "major", 0, "8B");
const aMinor = key("A", "minor", 9, "8A");
const gMajor = key("G", "major", 7, "9B");
const fMajor = key("F", "major", 5, "7B");
const cMinor = key("C", "minor", 0, "5A");
const dMajor = key("D", "major", 2, "10B");
const gbMajor = key("F#", "major", 6, "2B");

describe("keyCompatibility", () => {
  it("scores the same key as perfect", () => {
    const result = keyCompatibility(cMajor, key("C", "major", 0, "8B"));
    expect(result?.score).toBe(1);
    expect(result?.relation).toBe("same");
    expect(result?.compatible).toBe(true);
  });

  it("scores relative major/minor nearly as safe", () => {
    const result = keyCompatibility(cMajor, aMinor);
    expect(result?.relation).toBe("relative");
    expect(result?.score).toBe(0.9);
    expect(result?.compatible).toBe(true);
  });

  it("scores one wheel step in the same mode as a classic good move", () => {
    expect(keyCompatibility(cMajor, gMajor)?.relation).toBe("adjacent");
    expect(keyCompatibility(cMajor, fMajor)?.relation).toBe("adjacent");
    expect(keyCompatibility(cMajor, gMajor)?.score).toBe(0.85);
  });

  it("scores a wheel step with the other letter as diagonal but workable", () => {
    const dMinor = key("D", "minor", 2, "7A");
    const result = keyCompatibility(cMajor, dMinor);
    expect(result?.relation).toBe("diagonal");
    expect(result?.score).toBe(0.6);
    expect(result?.compatible).toBe(true);
  });

  it("scores the parallel key as a deliberate mood flip, not a safe blend", () => {
    const result = keyCompatibility(cMajor, cMinor);
    expect(result?.relation).toBe("parallel");
    expect(result?.compatible).toBe(false);
  });

  it("scores two wheel steps as near, and a far key as distant", () => {
    expect(keyCompatibility(cMajor, dMajor)?.relation).toBe("near");
    const far = keyCompatibility(cMajor, gbMajor);
    expect(far?.relation).toBe("distant");
    expect(far?.compatible).toBe(false);
  });

  it("returns null when either key is unknown", () => {
    expect(keyCompatibility(null, cMajor)).toBe(null);
    expect(keyCompatibility(cMajor, null)).toBe(null);
  });
});
