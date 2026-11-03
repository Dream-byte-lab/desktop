// Perf evidence harness (Wave 3, Item 3) — legacy DOM lyrics animator.
//
// useLyricsAnimator is EXPORTED but has no production caller in the
// current tree (the fullscreen path renders lyrics on canvas via
// LyricsCanvasRenderer). This harness measures it anyway, because
// upstream PR #101 proposed pre-warming THIS animator's line
// changes: if it were ever re-mounted, its loop discipline is what
// would matter. Measured facts pinned here:
//  - its rAF loop reschedules UNCONDITIONALLY (no idle, no pause,
//    no window-visibility gate — contrast FrameLoop);
//  - per-tick cost of its O(lines) active-line scan at 300 lines;
//  - line-change callback rate under dense (180 ms) lines.
//
// jsdom / main-thread only — no GPU is measured here.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { useLyricsAnimator, type SyncedLine } from "./hooks/useLyricsAnimator";
import { applyWindowVisibility } from "@/shared/utils/windowVisibility";

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    median: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// ------------------------------------------------------- manual rAF
// + virtual performance.now (the animator extrapolates from it).

let rafQueue = new Map<number, FrameRequestCallback>();
let nextRafId = 1;
let virtualNow = 1_000_000;

function installStubs() {
  rafQueue = new Map();
  nextRafId = 1;
  virtualNow = 1_000_000;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => virtualNow);
}

function pumpFrame(stepMs = 1000 / 60): number {
  virtualNow += stepMs;
  const callbacks = [...rafQueue.values()];
  rafQueue.clear();
  const start = Date.now();
  for (const cb of callbacks) cb(virtualNow);
  return Date.now() - start;
}

function makeLines(
  count: number,
  lineMs: number,
  wordsPerLine = 3,
): SyncedLine[] {
  return Array.from({ length: count }, (_, i) => {
    const start = i * lineMs;
    const wordMs = Math.floor(lineMs / wordsPerLine);
    return {
      timeMs: start,
      text: `line ${i}`,
      words: Array.from({ length: wordsPerLine }, (_, w) => ({
        timeMs: start + w * wordMs,
        endMs: start + (w + 1) * wordMs,
        text: `w${w} `,
      })),
    };
  });
}

describe("useLyricsAnimator (legacy, no production caller)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installStubs();
    applyWindowVisibility(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    applyWindowVisibility(true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mount(
    lines: SyncedLine[],
    playing: boolean,
    onChange: (idx: number[]) => void,
  ) {
    function Probe() {
      useLyricsAnimator({
        syncedLines: lines,
        isActuallySynced: true,
        isPlaying: playing,
        positionMs: 0,
        durationMs: 600_000,
        onActiveLineChange: onChange,
      });
      return null;
    }
    act(() => root.render(<Probe />));
  }

  it("dense line changes: tick cost + callback rate over 300 lines", () => {
    const changes: number[][] = [];
    mount(makeLines(300, 180), true, (idx) => changes.push(idx));
    const costs: number[] = [];
    // 600 frames x 16.7 ms virtual = 10 s => ~55 line changes.
    for (let i = 0; i < 600; i++) costs.push(pumpFrame());
    const s = stats(costs.slice(60));
    console.log(
      `[perf] animator tick (300 dense lines, playing): median=${s.median}ms(wall, coarse) ` +
        `p95=${s.p95} max=${s.max}; active-line callbacks=${changes.length} over 10 virtual s; ` +
        `rAF still queued=${rafQueue.size}`,
    );
    expect(changes.length).toBeGreaterThanOrEqual(50);
    expect(changes.length).toBeLessThanOrEqual(60);
    // The loop never idles while mounted.
    expect(rafQueue.size).toBe(1);
  });

  it("paused AND hidden: the loop still ticks at full rAF rate (no gates)", () => {
    const changes: number[][] = [];
    mount(makeLines(300, 180), false, (idx) => changes.push(idx));
    applyWindowVisibility(false);
    for (let i = 0; i < 120; i++) {
      pumpFrame();
      // Every single frame the animator reschedules itself, even
      // paused and with the window hidden — pinned as measured fact.
      expect(rafQueue.size).toBe(1);
    }
    console.log(
      `[perf] animator paused+hidden: 120/120 frames rescheduled, callbacks=${changes.length}`,
    );
    applyWindowVisibility(true);
  });

  it("long-song scan: tick cost grows with line count (linear scan per tick)", () => {
    const changes: number[][] = [];
    mount(makeLines(2000, 3000), true, (idx) => changes.push(idx));
    for (let i = 0; i < 120; i++) pumpFrame();
    console.log(
      `[perf] animator tick (2000 lines): callbacks=${changes.length}, queue=${rafQueue.size}`,
    );
    expect(rafQueue.size).toBe(1);
  });
});
