import { describe, expect, it } from "vitest";
import {
  clampResizeToArea,
  computeDragBounds,
  cubicBezier,
  ensureVisibleBounds,
  isInTopSnapZone,
  lerpEdges,
  minimumSizeFor,
  restoreUnderCursor,
  toEdges,
} from "./window-drag";

describe("computeDragBounds", () => {
  const start = { x: 100, y: 50, width: 1200, height: 780 };

  it("moves by the cursor travel", () => {
    expect(
      computeDragBounds(start, { x: 10, y: 10 }, { x: 35, y: -5 }),
    ).toEqual({
      x: 125,
      y: 35,
      width: 1200,
      height: 780,
    });
  });

  it("never changes the size, however long the drag", () => {
    let cursor = { x: 0, y: 0 };
    for (let i = 0; i < 5000; i++) {
      cursor = {
        x: cursor.x + ((i % 7) - 3) * 1.25,
        y: cursor.y + ((i % 5) - 2) * 1.5,
      };
      const b = computeDragBounds(start, { x: 0, y: 0 }, cursor);
      expect(b.width).toBe(1200);
      expect(b.height).toBe(780);
    }
  });

  it("rounds fractional positions to whole pixels", () => {
    const b = computeDragBounds(start, { x: 0, y: 0 }, { x: 0.6, y: 0.4 });
    expect([b.x, b.y]).toEqual([101, 50]);
  });
});

describe("isInTopSnapZone", () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };

  it("arms on the top edge", () => {
    expect(isInTopSnapZone({ x: 900, y: 0 }, display)).toBe(true);
    expect(isInTopSnapZone({ x: 900, y: 2 }, display)).toBe(true);
  });

  it("stays off below the edge", () => {
    expect(isInTopSnapZone({ x: 900, y: 3 }, display)).toBe(false);
    expect(isInTopSnapZone({ x: 900, y: 400 }, display)).toBe(false);
  });

  it("only counts the display the cursor is on", () => {
    const second = { x: 1920, y: 200, width: 1920, height: 1080 };
    expect(isInTopSnapZone({ x: 2500, y: 200 }, second)).toBe(true);
    expect(isInTopSnapZone({ x: 900, y: 0 }, second)).toBe(false);
  });
});

describe("restoreUnderCursor", () => {
  const maximized = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 1200, height: 780 };

  it("keeps the cursor at the same relative x", () => {
    const r = restoreUnderCursor(maximized, size, { x: 960, y: 12 });
    expect(r).toEqual({ x: 360, y: 0, width: 1200, height: 780 });
  });

  it("works at the far right", () => {
    const r = restoreUnderCursor(maximized, size, { x: 1920, y: 12 });
    expect(r.x + r.width).toBe(1920);
  });

  it("clamps the vertical offset into the restored height", () => {
    const r = restoreUnderCursor(
      maximized,
      { width: 400, height: 300 },
      { x: 960, y: 900 },
    );
    expect(r.y).toBe(900 - 299);
  });
});

describe("snap preview geometry", () => {
  it("converts rects to edges and interpolates them", () => {
    const a = toEdges({ x: 10, y: 20, width: 100, height: 50 });
    expect(a).toEqual([10, 20, 110, 70]);
    expect(lerpEdges(a, [0, 0, 200, 100], 0.5)).toEqual([5, 10, 155, 85]);
  });

  it("cubicBezier matches the endpoints and the linear curve", () => {
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0)).toBe(0);
    expect(linear(1)).toBe(1);
    expect(linear(0.37)).toBeCloseTo(0.37, 4);
  });

  it("cubicBezier ease-out is ahead of linear and monotonic", () => {
    const easeOut = cubicBezier(0.33, 1, 0.68, 1);
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const t = i / 20;
      const v = easeOut(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      if (t < 1) expect(v).toBeGreaterThan(t);
      prev = v;
    }
  });
});

describe("minimumSizeFor", () => {
  it("keeps the normal minimum on a big screen", () => {
    expect(
      minimumSizeFor(
        { width: 1100, height: 705 },
        { x: 0, y: 0, width: 1920, height: 1032 },
      ),
    ).toEqual({ width: 1100, height: 705 });
  });

  it("shrinks to the visible area of a small scaled laptop screen", () => {
    expect(
      minimumSizeFor(
        { width: 1100, height: 705 },
        { x: 0, y: 0, width: 1093, height: 574 },
      ),
    ).toEqual({ width: 1093, height: 574 });
  });
});

describe("clampResizeToArea", () => {
  const area = { x: 0, y: 0, width: 1366, height: 720 };

  it("pulls a bottom edge dragged under the taskbar back up", () => {
    expect(
      clampResizeToArea({ x: 100, y: 50, width: 1100, height: 760 }, area),
    ).toEqual({ x: 100, y: 50, width: 1100, height: 670 });
  });

  it("trims edges dragged past the left and top", () => {
    expect(
      clampResizeToArea({ x: -40, y: -20, width: 1200, height: 700 }, area),
    ).toEqual({ x: 0, y: 0, width: 1160, height: 680 });
  });

  it("leaves a window that already fits alone", () => {
    const rect = { x: 120, y: 10, width: 1100, height: 705 };
    expect(clampResizeToArea(rect, area)).toEqual(rect);
  });

  it("cannot recover a rect fully outside the area (the #356 gap)", () => {
    // keepInsideWorkArea() in main.ts clamps against the display matching the
    // window's bounds; for a fully off-screen rect that clamp is a no-op, so
    // nothing in the resize/moved path can ever bring the window back.
    const offscreen = { x: 5000, y: 4000, width: 1100, height: 705 };
    expect(clampResizeToArea(offscreen, area)).toEqual(offscreen);
  });
});

describe("ensureVisibleBounds", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const second = { x: 1920, y: 0, width: 1920, height: 1040 };

  it("returns the rect unchanged when there are no displays", () => {
    const rect = { x: 5000, y: 4000, width: 1100, height: 705 };
    expect(ensureVisibleBounds(rect, [])).toEqual(rect);
  });

  it("leaves a fully visible window alone", () => {
    const rect = { x: 120, y: 10, width: 1100, height: 705 };
    expect(ensureVisibleBounds(rect, [primary])).toEqual(rect);
  });

  it("leaves a window with exactly the minimum sliver visible alone", () => {
    // 64px of width and 48px of height still on screen
    const rect = { x: 1920 - 64, y: 1040 - 48, width: 1100, height: 705 };
    expect(ensureVisibleBounds(rect, [primary])).toEqual(rect);
  });

  it.each([
    ["right", { x: 5000, y: 100, width: 1100, height: 705 }],
    ["bottom", { x: 100, y: 4000, width: 1100, height: 705 }],
    ["left", { x: -3000, y: 100, width: 1100, height: 705 }],
    ["top", { x: 100, y: -2000, width: 1100, height: 705 }],
  ])(
    "recovers a window fully off the %s, centered on the primary area",
    (_side, rect) => {
      expect(ensureVisibleBounds(rect, [primary])).toEqual({
        x: 410,
        y: 168,
        width: 1100,
        height: 705,
      });
    },
  );

  it("recovers a window left with less than the minimum sliver visible", () => {
    const rect = { x: 1920 - 20, y: 100, width: 1100, height: 705 };
    expect(ensureVisibleBounds(rect, [primary])).toEqual({
      x: 410,
      y: 168,
      width: 1100,
      height: 705,
    });
  });

  it("leaves a window alone when a second display shows enough of it", () => {
    // barely on the primary, but a healthy chunk lives on the second display
    const rect = { x: 1900, y: 100, width: 1100, height: 705 };
    expect(ensureVisibleBounds(rect, [primary, second])).toEqual(rect);
  });

  it("recovers onto the primary display when no display shows enough", () => {
    const rect = { x: 3820, y: 100, width: 1100, height: 705 };
    expect(ensureVisibleBounds(rect, [primary, second])).toEqual({
      x: 410,
      y: 168,
      width: 1100,
      height: 705,
    });
  });

  it("clamps an oversized rect to the primary area when recovering", () => {
    const rect = { x: 9000, y: 9000, width: 3000, height: 2000 };
    expect(ensureVisibleBounds(rect, [primary])).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1040,
    });
  });

  it("respects a primary area with a non-zero origin", () => {
    const shifted = { x: 100, y: 50, width: 1600, height: 900 };
    const rect = { x: -5000, y: -5000, width: 1200, height: 700 };
    expect(ensureVisibleBounds(rect, [shifted])).toEqual({
      x: 300,
      y: 150,
      width: 1200,
      height: 700,
    });
  });

  it("is idempotent: a recovered rect is left alone", () => {
    const once = ensureVisibleBounds(
      { x: 5000, y: 4000, width: 1100, height: 705 },
      [primary, second],
    );
    expect(ensureVisibleBounds(once, [primary, second])).toEqual(once);
  });
});
