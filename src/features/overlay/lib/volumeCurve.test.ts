import { describe, expect, it } from "vitest";
import {
  OVERLAY_FULL_VOLUME_LEVEL,
  toOverlayVolumeGain,
  toOverlayVolumeLevel,
} from "./volumeCurve";

// Anchor points of the app's volume curve (player/engine/volume.ts):
// gain 1.0 (100%) sits at 70% of slider travel; gain 5.0 (500%) is the top.
describe("overlay volume curve mirror", () => {
  it("pins the anchor points", () => {
    expect(toOverlayVolumeLevel(0)).toBe(0);
    expect(toOverlayVolumeLevel(1)).toBe(OVERLAY_FULL_VOLUME_LEVEL);
    expect(toOverlayVolumeLevel(5)).toBe(1);
    expect(toOverlayVolumeGain(0)).toBe(0);
    expect(toOverlayVolumeGain(OVERLAY_FULL_VOLUME_LEVEL)).toBe(1);
    expect(toOverlayVolumeGain(1)).toBe(5);
  });

  it("round-trips gain → level → gain", () => {
    for (const gain of [0.05, 0.25, 0.5, 0.9, 1, 1.8, 3.2, 4.9]) {
      expect(toOverlayVolumeGain(toOverlayVolumeLevel(gain))).toBeCloseTo(
        gain,
        6,
      );
    }
  });

  it("clamps out-of-domain inputs", () => {
    expect(toOverlayVolumeLevel(-2)).toBe(0);
    expect(toOverlayVolumeLevel(99)).toBe(1);
    expect(toOverlayVolumeGain(-1)).toBe(0);
    expect(toOverlayVolumeGain(2)).toBe(5);
  });
});
