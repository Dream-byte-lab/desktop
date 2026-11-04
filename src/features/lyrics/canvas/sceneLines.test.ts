// Reference 28's distance falloff: context lines dim with their
// distance from the line being sung, applied at composite time —
// the still bitmaps' painted alphas (and cache keys) do not move.
// Highlight off keeps the one even register: no falloff at all.

import { describe, expect, it } from "vitest";
import {
  activeLineIndex,
  contextDim,
  visibleLines,
  type SceneFrame,
} from "./sceneLines";
import type { LineLayout, LyricLineModel } from "./types";

function makeLine(startMs: number): LyricLineModel {
  return {
    startMs,
    durationMs: 1000,
    endMs: startMs + 1000,
    nextStartMs: startMs + 1000,
    align: "center",
    rtl: false,
    instrumental: false,
    tokens: [],
    subtitle: null,
  };
}

function makeFrame(highlight: boolean, timeMs: number): SceneFrame {
  const models = Array.from({ length: 8 }, (_, i) => makeLine(i * 1000));
  const layouts: LineLayout[] = models.map((line, i) => ({
    line,
    top: i * 60,
    height: 50,
    tokens: [],
    subtitle: [],
  }));
  const scene = {
    lines: models,
    layouts,
    display: {
      align: "center",
      highlight,
      textScale: 1,
      romanization: false,
    },
    height: 600,
    width: 800,
    version: 1,
  };
  const motion = {
    position: 0,
    offsetFor: () => 0,
    isWheelMoving: () => false,
  };
  return {
    scene,
    motion,
    now: 0,
    timeMs,
    dpr: 1,
  } as unknown as SceneFrame;
}

describe("contextDim", () => {
  it("keeps the sung line and its neighbours at full brightness", () => {
    expect(contextDim(0)).toBe(1);
    expect(contextDim(1)).toBe(1);
  });

  it("falls away with distance and levels off at the floor", () => {
    expect(contextDim(2)).toBeCloseTo(0.935, 5);
    expect(contextDim(3)).toBeLessThan(contextDim(2));
    expect(contextDim(5)).toBeCloseTo(0.74, 5);
    expect(contextDim(30)).toBe(0.6);
  });
});

describe("activeLineIndex", () => {
  const lines = [makeLine(0), makeLine(1000), makeLine(2000)];

  it("anchors on the first line before anything has started", () => {
    expect(activeLineIndex(lines, -500)).toBe(0);
    expect(activeLineIndex([], 1000)).toBe(0);
  });

  it("tracks the last line that has started", () => {
    expect(activeLineIndex(lines, 0)).toBe(0);
    expect(activeLineIndex(lines, 1500)).toBe(1);
    expect(activeLineIndex(lines, 99999)).toBe(2);
  });
});

describe("visibleLines distance dim", () => {
  it("dims lines by their distance from the sung line", () => {
    // t=2500: line 2 is being sung.
    const lines = visibleLines(makeFrame(true, 2500));
    const dimOf = (index: number) =>
      lines.find((line) => line.index === index)?.dim;
    expect(dimOf(2)).toBe(1);
    expect(dimOf(1)).toBe(1);
    expect(dimOf(3)).toBe(1);
    expect(dimOf(0)).toBeCloseTo(0.935, 5);
    expect(dimOf(7)).toBeCloseTo(0.74, 5);
  });

  it("highlight off: the even register — no line is dimmed", () => {
    const lines = visibleLines(makeFrame(false, 2500));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.dim).toBe(1);
  });
});
