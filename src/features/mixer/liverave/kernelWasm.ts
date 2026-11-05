// kernelWasm.ts — loader for the C++ kernel behind kernel.ts (§9.5).
//
// The shipped kernel mathematics (kernel.ts) is also compiled from
// C++ (cpp-spike/kernel_shipped.cpp, a line-by-line port of the
// shipped formulas) to a freestanding wasm32 module, committed here
// as kernel.wasm and imported as a Vite `?url` asset — prebuilt, so
// no toolchain ever enters the app build (gate G4).
//
// Behaviour:
// - Lazy async init. The synchronous TypeScript implementations in
//   kernel.ts are the path until the wasm kernel is live, and the
//   permanent fallback if anything goes wrong.
// - On init the module runs a self-check: a fixed set of probe
//   inputs is evaluated by BOTH the wasm kernel and the registered
//   TypeScript reference; any mismatch beyond 1e-6 relative (gate
//   G3), any load failure, or any instantiate failure marks the wasm
//   kernel failed for the whole session — it is never retried, the
//   failure is logged exactly once, and kernel.ts keeps computing in
//   TypeScript with identical semantics.
// - Call sites never see this file's state directly: kernel.ts asks
//   getWasmKernel() per call and delegates only while live.

import type { BlendGeometry, BlendGeometryConstraints } from "./kernel";
import kernelWasmUrl from "./kernel.wasm?url";

/** The wasm-backed kernel, in JS-friendly signatures. */
export interface WasmKernel {
  tempoFit(
    bpmA: number | null | undefined,
    bpmB: number | null | undefined,
  ): number;
  keyFitScoreCore(hasFit: boolean, score: number): number;
  vocalSafety(
    meanA: number,
    witnessedA: boolean,
    meanB: number,
    witnessedB: boolean,
  ): number;
  blendGeometry(constraints: BlendGeometryConstraints): BlendGeometry;
}

/**
 * The TypeScript reference the self-check compares against. kernel.ts
 * registers its own implementations at module load; the parity tests
 * register the same implementations before injecting wasm bytes.
 */
export interface KernelTsReference {
  tempoFit(
    bpmA: number | null | undefined,
    bpmB: number | null | undefined,
  ): number;
  keyFitScoreCore(hasFit: boolean, score: number): number;
  vocalSafety(
    meanA: number,
    witnessedA: boolean,
    meanB: number,
    witnessedB: boolean,
  ): number;
  blendGeometry(constraints: BlendGeometryConstraints): BlendGeometry;
}

interface RawKernelExports {
  memory: WebAssembly.Memory;
  tempoFit: (bpmA: number, hasA: number, bpmB: number, hasB: number) => number;
  keyFitScoreCore: (hasFit: number, score: number) => number;
  vocalSafety: (
    meanA: number,
    witnessedA: number,
    meanB: number,
    witnessedB: number,
  ) => number;
  blendGeometry: (
    centreBeats: number,
    hasMin: number,
    minBeats: number,
    hasMax: number,
    maxBeats: number,
    hasBpb: number,
    beatsPerBar: number,
    hasCap: number,
    capBeats: number,
    outPtr: number,
  ) => void;
  blendOutPtr: () => number;
}

export type KernelWasmStatus = "idle" | "loading" | "live" | "failed";

let status: KernelWasmStatus = "idle";
let liveKernel: WasmKernel | null = null;
let reference: KernelTsReference | null = null;
let initPromise: Promise<boolean> | null = null;
let failureLogged = false;

export function registerKernelTsReference(ref: KernelTsReference): void {
  reference = ref;
}

export function kernelWasmStatus(): KernelWasmStatus {
  return status;
}

/** The live wasm kernel, or null while loading / after any failure. */
export function getWasmKernel(): WasmKernel | null {
  return liveKernel;
}

function fail(reason: string): false {
  status = "failed";
  liveKernel = null;
  if (!failureLogged) {
    failureLogged = true;
    console.warn(
      `[liverave] C++ wasm kernel unavailable (${reason}); ` +
        "using the TypeScript kernel for this session.",
    );
  }
  return false;
}

function withinTolerance(expected: number, got: number): boolean {
  const abs = Math.abs(got - expected);
  if (abs === 0) return true;
  if (Math.abs(expected) > 1e-9) return abs / Math.abs(expected) <= 1e-6;
  return abs <= 1e-12;
}

function callRawBlend(
  raw: RawKernelExports,
  constraints: BlendGeometryConstraints,
): BlendGeometry {
  const outPtr = raw.blendOutPtr();
  raw.blendGeometry(
    constraints.centreBeats,
    constraints.minBeats !== undefined ? 1 : 0,
    constraints.minBeats ?? 0,
    constraints.maxBeats !== undefined ? 1 : 0,
    constraints.maxBeats ?? 0,
    constraints.beatsPerBar !== undefined ? 1 : 0,
    constraints.beatsPerBar ?? 0,
    constraints.capBeats !== undefined ? 1 : 0,
    constraints.capBeats ?? 0,
    outPtr,
  );
  const out = new Float64Array(raw.memory.buffer, outPtr, 2);
  return { overlapBeats: out[0], swapBeat: out[1] };
}

function wrapRawKernel(raw: RawKernelExports): WasmKernel {
  return {
    tempoFit: (bpmA, bpmB) =>
      raw.tempoFit(
        bpmA ?? 0,
        bpmA != null ? 1 : 0,
        bpmB ?? 0,
        bpmB != null ? 1 : 0,
      ),
    keyFitScoreCore: (hasFit, score) =>
      raw.keyFitScoreCore(hasFit ? 1 : 0, score),
    vocalSafety: (meanA, witnessedA, meanB, witnessedB) =>
      raw.vocalSafety(meanA, witnessedA ? 1 : 0, meanB, witnessedB ? 1 : 0),
    blendGeometry: (constraints) => callRawBlend(raw, constraints),
  };
}

/**
 * Self-check probes: structured edge cases plus values from the
 * seeded parity domains. Every probe must agree with the TypeScript
 * reference within 1e-6 relative or the wasm kernel is rejected.
 */
function passesSelfCheck(kernel: WasmKernel, ref: KernelTsReference): boolean {
  const tempoProbes: [number | null, number | null][] = [
    [120, 120],
    [124, 126],
    [120, 145],
    [60, 120],
    [120, 60],
    [200, 100.5],
    [87.3, 151.9],
    [null, 120],
    [120, null],
    [0, 120],
    [-90, 120],
  ];
  for (const [a, b] of tempoProbes) {
    if (!withinTolerance(ref.tempoFit(a, b), kernel.tempoFit(a, b))) {
      return false;
    }
  }
  const keyProbes: [boolean, number][] = [
    [false, 0],
    [true, 0.85],
    [true, 0.1],
    [true, 1.4],
    [true, -0.25],
    [true, 0],
  ];
  for (const [hasFit, score] of keyProbes) {
    if (
      !withinTolerance(
        ref.keyFitScoreCore(hasFit, score),
        kernel.keyFitScoreCore(hasFit, score),
      )
    ) {
      return false;
    }
  }
  const vocalProbes: [number, boolean, number, boolean][] = [
    [0.05, true, 0.05, true],
    [0.9, true, 0.9, true],
    [0.9, true, 0, false],
    [0, false, 0.9, true],
    [0, false, 0, false],
    [0.37, true, 0.62, false],
    [1.2, true, 1.2, true],
  ];
  for (const [meanA, witA, meanB, witB] of vocalProbes) {
    if (
      !withinTolerance(
        ref.vocalSafety(meanA, witA, meanB, witB),
        kernel.vocalSafety(meanA, witA, meanB, witB),
      )
    ) {
      return false;
    }
  }
  const blendProbes: BlendGeometryConstraints[] = [
    { centreBeats: 16 },
    { centreBeats: 28 },
    { centreBeats: 9 },
    { centreBeats: 28, capBeats: 8 },
    { centreBeats: 15, beatsPerBar: 4 },
    { centreBeats: 12, beatsPerBar: 3 },
    { centreBeats: 20, minBeats: 8, maxBeats: 24 },
    { centreBeats: 100 },
    { centreBeats: 0 },
  ];
  for (const constraints of blendProbes) {
    const expected = ref.blendGeometry(constraints);
    const got = kernel.blendGeometry(constraints);
    if (
      !withinTolerance(expected.overlapBeats, got.overlapBeats) ||
      !withinTolerance(expected.swapBeat, got.swapBeat)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Instantiate from bytes, self-check, and go live. Used by the URL
 * loader below and directly by the parity tests (which read the
 * committed .wasm from disk — vitest rewrites asset URLs, per the
 * spike's G2 lesson). A failure here is permanent for the session.
 */
export async function initKernelWasmFromBytes(
  bytes: BufferSource,
): Promise<boolean> {
  if (status === "live") return true;
  if (status === "failed") return false;
  if (!reference) return fail("no TypeScript reference registered");
  status = "loading";
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const raw = instance.exports as unknown as RawKernelExports;
    if (
      typeof raw.tempoFit !== "function" ||
      typeof raw.keyFitScoreCore !== "function" ||
      typeof raw.vocalSafety !== "function" ||
      typeof raw.blendGeometry !== "function" ||
      typeof raw.blendOutPtr !== "function" ||
      !raw.memory
    ) {
      return fail("wasm module is missing kernel exports");
    }
    const wrapped = wrapRawKernel(raw);
    if (!passesSelfCheck(wrapped, reference)) {
      return fail("self-check mismatch against the TypeScript kernel");
    }
    liveKernel = wrapped;
    status = "live";
    return true;
  } catch (error) {
    return fail(error instanceof Error ? error.message : "instantiate failed");
  }
}

/**
 * Lazy async init from the Vite `?url` asset. Idempotent; never
 * rejects. Until it resolves true, and forever after any failure,
 * kernel.ts computes in TypeScript.
 */
export function ensureKernelWasm(): Promise<boolean> {
  if (status === "live") return Promise.resolve(true);
  if (status === "failed") return Promise.resolve(false);
  if (initPromise) return initPromise;
  status = "loading";
  initPromise = (async () => {
    try {
      const response = await fetch(kernelWasmUrl);
      if (!response.ok) {
        return fail(`asset fetch returned ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      // initKernelWasmFromBytes owns the status from here; reset the
      // "loading" marker it does not expect to re-enter cleanly.
      status = "idle";
      return await initKernelWasmFromBytes(bytes);
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "asset fetch failed",
      );
    }
  })();
  return initPromise;
}
