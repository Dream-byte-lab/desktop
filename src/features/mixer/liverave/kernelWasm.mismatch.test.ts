// kernelWasm.mismatch.test.ts — Wave 2.5 loader self-check behaviour.
//
// The loader compares the wasm kernel against the registered
// TypeScript reference on a fixed probe set before going live.
// Registering a reference that disagrees (here: a tempoFit that is
// deliberately wrong) must make init reject the otherwise-valid
// wasm artefact: status "failed", no live kernel, and the real
// kernel.ts functions keep returning the true TypeScript results.
// Separate test file on purpose (per-file module isolation).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { blendGeometry, keyFitScore, tempoFit } from "./kernel";
import {
  getWasmKernel,
  initKernelWasmFromBytes,
  kernelWasmStatus,
  registerKernelTsReference,
} from "./kernelWasm";

describe("kernel wasm loader self-check (mismatched reference)", () => {
  it("rejects a valid wasm whose probe results disagree", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      registerKernelTsReference({
        // Deliberately wrong: claims every tempo fits perfectly, so
        // the wasm kernel's real Gaussian answers must mismatch.
        tempoFit: () => 1,
        keyFitScoreCore: (hasFit, score) =>
          hasFit ? Math.min(1, Math.max(0, score)) : 0.65,
        vocalSafety: () => 0.5,
        blendGeometry: (c) => blendGeometry({ centreBeats: c.centreBeats }),
      });

      const bytes = readFileSync(
        path.join(process.cwd(), "src/features/mixer/liverave/kernel.wasm"),
      );
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      await expect(initKernelWasmFromBytes(buffer)).resolves.toBe(false);
      expect(kernelWasmStatus()).toBe("failed");
      expect(getWasmKernel()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);

      // The exported functions compute from kernel.ts's own internal
      // TypeScript implementations — not from the loader's
      // registration slot — so they still answer truly.
      expect(tempoFit(120, 145)).toBeLessThan(0.2);
      expect(keyFitScore(null)).toBe(0.65);
    } finally {
      warn.mockRestore();
    }
  });
});
