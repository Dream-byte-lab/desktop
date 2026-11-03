import { useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createHeartbeat } from "../lib/heartbeat";
import { smoothBars, visualizerTaps } from "../lib/visualizerSource";

// The greeting's depth: a live visualizer behind the frost.
//
// It draws only REAL audio — frequency data from the tap
// registry's best live source (see lib/visualizerSource for the
// taps and their honest limits). What moves it is the heartbeat
// (lib/heartbeat): a slow lub-dub swell that idles small and
// regular at rest, and deepens onto the music's own bass pulse
// when something is truly playing. When nothing is live — no
// graph to tap, a DJ set's private context, silence on the
// element — the field rests on the idle beat over a still ridge;
// it never performs motion over nothing.
//
// Performance is Note 1 discipline: one small canvas, DPR capped,
// the rAF loop running only while the greeting is visible, on
// screen, and the document is not hidden — and the component
// unmounts with the greeting, so its cost is bounded by the
// greeting's own few seconds. Under reduced motion there is no
// loop at all: a static sweep gradient stands in for the field.

const BAR_COUNT = 36;
const MAX_DPR = 2;
const BAR_ALPHA = 0.5;
const FIELD_HEIGHT = 0.78;

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

export function GreetingVisualizer({ active }: { active: boolean }) {
  const reduceMotion = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasFailed, setCanvasFailed] = useState(false);

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
    const currentBars = new Float32Array(BAR_COUNT);
    let gradient: CanvasGradient | null = null;
    let raf = 0;
    let running = false;
    let lastTime = 0;
    let inView = true;
    let destroyed = false;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const colors = readSweepColors();
      gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, colors[0]);
      gradient.addColorStop(0.52, colors[1]);
      gradient.addColorStop(1, colors[2]);
    };

    const draw = (now: number) => {
      if (!running) return;
      const dt = lastTime === 0 ? 1 / 60 : (now - lastTime) / 1000;
      lastTime = now;
      const sample = visualizerTaps.sample(BAR_COUNT);
      smoothBars(currentBars, sample.bars, 0.55, 0.86);
      const swell = heartbeat.update(dt, sample.live ? sample.bass : null);

      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      if (gradient) {
        const pitch = width / BAR_COUNT;
        const barWidth = pitch * 0.55;
        const maxHeight = height * FIELD_HEIGHT;
        ctx.globalAlpha = BAR_ALPHA;
        ctx.fillStyle = gradient;
        for (let i = 0; i < BAR_COUNT; i += 1) {
          const barHeight = Math.max(0, maxHeight * currentBars[i] * swell);
          if (barHeight < 0.5) continue;
          const x = i * pitch + (pitch - barWidth) / 2;
          const y = height - barHeight;
          const radius = Math.min(barWidth / 2, barHeight, 6);
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(x, y, barWidth, barHeight, radius);
          } else {
            ctx.rect(x, y, barWidth, barHeight);
          }
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(draw);
    };

    const sync = () => {
      const shouldRun = inView && !document.hidden && !destroyed;
      if (shouldRun && !running) {
        running = true;
        lastTime = 0;
        resize();
        raf = requestAnimationFrame(draw);
      } else if (!shouldRun && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      resize();
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

    resize();
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

  if (reduceMotion || canvasFailed) {
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
