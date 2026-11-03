import { useEffect, useRef, useState } from "react";
import type { SectionSpan, WaveBar } from "./stageData";

// The deck waveform: section bands behind, per-bar levels in front,
// vocal bars in the accent green, and a bright playhead. Drawn on a
// canvas sized to its container (devicePixelRatio-aware) and
// redrawn whenever the data or position changes. Clicking seeks —
// but only when the parent hands over an onSeek (the playing deck);
// the standby deck's strip is display-only.

interface WaveformStripProps {
  bars: WaveBar[];
  sections: SectionSpan[];
  durationSec: number;
  positionSec: number | null;
  onSeek?: (sec: number) => void;
}

const HEIGHT = 56;
const COLOR_BASE = "rgba(148,140,190,0.85)";
const COLOR_VOCAL = "rgba(63,214,143,0.95)";

export function WaveformStrip({
  bars,
  sections,
  durationSec,
  positionSec,
  onSeek,
}: WaveformStripProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(320);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(Math.max(1, el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr =
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(HEIGHT * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);

    // Section bands: translucent, alternating by index, with drop
    // sections reading stronger in the accent green.
    for (let i = 0; i < sections.length; i += 1) {
      const span = sections[i];
      const x0 = span.startFrac * width;
      const x1 = span.endFrac * width;
      if (x1 <= x0) continue;
      ctx.fillStyle =
        span.kind === "drop"
          ? "rgba(63,214,143,0.20)"
          : i % 2 === 0
            ? "rgba(120,110,180,0.09)"
            : "rgba(120,110,180,0.17)";
      ctx.fillRect(x0, 0, x1 - x0, HEIGHT);
    }

    // Bars: vertical lines centred on the strip's midline.
    if (bars.length > 0 && width > 0) {
      const step = width / bars.length;
      const barWidth = Math.max(1, step * 0.62);
      const mid = HEIGHT / 2;
      for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i];
        const h = Math.max(1, Math.min(1, bar.level) * (HEIGHT - 6));
        ctx.fillStyle = bar.vocal ? COLOR_VOCAL : COLOR_BASE;
        ctx.fillRect(
          i * step + (step - barWidth) / 2,
          mid - h / 2,
          barWidth,
          h,
        );
      }
    }

    // Playhead: a dark underlay so the bright line reads on both
    // themes, then the line itself.
    if (positionSec !== null && durationSec > 0) {
      const x = Math.min(
        width,
        Math.max(0, (positionSec / durationSec) * width),
      );
      ctx.fillStyle = "rgba(36,27,77,0.45)";
      ctx.fillRect(x - 2, 0, 4, HEIGHT);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillRect(x - 0.75, 0, 1.5, HEIGHT);
    }
  }, [bars, sections, durationSec, positionSec, width]);

  const handleClick = onSeek
    ? (event: React.MouseEvent<HTMLCanvasElement>) => {
        if (durationSec <= 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const frac = Math.min(
          1,
          Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)),
        );
        onSeek(frac * durationSec);
      }
    : undefined;

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-md border border-border-primary bg-black/[0.04] dark:bg-white/[0.04]"
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: HEIGHT,
          display: "block",
          cursor: onSeek ? "pointer" : undefined,
        }}
        onClick={handleClick}
      />
    </div>
  );
}
