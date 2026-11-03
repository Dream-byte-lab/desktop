import { useRef } from "react";

// A fader in Linerave's skin: a track and a thumb, dragged with
// pointer capture (mouse and Surface touch alike) and fully
// keyboard accessible as a slider — arrow keys step by a fiftieth
// of the range, Home/End jump to the ends. Vertical faders grow
// upward, like the channel trims they drive; the horizontal form is
// the crossfader.

interface FaderProps {
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
  formatValue?: (value: number) => string;
}

export function Fader({
  orientation,
  value,
  min,
  max,
  onChange,
  label,
  formatValue,
}: FaderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const vertical = orientation === "vertical";

  const range = max - min;
  const frac = range > 0 ? Math.min(1, Math.max(0, (value - min) / range)) : 0;
  const display = formatValue
    ? formatValue(value)
    : `${Math.round(value * 10) / 10}`;

  const valueFromPointer = (clientX: number, clientY: number): number => {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    let f: number;
    if (vertical) {
      f = rect.height > 0 ? 1 - (clientY - rect.top) / rect.height : 0;
    } else {
      f = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    }
    const clamped = Math.min(1, Math.max(0, f));
    return min + clamped * range;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    onChange(valueFromPointer(event.clientX, event.clientY));
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    onChange(valueFromPointer(event.clientX, event.clientY));
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
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
      next = value + step;
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      next = value - step;
    } else if (event.key === "Home") {
      next = min;
    } else if (event.key === "End") {
      next = max;
    }
    if (next !== null) {
      event.preventDefault();
      onChange(Math.min(max, Math.max(min, next)));
    }
  };

  return (
    <div
      className={
        vertical
          ? "flex flex-col items-center gap-1"
          : "flex w-full items-center gap-2"
      }
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        {label}
      </span>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuetext={display}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className={
          vertical
            ? "relative h-28 w-8 cursor-pointer rounded-full bg-black/[0.06] outline-none focus-visible:ring-2 dark:bg-white/[0.08]"
            : "relative h-8 min-w-0 flex-1 cursor-pointer rounded-full bg-black/[0.06] outline-none focus-visible:ring-2 dark:bg-white/[0.08]"
        }
        style={{ touchAction: "none" }}
      >
        {/* Rail */}
        <div
          className={
            vertical
              ? "absolute bottom-1 top-1 left-1/2 w-[3px] -translate-x-1/2 rounded bg-border-tertiary"
              : "absolute left-1 right-1 top-1/2 h-[3px] -translate-y-1/2 rounded bg-border-tertiary"
          }
          aria-hidden="true"
        />
        {/* Thumb */}
        <div
          className="absolute h-5 w-5 rounded-full border border-border-tertiary bg-bg-elevated"
          style={{
            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
            ...(vertical
              ? {
                  left: "50%",
                  bottom: `${frac * 100}%`,
                  transform: "translate(-50%, 50%)",
                }
              : {
                  top: "50%",
                  left: `${frac * 100}%`,
                  transform: "translate(-50%, -50%)",
                }),
          }}
          aria-hidden="true"
        />
      </div>
      <span className="min-w-8 text-center text-[11px] tabular-nums text-text-secondary">
        {display}
      </span>
    </div>
  );
}
