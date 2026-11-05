// kernelWasm.fallback.test.ts — Wave 2.5 loader failure behaviour.
//
// Corrupt wasm bytes must produce: init resolves false, the status
// is permanently "failed" for the session (a later init attempt —
// even with valid bytes — is refused), the failure is logged
// exactly once, and the exported kernel functions keep computing
// the correct TypeScript results throughout. Separate test file on
// purpose: vitest isolates modules per file, so this file's
// permanently-failed loader state cannot leak into the parity test.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { blendGeometry, tempoFit, vocalSafety } from "./kernel";
import {
  ensureKernelWasm,
  getWasmKernel,
  initKernelWasmFromBytes,
  kernelWasmStatus,
} from "./kernelWasm";

describe("kernel wasm loader fallback (corrupt artefact)", () => {
  it("fails permanently, logs once, and TS results are unaffected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const corrupt = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff, 0xff]);
      const corruptBuffer = corrupt.buffer.slice(
        corrupt.byteOffset,
        corrupt.byteOffset + corrupt.byteLength,
      ) as ArrayBuffer;
      await expect(initKernelWasmFromBytes(corruptBuffer)).resolves.toBe(false);
      expect(kernelWasmStatus()).toBe("failed");
      expect(getWasmKernel()).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);

      // Permanent for the session: valid bytes cannot resurrect it,
      // and ensureKernelWasm does not retry (or log again).
      const bytes = readFileSync(
        path.join(process.cwd(), "src/features/mixer/liverave/kernel.wasm"),
      );
      const validBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      await expect(initKernelWasmFromBytes(validBuffer)).resolves.toBe(false);
      await expect(ensureKernelWasm()).resolves.toBe(false);
      expect(kernelWasmStatus()).toBe("failed");
      expect(warn).toHaveBeenCalledTimes(1);

      // The TypeScript kernel is the whole story after a failure.
      expect(tempoFit(120, 120)).toBe(1);
      expect(tempoFit(null, 120)).toBe(0.5);
      expect(tempoFit(124, 126)).toBeCloseTo(0.9676428924867482);
      expect(
        vocalSafety(
          { mean: 0.9, confidence: 0.9, witnessed: true },
          { mean: 0.9, confidence: 0.9, witnessed: true },
        ),
      ).toBeCloseTo(0.19);
      expect(blendGeometry({ centreBeats: 28, capBeats: 8 })).toEqual({
        overlapBeats: 8,
        swapBeat: 4,
      });
    } finally {
      warn.mockRestore();
    }
  });
});
