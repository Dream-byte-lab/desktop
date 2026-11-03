// Perf evidence harness (Wave 3, Item 3) — lyrics canvas path.
//
// MEASUREMENT ONLY: assertions are behavioural invariants (loop
// demand rates, visibility gating, visible-line culling, idle
// drain). The numbers are logged with a [perf] prefix; there are
// NO wall-clock pass/fail thresholds, so CI cannot flake on them.
//
// jsdom measures MAIN-THREAD cost only. It has no GPU: nothing in
// this file measures GPU %. The canvas 2D context is a counting
// fake, so "paint work" is reported as canvas-op counts (a repaint
// driver proxy), not as rasterisation time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lyric } from "@braccato/parsers";
import { FrameLoop } from "./frameLoop";
import { LyricsCanvasRenderer } from "./lyricsCanvasRenderer";
import { buildLines } from "./buildLines";
import { layoutLines } from "./layoutLines";
import { createTextMeasure } from "./textMeasure";
import { LYRICS_TYPOGRAPHY } from "./fonts";
import { applyWindowVisibility } from "@/shared/utils/windowVisibility";

// ---------------------------------------------------------------- stats

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    n: values.length,
    median: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1] ?? 0,
    mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
  };
}

function fmt(label: string, values: number[]) {
  const s = stats(values);
  console.log(
    `[perf] ${label}: n=${s.n} median=${s.median.toFixed(3)}ms ` +
      `p95=${s.p95.toFixed(3)}ms max=${s.max.toFixed(3)}ms mean=${s.mean.toFixed(3)}ms`,
  );
  return s;
}

// ------------------------------------------------------- manual rAF

let rafQueue = new Map<number, FrameRequestCallback>();
let nextRafId = 1;

function installRafStub() {
  rafQueue = new Map();
  nextRafId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue.delete(id);
  });
}

/** Run one frame's worth of queued rAF callbacks; returns sync cost. */
function pumpFrame(now: number): number {
  const callbacks = [...rafQueue.values()];
  rafQueue.clear();
  const start = performance.now();
  for (const cb of callbacks) cb(now);
  return performance.now() - start;
}

// ------------------------------------------------- counting 2D ctx

const ctxOps = new Map<string, number>();
function countOp(name: string) {
  ctxOps.set(name, (ctxOps.get(name) ?? 0) + 1);
}
function opsSnapshot() {
  return Object.fromEntries(ctxOps);
}
function opsDelta(before: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const [k, v] of ctxOps) out[k] = v - (before[k] ?? 0);
  return out;
}

const ctxByCanvas = new WeakMap<object, unknown>();

function makeFakeCtx(canvas: HTMLCanvasElement) {
  const cached = ctxByCanvas.get(canvas);
  if (cached) return cached;
  const gradient = { addColorStop: () => countOp("addColorStop") };
  const base: Record<string, unknown> = {
    canvas,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    shadowBlur: 0,
    shadowColor: "",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    lineWidth: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    measureText: (text: string) => {
      countOp("measureText");
      return {
        width: text.length * 9,
        fontBoundingBoxAscent: 24,
        fontBoundingBoxDescent: 8,
        actualBoundingBoxAscent: 24,
        actualBoundingBoxDescent: 8,
      } as TextMetrics;
    },
    createLinearGradient: () => {
      countOp("createLinearGradient");
      return gradient;
    },
    createRadialGradient: () => {
      countOp("createRadialGradient");
      return gradient;
    },
    getImageData: () => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    }),
  };
  const proxy = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return (..._args: unknown[]) => {
        countOp(String(prop));
        return undefined;
      };
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
  ctxByCanvas.set(canvas, proxy);
  return proxy;
}

function installCanvasStub() {
  ctxOps.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement, type: string) {
      if (type === "2d") return makeFakeCtx(this);
      return null;
    } as typeof HTMLCanvasElement.prototype.getContext,
  );
}

// ------------------------------------------------------------ fixtures

/** Word-timed lines: `count` lines, one every `lineMs`, words evenly split. */
function makeLyrics(count: number, lineMs: number, wordsPerLine = 6): Lyric[] {
  return Array.from({ length: count }, (_, i) => {
    const start = i * lineMs;
    const wordMs = Math.floor(lineMs / wordsPerLine);
    const parts = Array.from({ length: wordsPerLine }, (_, w) => ({
      startTimeMs: start + w * wordMs,
      durationMs: wordMs,
      words: `word${w} `,
    }));
    return {
      startTimeMs: start,
      durationMs: lineMs,
      words: parts.map((p) => p.words).join(""),
      parts,
    } as Lyric;
  });
}

interface ClockState {
  time: number;
  playing: boolean;
}

function makeRenderer(clock: ClockState) {
  const canvas = document.createElement("canvas");
  const live = document.createElement("canvas");
  const edges: Array<[boolean, boolean]> = [];
  const renderer = new LyricsCanvasRenderer(
    canvas,
    live,
    {
      timeMs: () => clock.time,
      playing: () => clock.playing,
    },
    (atTop, atBottom) => edges.push([atTop, atBottom]),
  );
  return { renderer, edges };
}

/**
 * Drive the renderer at 60 fps for `frames` frames while lyric time
 * advances in real time. Returns per-frame sync costs. When `lineMs`
 * is given, costs are also split into frames that cross a line
 * boundary vs steady frames (the PR #101 pre-warm question).
 */
function drivePlayback(
  clock: ClockState,
  frames: number,
  startNow = 0,
  lineMs?: number,
): { all: number[]; crossing: number[]; steady: number[] } {
  const all: number[] = [];
  const crossing: number[] = [];
  const steady: number[] = [];
  let now = startNow;
  let prevLine = -1;
  for (let i = 0; i < frames; i++) {
    now += 1000 / 60;
    clock.time = now;
    const cost = pumpFrame(now);
    all.push(cost);
    if (lineMs) {
      const line = Math.floor(now / lineMs);
      (line !== prevLine ? crossing : steady).push(cost);
      prevLine = line;
    }
  }
  return { all, crossing, steady };
}

// -------------------------------------------------------------- tests

describe("FrameLoop demand rates (production loop, manual rAF)", () => {
  beforeEach(() => {
    installRafStub();
    applyWindowVisibility(true);
  });
  afterEach(() => {
    applyWindowVisibility(true);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("animate demand: one tick per rAF frame (~60/s at 60 Hz)", () => {
    let ticks = 0;
    const loop = new FrameLoop(() => {
      ticks++;
      return "animate";
    });
    loop.poke();
    for (let i = 1; i <= 120; i++) pumpFrame(i * (1000 / 60));
    console.log(`[perf] FrameLoop animate: ${ticks} ticks / 120 frames`);
    expect(ticks).toBe(120);
    loop.dispose();
  });

  it("poll demand: ~20 ticks per simulated second (50 ms poll)", () => {
    // Virtual timers (fake timers would clobber the manual rAF stub).
    const timers = new Map<number, { cb: () => void; at: number }>();
    let nextTimerId = 1;
    let virtualNow = 0;
    const realSetTimeout = window.setTimeout;
    const realClearTimeout = window.clearTimeout;
    window.setTimeout = ((cb: () => void, ms: number) => {
      const id = nextTimerId++;
      timers.set(id, { cb, at: virtualNow + ms });
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as typeof window.clearTimeout;
    try {
      let ticks = 0;
      const loop = new FrameLoop(() => {
        ticks++;
        return "poll";
      });
      loop.poke();
      // Simulate 1 second: alternate rAF frames and timer advances.
      let now = 0;
      while (virtualNow < 1000) {
        now += 1000 / 60;
        pumpFrame(now);
        virtualNow += 50;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= virtualNow) {
            timers.delete(id);
            timer.cb();
          }
        }
      }
      console.log(
        `[perf] FrameLoop poll: ${ticks} ticks / 1 simulated s (50 ms poll)`,
      );
      expect(ticks).toBeGreaterThanOrEqual(18);
      expect(ticks).toBeLessThanOrEqual(22);
      loop.dispose();
    } finally {
      window.setTimeout = realSetTimeout;
      window.clearTimeout = realClearTimeout;
    }
  });

  it("idle demand: exactly one tick, loop fully stops", () => {
    let ticks = 0;
    const loop = new FrameLoop(() => {
      ticks++;
      return "idle";
    });
    loop.poke();
    pumpFrame(16);
    pumpFrame(32);
    pumpFrame(48);
    console.log(
      `[perf] FrameLoop idle: ${ticks} ticks, queue=${rafQueue.size}`,
    );
    expect(ticks).toBe(1);
    expect(rafQueue.size).toBe(0);
    loop.dispose();
  });

  it("hidden window: ticks stop dead; visible again resumes via poke", () => {
    let ticks = 0;
    const loop = new FrameLoop(() => {
      ticks++;
      return "animate";
    });
    loop.poke();
    pumpFrame(16);
    expect(ticks).toBe(1);
    applyWindowVisibility(false);
    // The already-queued frame fires once, sees hidden, does not tick
    // and does not reschedule.
    pumpFrame(32);
    pumpFrame(48);
    expect(ticks).toBe(1);
    expect(rafQueue.size).toBe(0);
    applyWindowVisibility(true);
    pumpFrame(64);
    console.log(`[perf] FrameLoop hidden gate: ticks after resume=${ticks}`);
    expect(ticks).toBe(2);
    loop.dispose();
  });
});

describe("LyricsCanvasRenderer over long word-timed lyrics (jsdom, counting ctx)", () => {
  beforeEach(() => {
    installRafStub();
    installCanvasStub();
    applyWindowVisibility(true);
  });
  afterEach(() => {
    applyWindowVisibility(true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("one-time build+layout cost for 260 word-timed lines", () => {
    const lyrics = makeLyrics(260, 2300);
    const costs: number[] = [];
    for (let run = 0; run < 5; run++) {
      const ctx = makeFakeCtx(document.createElement("canvas")) as never;
      const start = performance.now();
      const model = buildLines(lyrics);
      const measure = createTextMeasure(ctx);
      const layouts = layoutLines(model.lines, measure, LYRICS_TYPOGRAPHY, {
        left: 32,
        width: 736,
        top: 32,
      });
      costs.push(performance.now() - start);
      expect(layouts.length).toBe(260);
    }
    fmt("buildLines+layoutLines 260 lines (one-time)", costs);
  });

  it("250+ line song, real-time playback: per-frame tick cost + paint ops", () => {
    const clock: ClockState = { time: 0, playing: true };
    const { renderer } = makeRenderer(clock);
    renderer.resize(800, 600, 1);
    renderer.setLyrics(makeLyrics(260, 2300));
    pumpFrame(0); // settle initial snap

    const before = opsSnapshot();
    // 30 simulated seconds at 60 fps.
    const driven = drivePlayback(clock, 1800, 0, 2300);
    const costs = driven.all;
    const ops = opsDelta(before);
    fmt("renderer tick, 260-line song, playing (per rAF frame)", costs);
    fmt(
      "renderer tick, 260-line song, post-warmup frames 120+",
      costs.slice(120),
    );
    fmt("renderer tick, line-CROSSING frames only", driven.crossing.slice(1));
    fmt("renderer tick, steady frames only", driven.steady.slice(120));
    console.log(
      `[perf] canvas ops over 1800 frames: ${JSON.stringify(ops)} ` +
        `(drawImage/frame=${((ops.drawImage ?? 0) / 1800).toFixed(2)}, ` +
        `fillText/frame=${((ops.fillText ?? 0) / 1800).toFixed(2)}, ` +
        `clearRect/frame=${((ops.clearRect ?? 0) / 1800).toFixed(2)})`,
    );
    // Invariant: the loop is alive while playing (frames keep coming).
    expect(rafQueue.size).toBeGreaterThan(0);
    renderer.dispose();
  });

  it("dense line changes (5.6 changes/s): per-frame tick cost + repaint ops", () => {
    const clock: ClockState = { time: 0, playing: true };
    const { renderer } = makeRenderer(clock);
    renderer.resize(800, 600, 1);
    // 180 ms lines => ~5.6 line changes per second, word sweep always live.
    renderer.setLyrics(makeLyrics(300, 180, 3));
    pumpFrame(0);

    const before = opsSnapshot();
    // 10 simulated seconds at 60 fps => ~55 line changes.
    const driven = drivePlayback(clock, 600, 0, 180);
    const costs = driven.all;
    const ops = opsDelta(before);
    fmt("renderer tick, dense 180ms lines (per rAF frame)", costs);
    fmt("renderer tick, dense line-CROSSING frames", driven.crossing.slice(1));
    fmt("renderer tick, dense steady frames", driven.steady.slice(60));
    console.log(
      `[perf] dense: canvas ops over 600 frames: ${JSON.stringify(ops)} ` +
        `(fillText/frame=${((ops.fillText ?? 0) / 600).toFixed(2)})`,
    );
    expect(rafQueue.size).toBeGreaterThan(0);
    renderer.dispose();
  });

  it("paused with nothing moving: loop drains to idle (0 callbacks/s)", () => {
    const clock: ClockState = { time: 5000, playing: true };
    const { renderer } = makeRenderer(clock);
    renderer.resize(800, 600, 1);
    renderer.setLyrics(makeLyrics(260, 2300));
    drivePlayback(clock, 120);
    clock.playing = false;
    // Keep pumping simulated frames; the demand-driven loop must stop
    // scheduling once motion/fog/fade settle and playing() is false.
    let now = 2000;
    for (let i = 0; i < 600 && rafQueue.size > 0; i++) {
      now += 1000 / 60;
      clock.time = 5000 + i; // lyric clock held (paused media)
      pumpFrame(now);
    }
    console.log(
      `[perf] renderer paused drain: rAF queue after settle=${rafQueue.size}`,
    );
    expect(rafQueue.size).toBe(0);
    renderer.dispose();
  });

  it("hidden window: renderer ticks stop; visible resumes", () => {
    const clock: ClockState = { time: 0, playing: true };
    const { renderer } = makeRenderer(clock);
    renderer.resize(800, 600, 1);
    renderer.setLyrics(makeLyrics(260, 2300));
    drivePlayback(clock, 60);
    applyWindowVisibility(false);
    const queuedBefore = rafQueue.size;
    pumpFrame(2000);
    pumpFrame(2016);
    console.log(
      `[perf] renderer hidden: queued before=${queuedBefore} after=${rafQueue.size}`,
    );
    expect(rafQueue.size).toBe(0);
    applyWindowVisibility(true);
    // Visibility listener pokes the loop; a frame is queued again.
    expect(rafQueue.size).toBeGreaterThan(0);
    renderer.dispose();
  });
});
