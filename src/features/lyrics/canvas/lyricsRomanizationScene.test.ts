// Harvest Wave 4, Item 1 — the scene side: LyricsScene retains the
// source Lyric[] and a romanization flip rebuilds the line model at
// change time (sub-lines appear/disappear), while unchanged options
// stay a no-op and the other display options are unregressed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lyric } from "@braccato/parsers";
import { LyricsScene } from "./lyricsScene";

// ------------------------------------------------------- fake 2D ctx

function makeFakeCtx(canvas?: HTMLCanvasElement) {
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
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    fillText: () => undefined,
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
  return proxy as unknown as CanvasRenderingContext2D;
}

function installCanvasStub() {
  const byCanvas = new WeakMap<object, CanvasRenderingContext2D>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement, type: string) {
      if (type !== "2d") return null;
      let ctx = byCanvas.get(this);
      if (!ctx) {
        ctx = makeFakeCtx(this);
        byCanvas.set(this, ctx);
      }
      return ctx;
    } as typeof HTMLCanvasElement.prototype.getContext,
  );
}

function hangulLyrics(): Lyric[] {
  return [
    {
      startTimeMs: 0,
      durationMs: 3000,
      words: "안녕하세요",
    } as Lyric,
    {
      startTimeMs: 3000,
      durationMs: 3000,
      words: "한국말",
    } as Lyric,
  ];
}

beforeEach(() => {
  installCanvasStub();
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
  const scene = new LyricsScene(makeFakeCtx(), host, () => undefined);
  scene.setSize(800, 600);
  return { scene, host };
}

describe("LyricsScene romanization flip", () => {
  it("default: no romanization sub-lines; flipping on rebuilds the model", () => {
    const { scene, host } = makeScene();
    try {
      scene.setLyrics(hangulLyrics());
      expect(scene.lines.map((l) => l.subtitle)).toEqual([null, null]);
      expect(scene.layouts[0]?.subtitle.length).toBe(0);
      const heightBefore = scene.layouts[0]?.height ?? 0;

      scene.setDisplayOptions({ romanization: true });
      expect(scene.lines.map((l) => l.subtitle)).toEqual([
        "annyeonghaseyo",
        "hangukmal",
      ]);
      // The rebuilt model is what gets laid out: the sub-line is
      // placed and the line grows to reserve room for it.
      expect(scene.layouts[0]?.subtitle.length).toBeGreaterThan(0);
      expect(scene.layouts[0]?.height).toBeGreaterThan(heightBefore);

      scene.setDisplayOptions({ romanization: false });
      expect(scene.lines.map((l) => l.subtitle)).toEqual([null, null]);
      expect(scene.layouts[0]?.subtitle.length).toBe(0);
    } finally {
      scene.dispose();
      host.remove();
    }
  });

  it("lyrics arriving after the flip are built with the flag on", () => {
    const { scene, host } = makeScene();
    try {
      scene.setDisplayOptions({ romanization: true });
      scene.setLyrics(hangulLyrics());
      expect(scene.lines[0]?.subtitle).toBe("annyeonghaseyo");
    } finally {
      scene.dispose();
      host.remove();
    }
  });

  it("pushing unchanged options (romanization included) is a no-op", () => {
    const { scene, host } = makeScene();
    try {
      scene.setLyrics(hangulLyrics());
      scene.setDisplayOptions({ romanization: true });
      const version = scene.version;
      scene.setDisplayOptions({ romanization: true });
      scene.setDisplayOptions({});
      expect(scene.version).toBe(version);
      expect(scene.lines[0]?.subtitle).toBe("annyeonghaseyo");
    } finally {
      scene.dispose();
      host.remove();
    }
  });

  it("a partial push without the flag leaves romanization untouched", () => {
    const { scene, host } = makeScene();
    try {
      scene.setLyrics(hangulLyrics());
      scene.setDisplayOptions({ romanization: true });
      scene.setDisplayOptions({ highlight: false });
      expect(scene.display.highlight).toBe(false);
      expect(scene.lines[0]?.subtitle).toBe("annyeonghaseyo");
    } finally {
      scene.dispose();
      host.remove();
    }
  });

  it("align still applies to the rebuilt lines after a flip", () => {
    const { scene, host } = makeScene();
    try {
      scene.setLyrics(hangulLyrics());
      const startX = scene.layouts[0]?.tokens[0]?.x ?? 0;
      scene.setDisplayOptions({ romanization: true, align: "center" });
      const centerX = scene.layouts[0]?.tokens[0]?.x ?? 0;
      expect(centerX).toBeGreaterThan(startX + 50);
      expect(scene.lines[0]?.subtitle).toBe("annyeonghaseyo");
    } finally {
      scene.dispose();
      host.remove();
    }
  });
});
