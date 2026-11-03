import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { VolumeCross, VolumeLoud, VolumeSmall } from "@solar-icons/react";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib";
import { usePlayerState } from "../hooks/usePlayerState";
import { playerEngine } from "../engine/playerEngine";
import {
  FULL_VOLUME_LEVEL,
  toVolumeGain,
  toVolumeLevel,
} from "../engine/volume";
import { usePlayerStore } from "../store/playerStore";

export interface VolumeColumnProps {
  onDraggingChange?: (dragging: boolean) => void;
}

const WHEEL_STEP = 0.04;
const KEY_STEP = 0.05;
// A level, not a gain: under the boosted map FULL_VOLUME_LEVEL (0.7) is
// exactly 100% gain, so restoring to this level restores unity volume.
const DEFAULT_RESTORE_LEVEL = 0.7;

function VolumeIcon({ percent }: { percent: number }) {
  if (percent === 0) return <VolumeCross size={14} weight="Bold" />;
  if (percent < 40) return <VolumeSmall size={14} weight="Bold" />;
  return <VolumeLoud size={14} weight="Bold" />;
}

export function VolumeColumn({ onDraggingChange }: VolumeColumnProps) {
  const { t } = useTranslation();
  const player = usePlayerState();
  // The engine's PlayerState does not carry boost availability; read it
  // from the store (same pattern as DjModeButton).
  const boostAvailable = usePlayerStore((state) => state.volumeBoostAvailable);
  // Truthful ceiling: without boost the control cannot travel past the
  // 100% mark, so it never promises gain it cannot deliver.
  const ceiling = boostAvailable ? 1 : FULL_VOLUME_LEVEL;
  const clampLevel = (level: number) => Math.min(ceiling, Math.max(0, level));
  const trackRef = useRef<HTMLDivElement>(null);
  const restoreLevelRef = useRef(DEFAULT_RESTORE_LEVEL);
  const [dragLevel, setDragLevel] = useState<number | null>(null);
  const level = dragLevel ?? toVolumeLevel(player.volume);
  // Travel and gain percent are different numbers now: travel (level)
  // drives the fill, gain percent drives the label, icon and aria.
  const fillPercent = Math.round(level * 100);
  const gainPercent = Math.round(
    (dragLevel !== null ? toVolumeGain(dragLevel) : player.volume) * 100,
  );
  const boosted = gainPercent > 100;

  const apply = (next: number) => {
    const clamped = clampLevel(next);
    if (clamped > 0) restoreLevelRef.current = clamped;
    playerEngine.setVolume(toVolumeGain(clamped));
    return clamped;
  };

  const levelAt = (clientY: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return level;
    return clampLevel((rect.bottom - clientY) / rect.height);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragLevel(apply(levelAt(event.clientY)));
    onDraggingChange?.(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragLevel === null) return;
    setDragLevel(apply(levelAt(event.clientY)));
  };

  const handlePointerUp = () => {
    if (dragLevel === null) return;
    setDragLevel(null);
    onDraggingChange?.(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowUp" || event.key === "ArrowRight"
        ? level + KEY_STEP
        : event.key === "ArrowDown" || event.key === "ArrowLeft"
          ? level - KEY_STEP
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? ceiling
              : null;
    if (next === null) return;
    event.preventDefault();
    apply(next);
  };

  const toggleMute = () => apply(level === 0 ? restoreLevelRef.current : 0);

  const label = (
    <span
      className={cn(
        "text-[10px] font-[700] tabular-nums",
        boosted && "text-accent-primary",
      )}
    >
      {gainPercent}%
    </span>
  );

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={t("player.volume") || "Volume"}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={500}
      aria-valuenow={gainPercent}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={(event) =>
        apply(level + (event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP))
      }
      onKeyDown={handleKeyDown}
      className="prevent-seek relative h-[120px] w-[38px] cursor-pointer touch-none select-none overflow-hidden rounded-[7px] bg-black/[0.08] outline-none focus-visible:ring-2 focus-visible:ring-text-primary/30 dark:bg-white/[0.08]"
    >
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 bg-text-primary/85",
          dragLevel === null && "transition-[height] duration-100 ease-out",
        )}
        style={{ height: `${fillPercent}%` }}
      />
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-between py-[6px] text-text-primary">
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggleMute}
          aria-label={
            gainPercent === 0
              ? t("player.unmute") || "Unmute"
              : t("player.mute") || "Mute"
          }
          className="pointer-events-auto flex size-[20px] items-center justify-center rounded-full border-0 bg-transparent p-0 text-inherit"
        >
          <VolumeIcon percent={gainPercent} />
        </button>
        {label}
      </div>
      <div
        className={cn(
          "pointer-events-none absolute inset-0 flex flex-col items-center justify-between py-[6px] text-bg-primary",
          dragLevel === null && "transition-[clip-path] duration-100 ease-out",
        )}
        style={{ clipPath: `inset(${100 - fillPercent}% 0 0 0)` }}
        aria-hidden="true"
      >
        <span className="flex size-[20px] items-center justify-center">
          <VolumeIcon percent={gainPercent} />
        </span>
        {label}
      </div>
      {/* 100% tick: the hairline where gain crosses unity; everything
          above it is boost. */}
      <div
        className="pointer-events-none absolute inset-x-0 h-[2px] bg-accent-primary/80"
        style={{ bottom: `${FULL_VOLUME_LEVEL * 100}%` }}
        aria-hidden="true"
      />
    </div>
  );
}
