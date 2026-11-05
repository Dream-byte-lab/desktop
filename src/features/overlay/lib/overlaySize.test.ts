import { describe, expect, it } from "vitest";
import {
  clampOverlaySize,
  isOverlaySize,
  matchOverlaySizePreset,
  overlaySizeBand,
  OVERLAY_MAX_SIZE,
  OVERLAY_MIN_SIZE,
  OVERLAY_SIZE_PRESETS,
} from "./overlaySize";

describe("clampOverlaySize", () => {
  it("passes through in-range sizes, rounding to whole pixels", () => {
    expect(clampOverlaySize({ width: 400.4, height: 200.6 })).toEqual({
      width: 400,
      height: 201,
    });
  });

  it("clamps to the drag limits on both ends", () => {
    expect(clampOverlaySize({ width: 10, height: 10 })).toEqual(
      OVERLAY_MIN_SIZE,
    );
    expect(clampOverlaySize({ width: 4000, height: 4000 })).toEqual(
      OVERLAY_MAX_SIZE,
    );
  });

  it("replaces non-finite values with the minimum", () => {
    expect(
      clampOverlaySize({ width: Number.NaN, height: Number.POSITIVE_INFINITY }),
    ).toEqual(OVERLAY_MIN_SIZE);
  });
});

describe("matchOverlaySizePreset", () => {
  it("recognises each anchor exactly", () => {
    expect(matchOverlaySizePreset({ ...OVERLAY_SIZE_PRESETS.small })).toBe(
      "small",
    );
    expect(matchOverlaySizePreset({ ...OVERLAY_SIZE_PRESETS.default })).toBe(
      "default",
    );
    expect(matchOverlaySizePreset({ ...OVERLAY_SIZE_PRESETS.large })).toBe(
      "large",
    );
  });

  it("calls anything between anchors custom", () => {
    expect(matchOverlaySizePreset({ width: 400, height: 200 })).toBe("custom");
  });
});

describe("overlaySizeBand", () => {
  it("maps the anchors to their bands", () => {
    expect(overlaySizeBand({ ...OVERLAY_SIZE_PRESETS.small })).toBe("micro");
    expect(overlaySizeBand({ ...OVERLAY_SIZE_PRESETS.default })).toBe(
      "default",
    );
    expect(overlaySizeBand({ ...OVERLAY_SIZE_PRESETS.large })).toBe("large");
  });

  it("keeps a short window in the micro strip however wide it gets", () => {
    expect(overlaySizeBand({ width: 560, height: 100 })).toBe("micro");
  });

  it("requires both width and height before expanding to the panel", () => {
    expect(overlaySizeBand({ width: 480, height: 200 })).toBe("default");
    expect(overlaySizeBand({ width: 400, height: 360 })).toBe("default");
    expect(overlaySizeBand({ width: 424, height: 264 })).toBe("large");
  });
});

describe("isOverlaySize", () => {
  it("accepts finite numeric pairs and rejects everything else", () => {
    expect(isOverlaySize({ width: 1, height: 2 })).toBe(true);
    expect(isOverlaySize({ width: "1", height: 2 })).toBe(false);
    expect(isOverlaySize({ width: Number.NaN, height: 2 })).toBe(false);
    expect(isOverlaySize(null)).toBe(false);
    expect(isOverlaySize(undefined)).toBe(false);
  });
});
