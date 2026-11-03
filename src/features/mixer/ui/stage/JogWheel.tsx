import { useRef } from "react";

// The stage jog wheel: a circular platter in Linerave's own skin.
// The marker rotates at 33rpm vinyl speed — one revolution per
// 1.8 s of track time — so the wheel reads as a record, not a
// spinner. On the playing deck it is a real control: dragging it
// nudges the playhead (the parent owns the seek; this component
// only reports incremental drag deltas). On the standby deck it is
// a display, announced as an image with the deck's state.

interface JogWheelProps {
  positionSec: number;
  durationSec: number;
  playing: boolean;
  bpm: number | null;
  keyLabel: string | null;
  interactive: boolean;
  onNudge?: (deltaSec: number) => void;
  size?: number;
}

function formatTime(totalSec: number): string {
  const safe = Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function JogWheel({
  positionSec,
  durationSec,
  playing,
  bpm,
  keyLabel,
  interactive,
  onNudge,
  size = 148,
}: JogWheelProps) {
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const canDrag = interactive && !!onNudge;

  // 33rpm: a revolution every 1.8 seconds of track time.
  const angle = ((positionSec / 1.8) * 360) % 360;

  const description = `Jog wheel, ${playing ? "playing" : "not playing"}, at ${formatTime(positionSec)} of ${formatTime(durationSec)}${bpm !== null ? `, ${bpm.toFixed(1)} BPM` : ""}${keyLabel ? `, key ${keyLabel}` : ""}`;

  const dragHandlers = canDrag
    ? {
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          lastPointRef.current = { x: event.clientX, y: event.clientY };
        },
        onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
          const last = lastPointRef.current;
          if (!last) return;
          const dx = event.clientX - last.x;
          const dy = event.clientY - last.y;
          lastPointRef.current = { x: event.clientX, y: event.clientY };
          // Horizontal drag forward and vertical drag up both move
          // the music forward; 0.01 s per pixel keeps a full wheel
          // sweep a fine adjustment rather than a teleport.
          const delta = (dx - dy) * 0.01;
          if (delta !== 0) onNudge?.(delta);
        },
        onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
          lastPointRef.current = null;
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {
            // Capture may already be gone (pointer cancelled).
          }
        },
        onPointerCancel: () => {
          lastPointRef.current = null;
        },
      }
    : {};

  return (
    <div
      className="relative shrink-0 select-none rounded-full border border-border-tertiary bg-bg-elevated"
      style={{
        width: size,
        height: size,
        touchAction: canDrag ? "none" : undefined,
        cursor: canDrag ? "grab" : undefined,
        boxShadow: "inset 0 2px 10px rgba(0,0,0,0.18)",
      }}
      role={canDrag ? undefined : "img"}
      aria-label={canDrag ? undefined : description}
      {...dragHandlers}
    >
      {/* The rotating platter: marker dot on the rim, groove ring. */}
      <div
        className="absolute rounded-full border border-border-secondary"
        style={{
          inset: 6,
          transform: `rotate(${angle}deg)`,
        }}
        aria-hidden="true"
      >
        <span
          className="absolute left-1/2 top-[4px] h-2.5 w-2.5 -translate-x-1/2 rounded-full"
          style={{ background: "var(--accent-primary)" }}
        />
        <span className="absolute inset-[12px] rounded-full border border-border-primary" />
        <span className="absolute inset-[22px] rounded-full border border-border-primary" />
      </div>

      {/* Centre readout — deliberately outside the rotating layer. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-base font-bold tabular-nums text-text-primary">
          {bpm !== null ? bpm.toFixed(1) : "—"}
        </span>
        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-text-secondary">
          BPM
        </span>
        {keyLabel ? (
          <span
            className="text-[10px] font-semibold"
            style={{ color: "var(--accent-secondary)" }}
          >
            {keyLabel}
          </span>
        ) : null}
        <span className="text-[11px] tabular-nums text-text-secondary">
          {formatTime(positionSec)}
        </span>
      </div>

      {playing ? (
        <span
          className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--accent-primary)" }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
