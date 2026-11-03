import { describe, expect, it } from "vitest";
import { HEARTBEAT } from "./heartbeat";
import { restProfileAt } from "./visualizerSource";
import {
  createWavelineFlow,
  WAVELINE_LAYERS,
  WAVELINE_MAX_DISPLACEMENT,
  WAVELINE_POINTS,
  wavelinePointFractions,
  wavelineRestingSwell,
} from "./wavelines";

// The wavelines' character, pinned (Ruling 4): layered, smooth,
// flowing lines whose motion is borrowed entirely from the
// sampled profile and the heartbeat's swell — at rest a low
// ridge breathing under the idle ceiling, never a seismograph,
// never motion invented over silence.

const restProfile = () => {
  const profile = new Float32Array(WAVELINE_POINTS);
  for (let i = 0; i < WAVELINE_POINTS; i += 1) {
    profile[i] = restProfileAt(i);
  }
  return profile;
};

const pointsFor = (
  layerIndex: number,
  profile: ArrayLike<number>,
  swell: number,
  phase: number,
) => {
  const out = new Float32Array(profile.length);
  wavelinePointFractions(layerIndex, profile, swell, phase, out);
  return out;
};

describe("WAVELINE_LAYERS", () => {
  it("is a small layered set, back to front in depth order", () => {
    expect(WAVELINE_LAYERS.length).toBeGreaterThanOrEqual(2);
    expect(WAVELINE_LAYERS.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < WAVELINE_LAYERS.length; i += 1) {
      const back = WAVELINE_LAYERS[i - 1];
      const front = WAVELINE_LAYERS[i];
      // Nearer lines sit lower, swing wider, flow faster, read stronger.
      expect(front.baseline).toBeGreaterThan(back.baseline);
      expect(front.gain).toBeGreaterThan(back.gain);
      expect(front.phaseSpeed).toBeGreaterThan(back.phaseSpeed);
      expect(front.alpha).toBeGreaterThan(back.alpha);
      // And their ripples never start aligned.
      expect(front.phaseStart).not.toBe(back.phaseStart);
    }
  });
});

describe("wavelinePointFractions", () => {
  it("rests exactly on the baselines at zero swell — nothing invented", () => {
    const profile = restProfile();
    for (let layer = 0; layer < WAVELINE_LAYERS.length; layer += 1) {
      const ys = pointsFor(layer, profile, 0, 1.23);
      for (const y of ys) {
        expect(y).toBeCloseTo(WAVELINE_LAYERS[layer].baseline, 6);
      }
    }
  });

  it("never displaces a line beyond its layer's share of the field", () => {
    const profiles = [
      restProfile(),
      new Float32Array(WAVELINE_POINTS).fill(1),
      new Float32Array(WAVELINE_POINTS).fill(0),
    ];
    for (const profile of profiles) {
      for (let layer = 0; layer < WAVELINE_LAYERS.length; layer += 1) {
        const spec = WAVELINE_LAYERS[layer];
        for (const swell of [0.25, 0.6, 1]) {
          for (const phase of [0, 1.1, 2.7, 4.9]) {
            const ys = pointsFor(layer, profile, swell, phase);
            for (const y of ys) {
              expect(Math.abs(y - spec.baseline)).toBeLessThanOrEqual(
                WAVELINE_MAX_DISPLACEMENT * spec.gain * swell + 1e-6,
              );
            }
          }
        }
      }
    }
  });

  it("stays smooth over the profiles the field actually draws — no spikes", () => {
    // The two honest profiles: the rest ridge, and a smooth loud
    // bump. (The drawn curve is further smoothed through midpoints
    // by the component; this pins the point math itself.)
    const bump = new Float32Array(WAVELINE_POINTS);
    for (let i = 0; i < WAVELINE_POINTS; i += 1) {
      const u = i / (WAVELINE_POINTS - 1);
      bump[i] = 0.25 + 0.7 * Math.exp(-((u - 0.4) ** 2) / 0.04);
    }
    for (const profile of [restProfile(), bump]) {
      for (let layer = 0; layer < WAVELINE_LAYERS.length; layer += 1) {
        const ys = pointsFor(layer, profile, 1, 0.7);
        for (let i = 1; i < ys.length; i += 1) {
          expect(Math.abs(ys[i] - ys[i - 1])).toBeLessThan(0.15);
        }
      }
    }
  });

  it("actually flows: advancing the phase moves the line", () => {
    const profile = restProfile();
    const front = WAVELINE_LAYERS.length - 1;
    const a = pointsFor(front, profile, 0.8, 0);
    const b = pointsFor(front, profile, 0.8, 0.9);
    const moved = Array.from(a).some((y, i) => Math.abs(y - b[i]) > 0.005);
    expect(moved).toBe(true);
  });

  it("keeps the idle field a low ridge under the heartbeat's ceiling", () => {
    const idleCeiling =
      HEARTBEAT.FIELD_FLOOR +
      (1 - HEARTBEAT.FIELD_FLOOR) * HEARTBEAT.IDLE_AMPLITUDE;
    const profile = restProfile();
    for (let layer = 0; layer < WAVELINE_LAYERS.length; layer += 1) {
      const spec = WAVELINE_LAYERS[layer];
      const ys = pointsFor(layer, profile, idleCeiling, 2.2);
      for (const y of ys) {
        expect(Math.abs(y - spec.baseline)).toBeLessThanOrEqual(
          WAVELINE_MAX_DISPLACEMENT * spec.gain * idleCeiling + 1e-6,
        );
      }
    }
    // The front line at rest moves at most ~12% of the card.
    expect(WAVELINE_MAX_DISPLACEMENT * idleCeiling).toBeLessThanOrEqual(0.13);
  });
});

describe("wavelineRestingSwell", () => {
  it("is the resting pulse at its lub — the heartbeat's idle ceiling", () => {
    const expected =
      HEARTBEAT.FIELD_FLOOR +
      (1 - HEARTBEAT.FIELD_FLOOR) * HEARTBEAT.IDLE_AMPLITUDE;
    expect(wavelineRestingSwell()).toBeCloseTo(expected, 6);
  });
});

describe("createWavelineFlow", () => {
  it("advances every phase, nearer layers faster, starting offset", () => {
    const flow = createWavelineFlow();
    const start = WAVELINE_LAYERS.map((layer) => layer.phaseStart);
    const after = flow.update(1 / 60, 0.2);
    for (let i = 0; i < after.length; i += 1) {
      expect(after[i]).toBeGreaterThan(start[i]);
    }
    const frontAdvance = after[after.length - 1] - start[start.length - 1];
    const backAdvance = after[0] - start[0];
    expect(frontAdvance).toBeGreaterThan(backAdvance);
  });

  it("flows faster as the swell deepens, and clamps a stalled frame", () => {
    const calm = createWavelineFlow();
    const loud = createWavelineFlow();
    const calmPhases = calm.update(1 / 60, 0.15);
    const loudPhases = loud.update(1 / 60, 0.95);
    expect(loudPhases[0] - WAVELINE_LAYERS[0].phaseStart).toBeGreaterThan(
      calmPhases[0] - WAVELINE_LAYERS[0].phaseStart,
    );
    // A five-second stall advances no more than a tenth of a second.
    const stalled = createWavelineFlow();
    const phases = stalled.update(5, 0.5);
    const capped = createWavelineFlow().update(0.1, 0.5);
    expect(phases[0]).toBeCloseTo(capped[0], 6);
  });
});
