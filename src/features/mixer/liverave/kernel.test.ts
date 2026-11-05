import { describe, expect, it } from "vitest";
import {
  beatsSincePhraseStart,
  beatsUntilNextPhraseBoundary,
  blendGeometry,
  energyArcFit,
  keyFitScore,
  phraseAlignmentScore,
  tempoFit,
  vocalSafety,
  windowTransientScore,
} from "./kernel";
import { clubA, clubB, popA } from "./testFixtures";

describe("kernel tempoFit", () => {
  it("identical tempos fit perfectly; half/double time also fits", () => {
    expect(tempoFit(120, 120)).toBe(1);
    expect(tempoFit(120, 60)).toBeCloseTo(1);
    expect(tempoFit(60, 120)).toBeCloseTo(1);
  });

  it("small differences score high, large differences fade", () => {
    expect(tempoFit(124, 126)).toBeGreaterThan(0.9);
    expect(tempoFit(120, 128)).toBeLessThan(tempoFit(124, 126));
    expect(tempoFit(120, 145)).toBeLessThan(0.2);
  });

  it("unknown tempo is neutral, not a mismatch", () => {
    expect(tempoFit(null, 120)).toBe(0.5);
    expect(tempoFit(120, null)).toBe(0.5);
    expect(tempoFit(0, 120)).toBe(0.5);
  });
});

describe("kernel keyFitScore", () => {
  it("passes a known score through; unknown keys are neutral", () => {
    expect(keyFitScore(clubA.keyFitTo(clubB))).toBeCloseTo(0.85);
    expect(keyFitScore(null)).toBe(0.65);
  });
});

describe("kernel phrase helpers", () => {
  it("phrase boundaries land every 16 beats on a tidy grid", () => {
    const msPerBeat = 60_000 / 124;
    // Beat 40 is 8 beats into the phrase that starts at beat 32.
    expect(beatsSincePhraseStart(clubA, 40 * msPerBeat)).toBeCloseTo(8);
    expect(beatsUntilNextPhraseBoundary(clubA, 40 * msPerBeat)).toBeCloseTo(8);
    expect(beatsUntilNextPhraseBoundary(clubA, 32 * msPerBeat)).toBeCloseTo(0);
    expect(phraseAlignmentScore(clubA, 32 * msPerBeat)).toBe(1);
    expect(phraseAlignmentScore(clubA, 40 * msPerBeat)).toBeLessThan(0.2);
  });
});

describe("kernel vocalSafety", () => {
  const quiet = { mean: 0.05, confidence: 0.9, witnessed: true };
  const loud = { mean: 0.9, confidence: 0.9, witnessed: true };

  it("two quiet witnessed windows are fully safe; two loud ones collide", () => {
    expect(vocalSafety(quiet, quiet)).toBeCloseTo(0.9975);
    expect(vocalSafety(loud, loud)).toBeCloseTo(0.19);
    expect(vocalSafety(loud, quiet)).toBeGreaterThan(0.9);
  });

  it("unwitnessed windows shrink toward the middle, never to extremes", () => {
    const unknown = { mean: 0, confidence: 0, witnessed: false };
    expect(vocalSafety(unknown, unknown)).toBe(0.5);
    const mixed = vocalSafety(loud, unknown);
    expect(mixed).toBeGreaterThan(0.3);
    expect(mixed).toBeLessThan(0.8);
  });
});

describe("kernel energyArcFit + windowTransientScore", () => {
  it("energy on the arc target fits; far off it does not", () => {
    // Arc target at position 0 is 0.30; at position 1 it is 1.0.
    expect(energyArcFit(0.3, 0)).toBe(1);
    expect(energyArcFit(1, 1)).toBe(1);
    expect(energyArcFit(0, 1)).toBe(0);
    expect(energyArcFit(0.65, 0.5, 1)).toBeGreaterThan(0.8);
  });

  it("club outro windows are transient-rich; pop windows are flat", () => {
    const clubMsPerBeat = 60_000 / 124;
    const clubScore = windowTransientScore(
      clubA,
      448 * clubMsPerBeat,
      456 * clubMsPerBeat,
    );
    expect(clubScore).toBeGreaterThan(0.6);
    const popMsPerBeat = 60_000 / 100;
    const popScore = windowTransientScore(
      popA,
      384 * popMsPerBeat,
      392 * popMsPerBeat,
    );
    expect(popScore).toBeLessThan(0.2);
  });
});

describe("kernel blendGeometry", () => {
  it("rounds the centre to whole bars and swaps at the middle bar", () => {
    expect(blendGeometry({ centreBeats: 16 })).toEqual({
      overlapBeats: 16,
      swapBeat: 8,
    });
    expect(blendGeometry({ centreBeats: 28 })).toEqual({
      overlapBeats: 28,
      swapBeat: 12,
    });
    expect(blendGeometry({ centreBeats: 9 })).toEqual({
      overlapBeats: 8,
      swapBeat: 4,
    });
  });

  it("a cap wins over the centre (the distant-key 8-beat cap)", () => {
    const geometry = blendGeometry({ centreBeats: 28, capBeats: 8 });
    expect(geometry.overlapBeats).toBe(8);
    expect(geometry.swapBeat).toBe(4);
  });
});
