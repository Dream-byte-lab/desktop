// kernel.parity.test.ts — Wave 2.5 (§9.5) adoption parity, gate G3.
//
// The wasm kernel (kernel.wasm, compiled from
// cpp-spike/kernel_shipped.cpp — a port of kernel.ts's SHIPPED
// formulas) must agree with the TypeScript kernel over wide seeded
// domains: exact for the branch/rounding functions, ≤1e-6 relative
// for tempoFit (the only ported function with transcendentals;
// hand-rolled log2/exp in the C++ — measured error is reported and
// printed, and is orders of magnitude tighter than the gate).
//
// Cases are generated in-code from a seeded RNG (mulberry32,
// 0x2B5EED — the same seed family as the standalone fixture set in
// ~/workspace/liner-liveRave/kernel-parity/), so no fixture files
// ship in the app tree. Expected values are computed FIRST, while
// the exported functions still run the TypeScript path (auto-init
// is disabled under vitest), then the committed wasm bytes are read
// from disk (vitest rewrites asset `?url`s — the spike's G2 lesson)
// and injected into the loader; afterwards the SAME exported
// functions delegate to wasm, and both the raw wasm kernel and the
// delegating exports are compared against the stored expectations.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  blendGeometry,
  keyFitScore,
  tempoFit,
  vocalSafety,
  type BlendGeometryConstraints,
} from "./kernel";
import {
  getWasmKernel,
  initKernelWasmFromBytes,
  kernelWasmStatus,
} from "./kernelWasm";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ErrorTracker {
  cases = 0;
  exact = 0;
  maxAbs = 0;
  maxRel = 0;
  check(expected: number, got: number): void {
    this.cases += 1;
    const abs = Math.abs(got - expected);
    if (abs === 0) this.exact += 1;
    if (abs > this.maxAbs) this.maxAbs = abs;
    if (Math.abs(expected) > 1e-9) {
      const rel = abs / Math.abs(expected);
      if (rel > this.maxRel) this.maxRel = rel;
    }
  }
  expectWithinGate(): void {
    expect(this.maxRel).toBeLessThanOrEqual(1e-6);
  }
}

describe("kernel wasm parity (G3)", () => {
  it("wasm kernel matches the TS kernel across the seeded domains", async () => {
    expect(kernelWasmStatus()).toBe("idle");
    expect(getWasmKernel()).toBeNull();

    const rnd = mulberry32(0x2b5eed);
    const range = (lo: number, hi: number) => lo + rnd() * (hi - lo);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];

    // ---- Generate cases + TS expectations (wasm not live yet) ----
    type TempoCase = {
      a: number | null;
      b: number | null;
      expected: number;
    };
    const tempoCases: TempoCase[] = [];
    const addTempo = (a: number | null, b: number | null) =>
      tempoCases.push({ a, b, expected: tempoFit(a, b) });
    for (const [a, b] of [
      [120, 120],
      [120, 60],
      [60, 120],
      [null, 120],
      [120, null],
      [null, null],
      [0, 120],
      [120, 0],
      [-90, 120],
      [Number.NaN, 120],
      [120, Number.NaN],
      [124, 126],
      [120, 145],
    ] as [number | null, number | null][]) {
      addTempo(a, b);
    }
    // Dense ratio sweep over the whole Gaussian and both folds.
    for (const base of [60, 87.3, 100, 120, 124, 140, 174.6, 200]) {
      for (let r = 0.4; r <= 2.601; r += 0.005) addTempo(base, base * r);
    }
    while (tempoCases.length < 6000) {
      const base = range(30, 260);
      const mode = rnd();
      let other: number;
      if (mode < 0.35) other = base * range(0.85, 1.18);
      else if (mode < 0.55) other = base * pick([0.5, 2]) * range(0.92, 1.08);
      else if (mode < 0.8) other = range(30, 260);
      else other = base * range(0.98, 1.02);
      addTempo(base, other);
    }

    type KeyCase = { fit: { score: number } | null; expected: number };
    const keyCases: KeyCase[] = [];
    const addKey = (score: number | null) =>
      keyCases.push({
        fit: score === null ? null : { score },
        expected: keyFitScore(
          score === null ? null : { score, relation: "same", compatible: true },
        ),
      });
    addKey(null);
    for (let s = -1; s <= 2.0001; s += 0.001) addKey(s);
    while (keyCases.length < 3600) {
      if (rnd() < 0.2) addKey(null);
      else addKey(range(-0.5, 1.5));
    }
    addKey(Number.NaN); // clamp01 of a non-finite score is 0 in TS

    type VocalCase = {
      a: { mean: number; confidence: number; witnessed: boolean };
      b: { mean: number; confidence: number; witnessed: boolean };
      expected: number;
    };
    const vocalCases: VocalCase[] = [];
    const addVocal = (
      meanA: number,
      witA: boolean,
      meanB: number,
      witB: boolean,
    ) => {
      const a = { mean: meanA, confidence: 0.9, witnessed: witA };
      const b = { mean: meanB, confidence: 0.9, witnessed: witB };
      vocalCases.push({ a, b, expected: vocalSafety(a, b) });
    };
    for (const [witA, witB] of [
      [true, true],
      [true, false],
      [false, true],
    ] as [boolean, boolean][]) {
      for (let ma = 0; ma <= 1.0001; ma += 0.02) {
        for (let mb = 0; mb <= 1.0001; mb += 0.02) addVocal(ma, witA, mb, witB);
      }
    }
    while (vocalCases.length < 8500) {
      addVocal(range(-0.1, 1.1), rnd() < 0.6, range(-0.1, 1.1), rnd() < 0.6);
    }
    addVocal(0, false, 0, false);

    type BlendCase = {
      constraints: BlendGeometryConstraints;
      expected: { overlapBeats: number; swapBeat: number };
    };
    const blendCases: BlendCase[] = [];
    const addBlend = (c: BlendGeometryConstraints) =>
      blendCases.push({ constraints: c, expected: blendGeometry(c) });
    addBlend({ centreBeats: 16 });
    addBlend({ centreBeats: 28, capBeats: 8 });
    addBlend({ centreBeats: Number.NaN });
    for (const bpb of [3, 4, 6]) {
      for (const cap of [undefined, 8, 16] as (number | undefined)[]) {
        for (let centre = 0; centre <= 64.001; centre += 0.5) {
          addBlend({
            centreBeats: centre,
            beatsPerBar: bpb,
            ...(cap !== undefined ? { capBeats: cap } : {}),
          });
        }
      }
    }
    while (blendCases.length < 5000) {
      const c: BlendGeometryConstraints = {
        centreBeats: range(0, 56),
      };
      if (rnd() < 0.5) c.beatsPerBar = pick([1, 2, 3, 4, 4, 4, 6, 8]);
      if (rnd() < 0.4) c.minBeats = range(1, 16);
      if (rnd() < 0.4) c.maxBeats = range(8, 64);
      if (rnd() < 0.35) c.capBeats = range(4, 40);
      addBlend(c);
    }

    expect(tempoCases.length).toBeGreaterThanOrEqual(500);
    expect(keyCases.length).toBeGreaterThanOrEqual(500);
    expect(vocalCases.length).toBeGreaterThanOrEqual(500);
    expect(blendCases.length).toBeGreaterThanOrEqual(500);

    // ---- Load the committed wasm artefact and go live ----
    const wasmPath = path.join(
      process.cwd(),
      "src/features/mixer/liverave/kernel.wasm",
    );
    const bytes = readFileSync(wasmPath);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await expect(initKernelWasmFromBytes(buffer)).resolves.toBe(true);
    expect(kernelWasmStatus()).toBe("live");
    const wasm = getWasmKernel();
    expect(wasm).not.toBeNull();

    // ---- Compare: raw wasm AND the delegating exports ----
    const tempoErr = new ErrorTracker();
    for (const c of tempoCases) {
      tempoErr.check(c.expected, wasm!.tempoFit(c.a, c.b));
      tempoErr.check(c.expected, tempoFit(c.a, c.b)); // delegated export
    }
    tempoErr.expectWithinGate();

    const keyErr = new ErrorTracker();
    for (const c of keyCases) {
      keyErr.check(
        c.expected,
        wasm!.keyFitScoreCore(c.fit !== null, c.fit?.score ?? 0),
      );
      keyErr.check(
        c.expected,
        keyFitScore(
          c.fit === null
            ? null
            : { score: c.fit.score, relation: "same", compatible: true },
        ),
      );
    }
    keyErr.expectWithinGate();
    expect(keyErr.maxAbs).toBe(0); // clamp/neutral core is bit-exact

    const vocalErr = new ErrorTracker();
    for (const c of vocalCases) {
      vocalErr.check(
        c.expected,
        wasm!.vocalSafety(c.a.mean, c.a.witnessed, c.b.mean, c.b.witnessed),
      );
      vocalErr.check(c.expected, vocalSafety(c.a, c.b));
    }
    vocalErr.expectWithinGate();
    expect(vocalErr.maxAbs).toBe(0); // pure arithmetic, bit-exact

    const blendErr = new ErrorTracker();
    for (const c of blendCases) {
      const raw = wasm!.blendGeometry(c.constraints);
      blendErr.check(c.expected.overlapBeats, raw.overlapBeats);
      blendErr.check(c.expected.swapBeat, raw.swapBeat);
      const delegated = blendGeometry(c.constraints);
      blendErr.check(c.expected.overlapBeats, delegated.overlapBeats);
      blendErr.check(c.expected.swapBeat, delegated.swapBeat);
    }
    blendErr.expectWithinGate();
    expect(blendErr.maxAbs).toBe(0); // integer bar math, bit-exact

    console.info(
      `[kernel parity] tempoFit cases=${tempoErr.cases} exact=${tempoErr.exact} ` +
        `maxAbs=${tempoErr.maxAbs.toExponential(3)} maxRel=${tempoErr.maxRel.toExponential(3)}; ` +
        `keyFitScoreCore cases=${keyErr.cases} maxAbs=${keyErr.maxAbs}; ` +
        `vocalSafety cases=${vocalErr.cases} maxAbs=${vocalErr.maxAbs}; ` +
        `blendGeometry cases=${blendErr.cases} maxAbs=${blendErr.maxAbs}`,
    );
  });
});
