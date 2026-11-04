// Kawarp paused slow gate, wrapper half (user ruling, 2026-11-03):
// the wrapper reads the player store's status and turns the engine's
// slow gate on exactly while playback is paused — including when the
// fullscreen player is opened on an already-paused track — and off
// again on resume. The engine double here includes setSlowGate; the
// pre-existing KawarpWrapper suite's double predates it, which is
// why the wrapper applies the gate through an optional call.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  resize: vi.fn(),
  start: vi.fn(),
  dispose: vi.fn(),
  loadImage: vi.fn(async () => {}),
  setSlowGate: vi.fn(),
}));

vi.mock("../engine/kawarpEngine", () => ({
  KawarpEngine: vi.fn(function KawarpEngine() {
    return engine;
  }),
}));
vi.mock("@/features/covers", () => ({
  getCoverElement: () => undefined,
  useCoverElement: () => undefined,
}));

import { KawarpWrapper } from "./KawarpWrapper";
import { usePlayerStore } from "../store/playerStore";

/** Make the wrapper's WebGL probe see a hardware renderer. */
function stubHardwareWebGL() {
  const debugInfo = { UNMASKED_RENDERER_WEBGL: 0x9246 };
  const gl = {
    getExtension: (name: string) =>
      name === "WEBGL_debug_renderer_info" ? debugInfo : null,
    getParameter: (param: number) =>
      param === debugInfo.UNMASKED_RENDERER_WEBGL
        ? "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11)"
        : "WebGL 1.0",
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
    type: string,
  ) =>
    type === "webgl" || type === "experimental-webgl"
      ? gl
      : null) as typeof HTMLCanvasElement.prototype.getContext);
}

function setStatus(status: "idle" | "loading" | "playing" | "paused") {
  act(() => {
    usePlayerStore.setState({ status });
  });
}

describe("KawarpWrapper slow gate", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          width: 800,
          height: 600,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 800,
          bottom: 600,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    usePlayerStore.setState({ status: "idle" });
    engine.resize.mockClear();
    engine.start.mockClear();
    engine.dispose.mockClear();
    engine.loadImage.mockClear();
    engine.setSlowGate.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    usePlayerStore.setState({ status: "idle" });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gates on pause and releases on resume", () => {
    stubHardwareWebGL();
    setStatus("playing");
    act(() => root.render(<KawarpWrapper />));
    expect(engine.start).toHaveBeenCalledTimes(1);
    engine.setSlowGate.mockClear();

    setStatus("paused");
    expect(engine.setSlowGate).toHaveBeenCalledTimes(1);
    expect(engine.setSlowGate).toHaveBeenLastCalledWith(true);

    setStatus("playing");
    expect(engine.setSlowGate).toHaveBeenCalledTimes(2);
    expect(engine.setSlowGate).toHaveBeenLastCalledWith(false);
  });

  it("starts gated when opened on an already-paused track", () => {
    stubHardwareWebGL();
    setStatus("paused");
    act(() => root.render(<KawarpWrapper />));
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(engine.setSlowGate).toHaveBeenCalledWith(true);
    expect(engine.setSlowGate).not.toHaveBeenCalledWith(false);
  });

  it("stays ungated for non-paused statuses", () => {
    stubHardwareWebGL();
    setStatus("loading");
    act(() => root.render(<KawarpWrapper />));
    engine.setSlowGate.mockClear();

    setStatus("idle");
    setStatus("loading");
    expect(engine.setSlowGate).not.toHaveBeenCalledWith(true);
  });
});
