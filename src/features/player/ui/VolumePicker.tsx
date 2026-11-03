import { useState, useRef, useCallback, useEffect, memo } from "react";
import { motion } from "framer-motion";
import { VolumeCross, VolumeSmall, VolumeLoud } from "@solar-icons/react";
import {
  PlayerMorphIcon,
  ICON_VOLUME_MUTE,
  ICON_VOLUME_LOW,
  ICON_VOLUME_HIGH,
} from "./morphPlayerIcons";
import { usePlayerState } from "../hooks/usePlayerState";
import { playerEngine } from "../engine/playerEngine";
import {
  FULL_VOLUME_LEVEL,
  toVolumeGain,
  toVolumeLevel,
} from "../engine/volume";
import { usePlayerStore } from "../store/playerStore";

export interface VolumePickerProps {
  className?: string;
  showIcon?: boolean;
  showValue?: boolean;
  orientation?: "horizontal" | "vertical";
  size?: "sm" | "md" | "lg";
  trackClassName?: string;
  fillClassName?: string;
  iconClassName?: string;
  iconSize?: number;
  valueClassName?: string;
  trackBg?: string;
  trackActiveBg?: string;
  fillColor?: string;
  onVolumeChange?: (level: number) => void;
  onDraggingChange?: (isDragging: boolean) => void;
}

export const VolumePicker = memo(function VolumePicker({
  className = "",
  showIcon = true,
  showValue = false,
  orientation = "horizontal",
  size = "md",
  trackClassName = "",
  fillClassName = "",
  iconClassName = "",
  iconSize,
  valueClassName = "",
  trackBg,
  trackActiveBg,
  fillColor,
  onVolumeChange,
  onDraggingChange,
}: VolumePickerProps) {
  const isVertical = orientation === "vertical";
  const player = usePlayerState();
  const volumeLevel = toVolumeLevel(player.volume);
  // The engine's PlayerState does not carry boost availability; read it
  // from the store (same pattern as DjModeButton).
  const boostAvailable = usePlayerStore((state) => state.volumeBoostAvailable);
  // Truthful ceiling: without boost the control cannot travel past the
  // 100% mark, so it never promises gain it cannot deliver.
  const ceiling = boostAvailable ? 1 : FULL_VOLUME_LEVEL;

  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragLevel, setDragLevel] = useState<number | null>(null);
  const lastNonZeroVolumeRef = useRef<number>(0.7);

  useEffect(() => {
    onDraggingChange?.(isDragging);
  }, [isDragging, onDraggingChange]);

  const trackRef = useRef<HTMLDivElement>(null);

  const currentLevel =
    isDragging && dragLevel !== null ? dragLevel : volumeLevel;
  // Travel and gain percent are different numbers now: travel (level)
  // drives the fill, gain percent drives the value text, icon and aria.
  const travelPercent = Math.round(currentLevel * 100);
  const gainPercent = Math.round(toVolumeGain(currentLevel) * 100);
  const boosted = gainPercent > 100;

  const updateVolume = useCallback(
    (level: number) => {
      const clamped = Math.min(ceiling, Math.max(0, level));
      const gain = toVolumeGain(clamped);
      playerEngine.setVolume(gain);
      if (clamped > 0) {
        lastNonZeroVolumeRef.current = clamped;
      }
      onVolumeChange?.(clamped);
    },
    [ceiling, onVolumeChange],
  );

  const calculateLevelFromPointer = useCallback(
    (clientX: number, clientY: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return currentLevel;
      if (isVertical) {
        if (rect.height === 0) return currentLevel;
        const ratio = (rect.bottom - clientY) / rect.height;
        return Math.min(ceiling, Math.max(0, ratio));
      }
      if (rect.width === 0) return currentLevel;
      const ratio = (clientX - rect.left) / rect.width;
      return Math.min(ceiling, Math.max(0, ratio));
    },
    [ceiling, currentLevel, isVertical],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

      const nextLevel = calculateLevelFromPointer(e.clientX, e.clientY);
      setDragLevel(nextLevel);
      updateVolume(nextLevel);

      const onPointerMove = (ev: PointerEvent) => {
        const lvl = calculateLevelFromPointer(ev.clientX, ev.clientY);
        setDragLevel(lvl);
        updateVolume(lvl);
      };

      const onPointerUp = (ev: PointerEvent) => {
        setIsDragging(false);
        setDragLevel(null);
        try {
          (e.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
        } catch {}
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [calculateLevelFromPointer, updateVolume],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.04 : -0.04;
      // updateVolume clamps to the ceiling
      updateVolume(currentLevel + delta);
    },
    [currentLevel, updateVolume],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        updateVolume(currentLevel + 0.05);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        updateVolume(currentLevel - 0.05);
      } else if (e.key === "Home") {
        e.preventDefault();
        updateVolume(0);
      } else if (e.key === "End") {
        e.preventDefault();
        updateVolume(ceiling);
      }
    },
    [ceiling, currentLevel, updateVolume],
  );

  const handleToggleMute = useCallback(() => {
    if (volumeLevel > 0) {
      lastNonZeroVolumeRef.current = volumeLevel;
      updateVolume(0);
    } else {
      updateVolume(lastNonZeroVolumeRef.current || 0.7);
    }
  }, [volumeLevel, updateVolume]);

  const containerHeights = {
    sm: "h-[24px]",
    md: "h-[28px]",
    lg: "h-[32px]",
  }[size];

  const baseTrackHeights = {
    sm: "h-[6px]",
    md: "h-[7px]",
    lg: "h-[8px]",
  }[size];

  const iconSizes =
    iconSize ??
    {
      sm: 16,
      md: 18,
      lg: 20,
    }[size];

  const isActive = isHovered || isDragging;

  if (isVertical) {
    return (
      <div
        className={`group relative flex flex-col items-center gap-[6px] w-full select-none prevent-seek ${className}`}
        onWheel={handleWheel}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {showValue && (
          <span
            className={`w-full text-center text-[10px] tabular-nums tracking-tight leading-[12px] ${
              boosted ? "font-semibold" : "font-medium"
            } ${
              !valueClassName
                ? boosted
                  ? "text-accent-primary"
                  : "text-text-tertiary"
                : ""
            } transition-colors ${valueClassName}`}
          >
            {gainPercent}%
          </span>
        )}

        <div
          role="slider"
          aria-label="Volume"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={500}
          aria-valuenow={gainPercent}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          className="relative flex h-[72px] w-full items-center justify-center cursor-pointer outline-none px-1"
        >
          {/* 100% tick: the hairline where gain crosses unity;
              everything above it is boost. */}
          <div
            className="pointer-events-none absolute left-1/2 z-10 h-[2px] w-[14px] -translate-x-1/2 bg-accent-primary/80"
            style={{ bottom: `${FULL_VOLUME_LEVEL * 100}%` }}
            aria-hidden="true"
          />
          <motion.div
            ref={trackRef}
            initial={false}
            animate={{
              scaleX: isActive ? 1.25 : 1,
              ...(trackBg
                ? {
                    backgroundColor: isActive
                      ? trackActiveBg || trackBg
                      : trackBg,
                  }
                : {}),
            }}
            transition={{
              type: "spring",
              stiffness: 400,
              damping: 30,
              mass: 0.8,
            }}
            className={`relative w-[6px] h-full rounded-full overflow-hidden origin-center transition-colors duration-150 ${
              !trackBg
                ? isActive
                  ? "bg-black/[0.18] dark:bg-white/[0.22]"
                  : "bg-fill-hover"
                : ""
            } ${trackClassName}`}
          >
            <div
              className={`absolute inset-x-0 bottom-0 rounded-full ${
                !fillColor && !fillClassName
                  ? "bg-text-primary dark:bg-white"
                  : ""
              } transition-[height] ease-out ${
                isDragging ? "duration-0" : "duration-100"
              } ${fillClassName}`}
              style={{
                height: `${travelPercent}%`,
                ...(fillColor ? { backgroundColor: fillColor } : {}),
              }}
            />
          </motion.div>
        </div>

        {showIcon && (
          <button
            type="button"
            onClick={handleToggleMute}
            aria-label={volumeLevel === 0 ? "Unmute" : "Mute"}
            className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center border-none bg-transparent p-0 ${
              !iconClassName ? "text-text-tertiary hover:text-text-primary" : ""
            } transition-colors duration-150 ease-out cursor-pointer ${iconClassName}`}
          >
            <span className="flex items-center justify-center transition-transform duration-150 ease-out hover:scale-110 active:scale-90">
              {gainPercent === 0 ? (
                <VolumeCross size={15} weight="Outline" />
              ) : gainPercent < 40 ? (
                <VolumeSmall size={15} weight="Outline" />
              ) : (
                <VolumeLoud size={15} weight="Outline" />
              )}
            </span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={`group relative flex ${containerHeights} items-center gap-[10px] select-none prevent-seek ${className}`}
      onWheel={handleWheel}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {showIcon && (
        <button
          type="button"
          onClick={handleToggleMute}
          aria-label={volumeLevel === 0 ? "Unmute" : "Mute"}
          className={`flex h-full min-w-[24px] shrink-0 items-center justify-center border-none bg-transparent p-0 ${
            !iconClassName ? "text-text-secondary hover:text-text-primary" : ""
          } transition-colors duration-150 ease-out cursor-pointer ${iconClassName}`}
        >
          <span className="flex items-center justify-center transition-transform duration-150 ease-out hover:scale-110 active:scale-90">
            <PlayerMorphIcon
              icon={
                gainPercent === 0
                  ? ICON_VOLUME_MUTE
                  : gainPercent < 40
                    ? ICON_VOLUME_LOW
                    : ICON_VOLUME_HIGH
              }
              size={iconSizes}
            />
          </span>
        </button>
      )}

      <div
        role="slider"
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={500}
        aria-valuenow={gainPercent}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        className="relative flex h-full flex-1 items-center cursor-pointer outline-none"
      >
        {/* 100% tick: the hairline where gain crosses unity;
            everything past it is boost. */}
        <div
          className="pointer-events-none absolute top-1/2 z-10 h-[14px] w-[2px] -translate-y-1/2 bg-accent-primary/80"
          style={{ left: `${FULL_VOLUME_LEVEL * 100}%` }}
          aria-hidden="true"
        />
        <motion.div
          ref={trackRef}
          initial={false}
          animate={{
            scaleY: isActive ? (size === "sm" ? 1.35 : 1.3) : 1,
            ...(trackBg
              ? {
                  backgroundColor: isActive
                    ? trackActiveBg || trackBg
                    : trackBg,
                }
              : {}),
          }}
          transition={{
            type: "spring",
            stiffness: 400,
            damping: 30,
            mass: 0.8,
          }}
          className={`relative w-full rounded-full overflow-hidden origin-center transition-colors duration-150 ${baseTrackHeights} ${
            !trackBg
              ? isActive
                ? "bg-black/[0.22] dark:bg-white/[0.28]"
                : "bg-black/[0.12] dark:bg-white/[0.18]"
              : ""
          } ${trackClassName}`}
        >
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${
              !fillColor && !fillClassName ? "bg-text-primary" : ""
            } transition-[width] ease-out ${
              isDragging ? "duration-0" : "duration-100"
            } ${fillClassName}`}
            style={{
              width: `${travelPercent}%`,
              ...(fillColor ? { backgroundColor: fillColor } : {}),
            }}
          />
        </motion.div>
      </div>

      {showValue && (
        <span
          className={`w-[32px] shrink-0 text-right text-caption tabular-nums ${
            boosted ? "font-[600]" : "font-[500]"
          } ${
            !valueClassName
              ? boosted
                ? "text-accent-primary"
                : "text-text-tertiary group-hover:text-text-secondary"
              : ""
          } transition-colors ${valueClassName}`}
        >
          {gainPercent}%
        </span>
      )}
    </div>
  );
});

export default VolumePicker;
