import { describe, expect, it } from "vitest";
import {
  bassEnergyOf,
  binsHaveSignal,
  mapBinsToBars,
  restProfileAt,
  smoothBars,
} from "./visualizerSource";

// The honesty helpers, pinned: silence reads as silence, the
// resting profile is a still ridge (it never animates itself),
// and the bar mapping puts the low end — where the energy and
// the heartbeat's input live — in charge of the field.

function bins(fill: (bin: number) => number, length = 128): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => fill(i));
}

describe("binsHaveSignal", () => {
  it("reads digital silence as no signal", () => {
    expect(binsHaveSignal(bins(() => 0))).toBe(false);
    expect(binsHaveSignal(bins(() => 4))).toBe(false);
  });

  it("reads actual sound as signal", () => {
    expect(binsHaveSignal(bins((i) => (i === 40 ? 90 : 0)))).toBe(true);
  });
});

describe("mapBinsToBars", () => {
  it("maps silence to silence", () => {
    const out = new Float32Array(36);
    mapBinsToBars(
      bins(() => 0),
      36,
      out,
    );
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it("puts low-frequency energy in the field's low bars", () => {
    const out = new Float32Array(36);
    mapBinsToBars(
      bins((i) => (i >= 2 && i < 6 ? 255 : 0)),
      36,
      out,
    );
    expect(out[0]).toBeGreaterThan(0.9);
    expect(out[20]).toBe(0);
  });

  it("keeps every bar within 0..1", () => {
    const out = new Float32Array(36);
    mapBinsToBars(
      bins(() => 255),
      36,
      out,
    );
    expect(Array.from(out).every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});

describe("bassEnergyOf", () => {
  it("is zero in silence and strong under a bass hit", () => {
    expect(bassEnergyOf(bins(() => 0))).toBe(0);
    expect(bassEnergyOf(bins((i) => (i < 9 ? 255 : 0)))).toBeGreaterThan(0.9);
    // Treble alone does not move the heartbeat.
    expect(bassEnergyOf(bins((i) => (i >= 60 ? 255 : 0)))).toBe(0);
  });
});

describe("restProfileAt", () => {
  it("is a low, bounded ridge — deterministic, never a spike", () => {
    for (let i = 0; i < 48; i += 1) {
      const v = restProfileAt(i);
      expect(v).toBeGreaterThanOrEqual(0.5);
      expect(v).toBeLessThanOrEqual(0.9);
      expect(restProfileAt(i)).toBe(v);
    }
  });
});

describe("smoothBars", () => {
  it("rises quickly and falls slowly", () => {
    const current = new Float32Array([0, 1]);
    smoothBars(current, new Float32Array([1, 0]), 0.55, 0.86);
    expect(current[0]).toBeCloseTo(0.55, 5);
    expect(current[1]).toBeCloseTo(0.86, 5);
  });
});
