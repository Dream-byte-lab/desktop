// Reference 27 display options at the canvas layer: the text-align
// choice re-lays the SAME lines out (centred vs start), Bigger text
// scales the scene typography, and Highlight off paints every line
// in one even register — no karaoke sweep, no gradient, no glow —
// while the sync layout underneath is untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lyric } from "@braccato/parsers";
import { LyricsScene } from "./lyricsScene";
import { drawLine } from "./drawLine";
import { buildLines } from "./buildLines";
import { layoutLines } from "./layoutLines";
import { createTextMeasure } from "./textMeasure";
import { LYRICS_TYPOGRAPHY } from "./fonts";

// ------------------------------------------------------- fake 2D ctx

interface RecordingCtx {
  ctx: CanvasRenderingContext2D;
  fills: string[];
  gradientCalls: () => number;
}

/** A 2D context whose measureText honours the current font size. */
function makeFakeCtx(canvas?: HTMLCanvasElement): RecordingCtx {
  const fills: string[] = [];
  let gradients = 0;
  const gradient = { addColorStop: () => undefined };
  const base: Record<string, unknown> = {
    canvas: canvas ?? null,
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
    direction: "ltr",
    textAlign: "left",
    textBaseline: "alphabetic",
    measureText: (text: string) => {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(String(base.font))?.[1] ?? 32);
      return {
        width: text.length * px * 0.45,
        fontBoundingBoxAscent: px * 0.75,
        fontBoundingBoxDescent: px * 0.25,
        actualBoundingBoxAscent: px * 0.75,
        actualBoundingBoxDescent: px * 0.25,
      } as TextMetrics;
    },
    createLinearGradient: () => {
      gradients++;
      return gradient;
    },
    createRadialGradient: () => gradient,
    fillText: () => {
      fills.push(String(base.fillStyle));
    },
  };
  const proxy = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
  return {
    ctx: proxy as unknown as CanvasRenderingContext2D,
    fills,
    gradientCalls: () => gradients,
  };
}

function installCanvasStub() {
  const byCanvas = new WeakMap<object, RecordingCtx>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement, type: string) {
      if (type !== "2d") return null;
      let rec = byCanvas.get(this);
      if (!rec) {
        rec = makeFakeCtx(this);
        byCanvas.set(this, rec);
      }
      return rec.ctx;
    } as typeof HTMLCanvasElement.prototype.getContext,
  );
}

function makeLyricLine(): Lyric[] {
  const words = ["one ", "two ", "three"];
  return [
    {
      startTimeMs: 0,
      durationMs: 3000,
      words: words.join(""),
      parts: words.map((word, i) => ({
        startTimeMs: i * 1000,
        durationMs: 1000,
        words: word,
      })),
    } as Lyric,
  ];
}

beforeEach(() => {
  installCanvasStub();
  // Deterministic font loading: jsdom has no real FontFace engine.
  vi.stubGlobal(
    "FontFace",
    class FakeFontFace {
      status = "loaded";
      constructor(
        public family: string,
        public source: string,
      ) {}
      load() {
        return Promise.resolve(this);
      }
    },
  );
  Object.defineProperty(document, "fonts", {
    value: undefined,
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeScene() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rec = makeFakeCtx();
  const scene = new LyricsScene(rec.ctx, host, () => undefined);
  scene.setSize(800, 600);
  scene.setLyrics(makeLyricLine());
  return { scene, host };
}

describe("LyricsScene display options", () => {
  it("centred alignment moves line content right of the start register, live", () => {
    const { scene, host } = makeScene();
    try {
      expect(scene.layouts.length).toBe(1);
      const startX = scene.layouts[0]?.tokens[0]?.x ?? 0;

      scene.setDisplayOptions({ align: "center" });
      const centerX = scene.layouts[0]?.tokens[0]?.x ?? 0;
      expect(centerX).toBeGreaterThan(startX + 50);

      scene.setDisplayOptions({ align: "start" });
      expect(scene.layouts[0]?.tokens[0]?.x ?? 0).toBe(startX);
    } finally {
      scene.dispose();
      host.remove();
    }
  });

  it("bigger text scales the typography and the laid-out line height", () => {
    const { scene, host } = makeScene();
    try {
      expect(scene.layouts.length).toBe(1);
      const baseHeight = scene.layouts[0]?.height ?? 0;
      expect(scene.typography.size).toBe(LYRICS_TYPOGRAPHY.size);

      scene.setDisplayOptions({ textScale: 1.3 });
      expect(scene.typography.size).toBe(Math.round(32 * 1.3));
      expect(scene.layouts[0]?.height ?? 0).toBeGreaterThan(baseHeight);

      scene.setDisplayOptions({ textScale: 1 });
      expect(scene.typography.size).toBe(LYRICS_TYPOGRAPHY.size);
    } finally {
      scene.dispose();
      host.remove();
    }
  });
});

function alphaOf(fill: string): number {
  return Number(/,\s*([\d.]+)\)$/.exec(fill)?.[1] ?? Number.NaN);
}

describe("drawLine highlight register", () => {
  function layoutFirstLine() {
    const rec = makeFakeCtx();
    const model = buildLines(makeLyricLine());
    const measure = createTextMeasure(rec.ctx);
    const layouts = layoutLines(model.lines, measure, LYRICS_TYPOGRAPHY, {
      left: 32,
      width: 736,
      top: 32,
    });
    return layouts[0];
  }

  it("highlight on: the active token is painted with a gradient sweep", () => {
    const layout = layoutFirstLine();
    expect(layout).toBeDefined();
    const rec = makeFakeCtx();
    // t=1500: token 0 sung, token 1 mid-sweep, token 2 pending.
    drawLine(rec.ctx, layout!, 0, 1500, LYRICS_TYPOGRAPHY, 1, 0, true);
    expect(rec.gradientCalls()).toBeGreaterThan(0);
    expect(rec.fills.some((fill) => alphaOf(fill) === 1)).toBe(true);
  });

  it("highlight off: every token paints at the one even alpha, no gradient", () => {
    const layout = layoutFirstLine();
    expect(layout).toBeDefined();
    const rec = makeFakeCtx();
    drawLine(rec.ctx, layout!, 0, 1500, LYRICS_TYPOGRAPHY, 1, 0, false);
    expect(rec.gradientCalls()).toBe(0);
    expect(rec.fills.length).toBeGreaterThan(0);
    for (const fill of rec.fills) {
      expect(alphaOf(fill)).toBeCloseTo(0.62, 5);
    }
  });
});
