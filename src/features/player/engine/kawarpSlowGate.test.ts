// Kawarp paused slow gate (user ruling, 2026-11-03): while playback
// is paused the wrapper turns the engine's slow gate on and the loop
// renders at ~1 fps instead of the 30 fps cap; on resume it returns
// to full rate. These tests drive the engine with a fake WebGL
// context and virtual rAF timestamps (the kawarpPerf harness pattern)
// and record the warp shader's u_time uniform — the animation clock —
// so the phase behaviour is asserted, not just the render count:
// gated ticks must keep the clock creeping (never frozen, never
// leaping a second per tick), and resume must not jump it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/covers", () => ({
  getCoverElement: () => undefined,
  useCoverElement: () => undefined,
  loadCoverElement: async () => null,
  prepareCoverFallback: async () => null,
}));

import { KAWARP_PAUSED_FRAME_MS, KawarpEngine } from "./kawarpEngine";
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

function pumpFrames(base: number, count: number) {
  for (let i = 1; i <= count; i++) pumpFrame(base + i * (1000 / 60));
}

// ----------------------------------------------------- counting GL

interface GlRecord {
  drawArrays: number;
  /** Every u_time value handed to a shader, in call order. */
  timeValues: number[];
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
    getUniformLocation: (_prog: unknown, name: string) => ({ name }),
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
    useProgram: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    uniform1i: () => {},
    uniform1f: (loc: { name?: string } | null, value: number) => {
      // render() hands the animation clock to the warp and output
      // shaders once each per render, with the same value.
      if (loc?.name === "u_time") record.timeValues.push(value);
    },
    uniform2f: () => {},
    uniform3fv: () => {},
    viewport: () => {},
    texImage2D: () => {},
    drawArrays: () => record.drawArrays++,
    getExtension: () => null,
  };
  return gl;
}

function makeEngine(record: GlRecord) {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 600;
  const gl = makeFakeGL(record);
  vi.spyOn(canvas, "getContext").mockImplementation(((type: string) =>
    type === "webgl" ? gl : null) as typeof canvas.getContext);
  return new KawarpEngine(canvas, {
    warpIntensity: 1.1,
    blurPasses: 8,
    transitionDuration: 1000,
    animationSpeed: 1.0,
    saturation: 1.3,
    scale: 1.18,
    dithering: 0.008,
  });
}

const fakeImage = {
  complete: true,
  naturalWidth: 500,
  naturalHeight: 500,
} as unknown as HTMLImageElement;

/** Animation-clock value at each render (u_time is set twice per render). */
function renderTimes(record: GlRecord): number[] {
  const times: number[] = [];
  for (let i = 0; i + 1 < record.timeValues.length; i += 2) {
    times.push(record.timeValues[i]);
  }
  return times;
}

// -------------------------------------------------------------- tests

describe("KawarpEngine slow gate", () => {
  let record: GlRecord;

  beforeEach(() => {
    installRafStub();
    applyWindowVisibility(true);
    record = { drawArrays: 0, timeValues: [] };
  });
  afterEach(() => {
    applyWindowVisibility(true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exports a one-second paused frame interval", () => {
    expect(KAWARP_PAUSED_FRAME_MS).toBe(1000);
  });

  it("gate untouched: renders at the 30 fps cap, clock tracks real time", async () => {
    const engine = makeEngine(record);
    await engine.loadImage("cover-a", fakeImage);
    record.drawArrays = 0;
    engine.start();
    const base = performance.now();
    pumpFrames(base, 60); // 1 virtual second at 60 Hz
    const renders = record.drawArrays / 2;
    expect(renders).toBeGreaterThanOrEqual(28);
    expect(renders).toBeLessThanOrEqual(32);
    const times = renderTimes(record);
    // Clock advanced ~1 s over the virtual second.
    expect(times[times.length - 1]).toBeGreaterThan(0.9);
    expect(times[times.length - 1]).toBeLessThan(1.1);
    engine.dispose();
  });

  it("gated: ~1 fps cadence, and the clock creeps instead of freezing or leaping", async () => {
    const engine = makeEngine(record);
    await engine.loadImage("cover-a", fakeImage);
    record.drawArrays = 0;
    engine.start();
    engine.setSlowGate(true);
    const base = performance.now();
    pumpFrames(base, 300); // 5 virtual seconds
    const renders = record.drawArrays / 2;
    // ~1 fps: a handful of renders, not ~150, and not zero.
    expect(renders).toBeGreaterThanOrEqual(3);
    expect(renders).toBeLessThanOrEqual(6);
    const times = renderTimes(record);
    expect(times.length).toBe(renders);
    // Creeping: the clock advanced, but by ~one frame step per tick —
    // a small fraction of the 5 s the gate was on, not the full 5 s
    // (wall-clock leaps) and not 0 (a hard freeze).
    const advanced = times[times.length - 1];
    expect(advanced).toBeGreaterThan(0.05);
    expect(advanced).toBeLessThan(0.35);
    engine.dispose();
  });

  it("gate set before start applies from the first frame", async () => {
    const engine = makeEngine(record);
    await engine.loadImage("cover-a", fakeImage);
    record.drawArrays = 0;
    engine.setSlowGate(true);
    engine.start();
    const base = performance.now();
    pumpFrames(base, 180); // 3 virtual seconds
    const renders = record.drawArrays / 2;
    expect(renders).toBeGreaterThanOrEqual(2);
    expect(renders).toBeLessThanOrEqual(4);
    engine.dispose();
  });

  it("resume: full rate restored and the clock continues without a jump", async () => {
    const engine = makeEngine(record);
    await engine.loadImage("cover-a", fakeImage);
    record.drawArrays = 0;
    engine.start();
    engine.setSlowGate(true);
    const gatedBase = performance.now();
    pumpFrames(gatedBase, 120); // 2 virtual seconds gated
    const gatedTimes = renderTimes(record);
    expect(gatedTimes.length).toBeGreaterThanOrEqual(1);
    const clockAtResume = gatedTimes[gatedTimes.length - 1];

    engine.setSlowGate(false);
    record.drawArrays = 0;
    record.timeValues = [];
    const resumeBase = performance.now();
    pumpFrames(resumeBase, 60); // 1 virtual second at full rate
    const renders = record.drawArrays / 2;
    expect(renders).toBeGreaterThanOrEqual(28);
    expect(renders).toBeLessThanOrEqual(32);
    const times = renderTimes(record);
    // No jump: the first resumed frame steps the clock by about one
    // frame's worth from where the gate left it, not by the paused
    // duration or a whole second.
    expect(times[0] - clockAtResume).toBeGreaterThan(0);
    expect(times[0] - clockAtResume).toBeLessThan(0.06);
    // And it then advances at full speed again.
    expect(times[times.length - 1] - clockAtResume).toBeGreaterThan(0.9);
    expect(times[times.length - 1] - clockAtResume).toBeLessThan(1.1);
    engine.dispose();
  });

  it("track change while gated: the new cover is presented within the slow cadence", async () => {
    const engine = makeEngine(record);
    await engine.loadImage("cover-a", fakeImage);
    engine.start();
    engine.setSlowGate(true);
    await engine.loadImage("cover-b", fakeImage);
    record.drawArrays = 0;
    const base = performance.now();
    let firstRenderAt: number | null = null;
    let lastRenderDraws = 0;
    let renders = 0;
    for (let i = 1; i <= 180; i++) {
      const ts = base + i * (1000 / 60);
      const before = record.drawArrays;
      pumpFrame(ts);
      const draws = record.drawArrays - before;
      if (draws > 0) {
        renders++;
        lastRenderDraws = draws;
        if (firstRenderAt === null) firstRenderAt = ts;
      }
    }
    // The first gated tick lands within ~one cadence of the change...
    expect(firstRenderAt).not.toBeNull();
    expect(firstRenderAt! - base).toBeLessThanOrEqual(1250);
    expect(renders).toBeGreaterThanOrEqual(2);
    // ...and by the end of the window the 1 s blend has completed:
    // a settled render costs 2 passes (warp + output), a still-
    // blending one costs 3 — so the new cover is fully on screen,
    // without waiting for playback to resume.
    expect(lastRenderDraws).toBe(2);
    engine.dispose();
  });

  it("hidden window still stops the gated loop entirely; visible resumes it", async () => {
    const engine = makeEngine(record);
    await engine.loadImage("cover-a", fakeImage);
    engine.start();
    engine.setSlowGate(true);
    record.drawArrays = 0;
    const base = performance.now();
    pumpFrames(base, 60);
    const drawsBeforeHide = record.drawArrays;
    expect(drawsBeforeHide).toBeGreaterThan(0);

    applyWindowVisibility(false);
    pumpFrames(base + 1000, 120);
    expect(record.drawArrays).toBe(drawsBeforeHide);
    expect(rafQueue.size).toBe(0);

    applyWindowVisibility(true);
    expect(rafQueue.size).toBeGreaterThan(0);
    const resumeBase = performance.now();
    pumpFrames(resumeBase, 120); // 2 virtual seconds, still gated
    expect(record.drawArrays).toBeGreaterThan(drawsBeforeHide);
    engine.dispose();
  });
});
