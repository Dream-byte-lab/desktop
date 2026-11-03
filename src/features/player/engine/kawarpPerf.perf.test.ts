// Perf evidence harness (Wave 3, Item 3) — Kawarp fullscreen background.
//
// MEASUREMENT ONLY: assertions are behavioural invariants (frame
// cap, hidden gate, FBO sizes, per-render pass counts) driven by
// virtual rAF timestamps — deterministic, no wall-clock thresholds.
//
// jsdom has no GPU and this fake WebGL context does not rasterise:
// per-render cost is reported as GL call counts and framebuffer
// resolutions (the inputs to GPU cost), never as GPU %.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/covers", () => ({
  getCoverElement: () => undefined,
  useCoverElement: () => undefined,
  loadCoverElement: async () => null,
  prepareCoverFallback: async () => null,
}));

import { KawarpEngine } from "./kawarpEngine";
import { KAWARP_RENDER_SCALE } from "../ui/KawarpWrapper";
import { applyWindowVisibility } from "@/shared/utils/windowVisibility";

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

function pumpFrame(now: number) {
  const callbacks = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of callbacks) cb(now);
}

// ----------------------------------------------------- counting GL

interface GlRecord {
  drawArrays: number;
  useProgram: number;
  viewports: Array<[number, number]>;
  /** [width, height] of every numeric texImage2D (FBO allocations). */
  fboSizes: Array<[number, number]>;
}

function makeFakeGL(record: GlRecord) {
  const gl: Record<string, unknown> = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TRIANGLES: 0x0004,
    FLOAT: 0x1406,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    CLAMP_TO_EDGE: 0x812f,
    LINEAR: 0x2601,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram: () => {},
    getUniformLocation: () => ({}),
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: () => {},
    createTexture: () => ({}),
    bindTexture: () => {},
    texParameteri: () => {},
    deleteTexture: () => {},
    pixelStorei: () => {},
    activeTexture: () => {},
    createFramebuffer: () => ({}),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    deleteFramebuffer: () => {},
    useProgram: () => record.useProgram++,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    uniform1i: () => {},
    uniform1f: () => {},
    uniform2f: () => {},
    uniform3fv: () => {},
    viewport: (_x: number, _y: number, w: number, h: number) => {
      record.viewports.push([w, h]);
    },
    texImage2D: (...args: unknown[]) => {
      // Numeric form (FBO allocation): (target, level, internal, w, h, ...)
      if (typeof args[3] === "number" && typeof args[4] === "number") {
        record.fboSizes.push([args[3], args[4]]);
      }
    },
    drawArrays: () => record.drawArrays++,
    getExtension: () => null,
  };
  return gl;
}

function makeEngine(record: GlRecord, canvasW = 800, canvasH = 600) {
  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const gl = makeFakeGL(record);
  vi.spyOn(canvas, "getContext").mockImplementation(((type: string) =>
    type === "webgl" ? gl : null) as typeof canvas.getContext);
  const engine = new KawarpEngine(canvas, {
    warpIntensity: 1.1,
    blurPasses: 8,
    transitionDuration: 1000,
    animationSpeed: 1.0,
    saturation: 1.3,
    scale: 1.18,
    dithering: 0.008,
  });
  return engine;
}

const fakeImage = {
  complete: true,
  naturalWidth: 500,
  naturalHeight: 500,
} as unknown as HTMLImageElement;

// -------------------------------------------------------------- tests

describe("KawarpEngine (fake WebGL, virtual rAF timestamps)", () => {
  let record: GlRecord;

  beforeEach(() => {
    installRafStub();
    applyWindowVisibility(true);
    record = { drawArrays: 0, useProgram: 0, viewports: [], fboSizes: [] };
  });
  afterEach(() => {
    applyWindowVisibility(true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("allocates fixed 160x160 blur FBOs and a quarter-canvas warp FBO", () => {
    const engine = makeEngine(record, 800, 600);
    console.log(
      `[perf] kawarp FBO allocations for 800x600 canvas: ${JSON.stringify(record.fboSizes)}`,
    );
    // 5 blur-chain FBOs at BLUR_SIZE=160, warp FBO at canvas * 0.25.
    expect(
      record.fboSizes.filter(([w, h]) => w === 160 && h === 160).length,
    ).toBe(5);
    expect(record.fboSizes).toContainEqual([200, 150]);
    engine.dispose();
  });

  it("wrapper render scale halves the window before the engine sees it", () => {
    // Chain for a 1600x1200 window: canvas 800x600 (KAWARP_RENDER_SCALE
    // 0.5) -> warp FBO 200x150 = 1/64 of the window's pixels.
    expect(KAWARP_RENDER_SCALE).toBe(0.5);
    const windowPixels = 1600 * 1200;
    const warpPixels = 200 * 150;
    console.log(
      `[perf] kawarp scale chain: window ${windowPixels}px -> canvas ${800 * 600}px -> warp ${warpPixels}px (${((warpPixels / windowPixels) * 100).toFixed(1)}% of window)`,
    );
    expect(warpPixels / windowPixels).toBeCloseTo(1 / 64, 5);
  });

  it("image load runs the 8-pass blur ONCE per image, not per frame", async () => {
    const engine = makeEngine(record);
    const before = record.drawArrays;
    await engine.loadImage("cover-a", fakeImage);
    const loadDraws = record.drawArrays - before;
    // First image blurs into BOTH album FBOs: 2 x (1 tint + 8 blur + 1 copy).
    console.log(
      `[perf] kawarp first-image load: ${loadDraws} draw calls one-time`,
    );
    expect(loadDraws).toBe(20);
    engine.dispose();
  });

  it("steady state: 30 fps cap under a 60 Hz rAF, 2 passes per render", async () => {
    const engine = makeEngine(record);
    await engine.loadImage("cover-a", fakeImage);
    record.drawArrays = 0;
    record.viewports = [];
    engine.start();
    const base = performance.now();
    for (let i = 1; i <= 60; i++) pumpFrame(base + i * (1000 / 60));
    const renders = record.drawArrays / 2;
    console.log(
      `[perf] kawarp steady state: ${renders} renders / 60 rAF frames (1 s @60Hz), ` +
        `drawArrays=${record.drawArrays}, viewports=${JSON.stringify([...new Set(record.viewports.map((v) => v.join("x")))].sort())}`,
    );
    expect(renders).toBeGreaterThanOrEqual(28);
    expect(renders).toBeLessThanOrEqual(32);
    // Output pass viewport is the (half-scale) canvas; warp pass is quarter of it.
    expect(record.viewports).toContainEqual([800, 600]);
    expect(record.viewports).toContainEqual([200, 150]);
    engine.dispose();
  });

  it("track change: transition renders cost 3 passes until the blend ends", async () => {
    const engine = makeEngine(record);
    await engine.loadImage("cover-a", fakeImage);
    record.drawArrays = 0;
    await engine.loadImage("cover-b", fakeImage);
    const secondLoadDraws = record.drawArrays;
    // Second image: one blur chain (10) into the next FBO.
    expect(secondLoadDraws).toBe(10);
    record.drawArrays = 0;
    engine.start();
    const base = performance.now();
    pumpFrame(base + 40); // first frame past the 30 fps gate, mid-transition
    console.log(
      `[perf] kawarp transitioning render: ${record.drawArrays} draw calls in first frame`,
    );
    expect(record.drawArrays).toBe(3); // blend + warp + output
    engine.dispose();
  });

  it("hidden window: loop stops entirely; visible resumes it", async () => {
    const engine = makeEngine(record);
    await engine.loadImage("cover-a", fakeImage);
    engine.start();
    const base = performance.now();
    for (let i = 1; i <= 10; i++) pumpFrame(base + i * (1000 / 60));
    const drawsBeforeHide = record.drawArrays;
    expect(drawsBeforeHide).toBeGreaterThan(0);

    applyWindowVisibility(false);
    for (let i = 11; i <= 40; i++) pumpFrame(base + i * (1000 / 60));
    console.log(
      `[perf] kawarp hidden: draws before=${drawsBeforeHide} after 30 hidden frames=${record.drawArrays}, queued=${rafQueue.size}`,
    );
    expect(record.drawArrays).toBe(drawsBeforeHide);
    expect(rafQueue.size).toBe(0);

    applyWindowVisibility(true);
    expect(rafQueue.size).toBeGreaterThan(0);
    const resumeBase = performance.now();
    for (let i = 1; i <= 10; i++) pumpFrame(resumeBase + i * (1000 / 60));
    expect(record.drawArrays).toBeGreaterThan(drawsBeforeHide);
    engine.dispose();
  });

  it("no playback gate: the loop renders whenever started (pause is not checked)", async () => {
    // The engine has no playing/paused input at all — started means
    // rendering at 30 fps, including while the song is paused. This
    // test pins that fact so the evidence pack states it honestly.
    const engine = makeEngine(record);
    await engine.loadImage("cover-a", fakeImage);
    record.drawArrays = 0;
    engine.start();
    const base = performance.now();
    for (let i = 1; i <= 60; i++) pumpFrame(base + i * (1000 / 60));
    console.log(
      `[perf] kawarp with no playback-state input: ${record.drawArrays / 2} renders in 1 s`,
    );
    expect(record.drawArrays).toBeGreaterThan(0);
    engine.dispose();
    // After dispose (fullscreen closed -> wrapper unmounts -> dispose)
    // nothing is queued and nothing renders.
    const afterDispose = record.drawArrays;
    for (let i = 61; i <= 90; i++) pumpFrame(base + i * (1000 / 60));
    expect(record.drawArrays).toBe(afterDispose);
    expect(rafQueue.size).toBe(0);
  });
});
