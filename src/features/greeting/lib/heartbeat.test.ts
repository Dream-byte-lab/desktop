import { describe, expect, it } from "vitest";
import {
  createHeartbeat,
  HEARTBEAT,
  heartbeatEnvelope,
  heartbeatPeriodSec,
} from "./heartbeat";

// The pulse's character, pinned: a slow resting heartbeat — two
// thumps per cycle, the second softer — that stays small at rest,
// deepens with real bass energy, and eases home when the energy
// goes away. If these numbers drift, the greeting's motion has
// changed its nature, not just its tuning.

describe("heartbeatEnvelope", () => {
  it("runs at a resting rate: 50–60 beats per minute", () => {
    const period = heartbeatPeriodSec();
    expect(period).toBeGreaterThanOrEqual(1.0);
    expect(period).toBeLessThanOrEqual(1.2);
  });

  it("has two thumps per cycle — a lub, then a softer dub", () => {
    const steps = 720;
    const values = Array.from({ length: steps }, (_, i) =>
      heartbeatEnvelope(i / steps),
    );
    const peaks: number[] = [];
    for (let i = 0; i < steps; i += 1) {
      const prev = values[(i - 1 + steps) % steps];
      const next = values[(i + 1) % steps];
      if (values[i] >= prev && values[i] > next && values[i] > 0.5) {
        peaks.push(values[i]);
      }
    }
    expect(peaks).toHaveLength(2);
    // The lub lands at full swell; the dub is present but softer.
    expect(peaks[0]).toBeGreaterThan(0.95);
    expect(peaks[1]).toBeGreaterThan(0.5);
    expect(peaks[1]).toBeLessThan(peaks[0]);
  });

  it("eases back to its floor between thumps, never to zero", () => {
    // Well past the dub, both thumps are spent.
    expect(heartbeatEnvelope(0.8)).toBeCloseTo(HEARTBEAT.BASELINE, 5);
    for (let i = 0; i < 200; i += 1) {
      const v = heartbeatEnvelope(i / 200);
      expect(v).toBeGreaterThanOrEqual(HEARTBEAT.BASELINE);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("createHeartbeat", () => {
  const step = (
    pulse: ReturnType<typeof createHeartbeat>,
    seconds: number,
    bass: number | null,
    collect?: number[],
  ) => {
    const frames = Math.round(seconds * 60);
    let last = 0;
    for (let i = 0; i < frames; i += 1) {
      last = pulse.update(1 / 60, bass);
      collect?.push(last);
    }
    return last;
  };

  it("fades in on appearance — no pop, no sudden full amplitude", () => {
    const pulse = createHeartbeat();
    const first = pulse.update(1 / 60, null);
    expect(first).toBeLessThan(0.05);
    const settled: number[] = [];
    step(pulse, HEARTBEAT.FADE_IN_SEC + 0.5, null, settled);
    expect(Math.max(...settled)).toBeGreaterThan(0.15);
  });

  it("keeps the idle beat under its amplitude ceiling", () => {
    const pulse = createHeartbeat();
    step(pulse, HEARTBEAT.FADE_IN_SEC + 0.2, null);
    const seen: number[] = [];
    step(pulse, 3, null, seen);
    const ceiling =
      HEARTBEAT.FIELD_FLOOR +
      (1 - HEARTBEAT.FIELD_FLOOR) * HEARTBEAT.IDLE_AMPLITUDE;
    expect(Math.max(...seen)).toBeLessThanOrEqual(ceiling + 0.005);
    // And it genuinely pulses — the ceiling is a swell, not a line.
    expect(Math.max(...seen)).toBeGreaterThan(0.2);
    expect(Math.min(...seen)).toBeLessThan(Math.max(...seen) * 0.75);
  });

  it("deepens with bass energy, then eases home when it stops", () => {
    const pulse = createHeartbeat();
    step(pulse, HEARTBEAT.FADE_IN_SEC + 0.2, null);
    const loud: number[] = [];
    step(pulse, 2.5, 0.9, loud);
    expect(Math.max(...loud)).toBeGreaterThan(0.7);
    const home: number[] = [];
    step(pulse, 8, null, home);
    const lateWindow = home.slice(-60);
    expect(Math.max(...lateWindow)).toBeLessThan(0.27);
  });
});
