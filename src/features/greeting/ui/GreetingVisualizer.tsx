import { useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createHeartbeat, HEARTBEAT } from "../lib/heartbeat";
import { smoothBars, visualizerTaps } from "../lib/visualizerSource";
import {
  createWavelineFlow,
  WAVELINE_LAYERS,
  WAVELINE_POINTS,
  wavelinePointFractions,
  wavelineRestingSwell,
  type WavelineLayer,
} from "../lib/wavelines";

// The greeting's depth: flowing wavelines behind the frost
// (standing Ruling 4 — the blurred background carries wavelines,
// not bars).
//
// The lines draw only REAL audio — the tap registry's best live
// sample (see lib/visualizerSource for the taps and their honest
// limits) shapes them, and the heartbeat (lib/heartbeat) breathes
// them: a slow lub-dub swell that idles small and regular at
// rest, and deepens onto the music's own bass pulse when
// something is truly playing. When nothing is live — no graph
// to tap, a DJ set's private context, silence on the element —
// the field rests on the idle beat over the still ridge; it
// never performs motion over nothing. The line model itself
// (layers, ripple, flow) is lib/wavelines.
//
// Performance is Note 1 discipline: one small canvas, DPR
// capped, the rAF loop running only while the greeting is
// visible, on screen, and the document is not hidden — and the
// component unmounts with the greeting, so its cost is bounded
// by the greeting's own few seconds. Under reduced motion there
// is no loop at all: one static frame of the same lines, caught
// at the resting pulse, redrawn only when the canvas resizes.

const MAX_DPR = 2;

const FALLBACK_SWEEP = ["#8fe63e", "#3fd68f", "#2fd6a3"];

function readSweepColors(): string[] {
  try {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => {
      const value = styles.getPropertyValue(name).trim();
      return value || fallback;
    };
    return [
      read("--sweep-lime", FALLBACK_SWEEP[0]),
      read("--sweep-spring", FALLBACK_SWEEP[1]),
      read("--sweep-teal", FALLBACK_SWEEP[2]),
    ];
  } catch {
    return FALLBACK_SWEEP;
  }
}

function buildGradient(
  ctx: CanvasRenderingContext2D,
  width: number,
): CanvasGradient {
  const colors = readSweepColors();
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(0.52, colors[1]);
  gradient.addColorStop(1, colors[2]);
  return gradient;
}

/**
 * Stroke one layer: a smooth curve THROUGH the points, never a
 * jagged polyline — each segment is a quadratic whose control
 * point is a sample and whose end is the midpoint to the next,
 * so the line bends continuously from point to point. A wide,
 * faint pass under the main pass gives the line its glow; the
 * frost above does the rest.
 */
function strokeLayer(
  ctx: CanvasRenderingContext2D,
  ys: Float32Array,
  width: number,
  height: number,
  scale: number,
  layer: WavelineLayer,
  style: CanvasGradient,
  alphaScale: number,
) {
  const count = ys.length;
  if (count < 2) return;
  const xAt = (i: number) => (i / (count - 1)) * width;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(xAt(0), ys[0] * height);
    for (let i = 1; i < count - 1; i += 1) {
      const midX = (xAt(i) + xAt(i + 1)) / 2;
      const midY = ((ys[i] + ys[i + 1]) / 2) * height;
      ctx.quadraticCurveTo(xAt(i), ys[i] * height, midX, midY);
    }
    ctx.lineTo(xAt(count - 1), ys[count - 1] * height);
  };
  ctx.strokeStyle = style;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.globalAlpha = layer.alpha * 0.3 * alphaScale;
  ctx.lineWidth = layer.lineWidth * scale * 2.75;
  trace();
  ctx.stroke();
  ctx.globalAlpha = layer.alpha * alphaScale;
  ctx.lineWidth = layer.lineWidth * scale;
  trace();
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Paint every layer, back to front, for one frame or one still. */
function paintField(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scale: number,
  gradient: CanvasGradient,
  profile: ArrayLike<number>,
  swell: number,
  phases: readonly number[],
  alphaScale: number,
) {
  ctx.clearRect(0, 0, width, height);
  const ys = new Float32Array(WAVELINE_POINTS);
  for (let i = 0; i < WAVELINE_LAYERS.length; i += 1) {
    const layer = WAVELINE_LAYERS[i];
    wavelinePointFractions(i, profile, swell, phases[i], ys);
    strokeLayer(ctx, ys, width, height, scale, layer, gradient, alphaScale);
  }
}

/** Size the canvas to its box (DPR capped); returns device size + scale. */
function layoutCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, scale: width / Math.max(1, canvas.clientWidth) };
}

export function GreetingVisualizer({ active }: { active: boolean }) {
  const reduceMotion = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasFailed, setCanvasFailed] = useState(false);

  // The animated field.
  useEffect(() => {
    if (reduceMotion || !active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCanvasFailed(true);
      return;
    }

    const heartbeat = createHeartbeat();
    const flow = createWavelineFlow();
    const profile = new Float32Array(WAVELINE_POINTS);
    let gradient: CanvasGradient | null = null;
    let scale = 1;
    let raf = 0;
    let running = false;
    let lastTime = 0;
    let elapsed = 0;
    let inView = true;
    let destroyed = false;

    const layout = () => {
      const sized = layoutCanvas(canvas);
      scale = sized.scale;
      gradient = buildGradient(ctx, sized.width);
    };

    const draw = (now: number) => {
      if (!running) return;
      const dt = lastTime === 0 ? 1 / 60 : (now - lastTime) / 1000;
      lastTime = now;
      elapsed += dt;
      const sample = visualizerTaps.sample(WAVELINE_POINTS);
      smoothBars(profile, sample.bars, 0.55, 0.86);
      const swell = heartbeat.update(dt, sample.live ? sample.bass : null);
      const phases = flow.update(dt, swell);
      // The lines emerge with the swell's own mount fade (the
      // heartbeat's FADE_IN smoothstep, mirrored onto alpha) —
      // they gain their shape as they gain their presence,
      // instead of appearing as straight wires that start moving.
      const fade = Math.min(1, elapsed / HEARTBEAT.FADE_IN_SEC);
      const alphaScale = fade * fade * (3 - 2 * fade);
      if (gradient) {
        paintField(
          ctx,
          canvas.width,
          canvas.height,
          scale,
          gradient,
          profile,
          swell,
          phases,
          alphaScale,
        );
      }
      raf = requestAnimationFrame(draw);
    };

    const sync = () => {
      const shouldRun = inView && !document.hidden && !destroyed;
      if (shouldRun && !running) {
        running = true;
        lastTime = 0;
        layout();
        raf = requestAnimationFrame(draw);
      } else if (!shouldRun && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      layout();
    });
    resizeObserver.observe(canvas);
    const intersection = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? true;
        sync();
      },
      { threshold: 0.05 },
    );
    intersection.observe(canvas);
    const onVisibility = () => sync();
    document.addEventListener("visibilitychange", onVisibility);

    layout();
    sync();

    return () => {
      destroyed = true;
      running = false;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      // No source to dispose: the registry is shared and its
      // taps own their own lifecycles (the player-graph tap
      // reconciles its connection the next time it is consulted).
    };
  }, [active, reduceMotion]);

  // The reduced-motion still: the same lines, drawn once at the
  // resting pulse — a frozen breath of the idle field, not a
  // different design. Redrawn only when the canvas resizes;
  // there is no loop and nothing advances.
  useEffect(() => {
    if (!reduceMotion || !active || canvasFailed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCanvasFailed(true);
      return;
    }

    const paint = () => {
      const { width, height, scale } = layoutCanvas(canvas);
      const gradient = buildGradient(ctx, width);
      const sample = visualizerTaps.sample(WAVELINE_POINTS);
      const phases = WAVELINE_LAYERS.map((layer) => layer.phaseStart);
      paintField(
        ctx,
        width,
        height,
        scale,
        gradient,
        sample.bars,
        wavelineRestingSwell(),
        phases,
        1,
      );
    };

    paint();
    const resizeObserver = new ResizeObserver(() => {
      paint();
    });
    resizeObserver.observe(canvas);
    return () => {
      resizeObserver.disconnect();
    };
  }, [active, reduceMotion, canvasFailed]);

  if (canvasFailed) {
    // The design holds with the atmosphere off: a still sweep
    // gradient under the same frost, no motion at all.
    return (
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: "var(--accent-gradient)", opacity: 0.3 }}
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="absolute inset-0 h-full w-full"
    />
  );
}
