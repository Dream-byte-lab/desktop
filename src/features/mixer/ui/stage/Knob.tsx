import { useRef } from "react";

// A rotary knob in the Fader idiom: pointer drag with capture and
// full keyboard access as a slider — arrow keys step by a fiftieth
// of the range, Home/End jump to the ends. Dragging is vertical:
// 200 px of movement sweeps the whole range, up to increase. An
// optional detent snaps values that land close to it (2% of the
// range), which is how the EQ knobs find their flat centre.

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
  detentValue?: number;
}

export function Knob({
  label,
  value,
  min,
  max,
  onChange,
  formatValue,
  detentValue,
}: KnobProps) {
  const dragRef = useRef<{ startY: number; startValue: number } | null>(null);

  const range = max - min;
  const clamped = Math.min(max, Math.max(min, value));
  const frac = range > 0 ? (clamped - min) / range : 0;
  const angle = -135 + frac * 270;
  const display = formatValue
    ? formatValue(clamped)
    : `${Math.round(clamped * 10) / 10}`;

  const emit = (raw: number) => {
    let next = Math.min(max, Math.max(min, raw));
    if (
      detentValue !== undefined &&
      Math.abs(next - detentValue) <= range * 0.02
    ) {
      next = detentValue;
    }
    onChange(next);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: event.clientY, startValue: clamped };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture may be unavailable (e.g. synthetic events).
    }
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaPx = drag.startY - event.clientY;
    emit(drag.startValue + (deltaPx / 200) * range);
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be gone.
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = range / 50;
    let next: number | null = null;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      next = clamped + step;
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      next = clamped - step;
    } else if (event.key === "Home") {
      next = min;
    } else if (event.key === "End") {
      next = max;
    }
    if (next !== null) {
      event.preventDefault();
      emit(next);
    }
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        {label}
      </span>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(clamped * 100) / 100}
        aria-valuetext={display}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className="relative h-10 w-10 cursor-pointer rounded-full border border-border-tertiary bg-bg-elevated outline-none focus-visible:ring-2"
        style={{
          touchAction: "none",
          boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
        }}
      >
        {/* Indicator layer, rotated from -135deg (min) to +135deg (max). */}
        <div
          className="absolute inset-0"
          style={{ transform: `rotate(${angle}deg)` }}
          aria-hidden="true"
        >
          <span
            className="absolute left-1/2 top-[3px] h-[11px] w-[2px] -translate-x-1/2 rounded"
            style={{ background: "var(--accent-primary)" }}
          />
        </div>
        <span
          className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border-tertiary"
          aria-hidden="true"
        />
      </div>
      <span className="min-w-8 text-center text-[11px] tabular-nums text-text-secondary">
        {display}
      </span>
    </div>
  );
}
