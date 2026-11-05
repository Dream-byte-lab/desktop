import {
  useEffect,
  useState,
  useRef,
  useCallback,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { motion } from "framer-motion";
import {
  Maximize,
  Repeat,
  RepeatOne,
  Shuffle,
  SkipNext,
  SkipPrevious,
} from "@solar-icons/react";
import {
  PlayerMorphIcon,
  ICON_PLAY,
  ICON_PAUSE,
  ICON_VOLUME_MUTE,
  ICON_VOLUME_LOW,
  ICON_VOLUME_HIGH,
} from "@/features/player/ui/morphPlayerIcons";
import { HeartFill, HeartLine } from "@mingcute/react";
import CoverImage from "@/features/covers/ui/CoverImage";
import { ScrollableText } from "@/shared/ui/ScrollableText";
import { formatPlaybackTime } from "@/features/player/ui/TimelineSlider";
import {
  OVERLAY_FULL_VOLUME_LEVEL,
  toOverlayVolumeGain,
  toOverlayVolumeLevel,
} from "../lib/volumeCurve";
import { useDisableButtonFocus } from "@/features/navigation/hooks/useDisableButtonFocus";
import type {
  OverlayAction,
  OverlaySize,
  OverlayStatePayload,
} from "../contracts";
import {
  clampOverlaySize,
  overlaySizeBand,
  OVERLAY_SIZE_PRESETS,
} from "../lib/overlaySize";

/**
 * Panel densities. One composition at three scales: the default anchor
 * (regular), the large anchor (large — the same layout with air), and a
 * compact squeeze for custom sizes between the anchors, so a hand-dragged
 * window keeps the panel's shape instead of collapsing to another layout.
 */
type PanelDensity = "compact" | "regular" | "large";

interface PanelTokens {
  radius: string;
  coverPct: number;
  padTop: number;
  padRight: number;
  padBottom: number;
  padLeft: number;
  eyebrowClass: string;
  circle: number;
  circleIcon: number;
  titleClass: string;
  artistClass: string;
  disc: number;
  discIcon: number;
  skipButton: number;
  skipIcon: number;
  modeButton: number;
  modeIcon: number;
  pillRoomy: boolean;
}

const PANEL_TOKENS: Record<PanelDensity, PanelTokens> = {
  compact: {
    radius: "rounded-[22px]",
    coverPct: 40,
    padTop: 14,
    padRight: 16,
    padBottom: 14,
    padLeft: 16,
    eyebrowClass: "text-[9.5px]",
    circle: 30,
    circleIcon: 14,
    titleClass:
      "text-[23px] leading-[28px] font-extrabold tracking-tight text-white",
    artistClass: "text-[13px] leading-[17px] font-light text-white/60",
    disc: 48,
    discIcon: 20,
    skipButton: 34,
    skipIcon: 22,
    modeButton: 28,
    modeIcon: 16,
    pillRoomy: false,
  },
  regular: {
    radius: "rounded-[26px]",
    coverPct: 43,
    padTop: 20,
    padRight: 22,
    padBottom: 20,
    padLeft: 22,
    eyebrowClass: "text-[10.5px]",
    circle: 36,
    circleIcon: 16,
    titleClass:
      "text-[30px] leading-[36px] font-extrabold tracking-tight text-white",
    artistClass: "text-[14.5px] leading-[19px] font-light text-white/60",
    disc: 66,
    discIcon: 26,
    skipButton: 42,
    skipIcon: 28,
    modeButton: 32,
    modeIcon: 19,
    pillRoomy: false,
  },
  large: {
    radius: "rounded-[28px]",
    coverPct: 43,
    padTop: 26,
    padRight: 28,
    padBottom: 26,
    padLeft: 28,
    eyebrowClass: "text-[11px]",
    circle: 40,
    circleIcon: 18,
    titleClass:
      "text-[38px] leading-[44px] font-extrabold tracking-tight text-white",
    artistClass: "text-[16px] leading-[21px] font-light text-white/60",
    disc: 82,
    discIcon: 32,
    skipButton: 48,
    skipIcon: 32,
    modeButton: 36,
    modeIcon: 21,
    pillRoomy: true,
  },
};

/** The reference eyebrow's equaliser glyph: four quiet bars in the
 *  artwork tint (or the theme accent when no tint was sampled). */
function EqualiserGlyph({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-end gap-[2px]"
      style={{ height: 11 }}
    >
      {[6, 10, 7, 9].map((height, i) => (
        <span
          key={i}
          className="w-[2.5px] rounded-full"
          style={{ height, background: color }}
        />
      ))}
    </span>
  );
}
import { useArtworkTint } from "../hooks/useArtworkTint";
import { useShortcutsStore, matchesShortcut } from "@/features/shortcuts";
import { isLocalTrackId } from "@/shared/media/local/localTrackIds";

function sampledPositionMs({
  status,
  positionMs,
  positionAt,
  playbackRate,
}: Pick<
  OverlayStatePayload,
  "status" | "positionMs" | "positionAt" | "playbackRate"
>): number {
  if (status !== "playing" || typeof positionAt !== "number") {
    return positionMs;
  }
  const rate = playbackRate && playbackRate > 0 ? playbackRate : 1;
  return positionMs + Math.max(0, Date.now() - positionAt) * rate;
}

const OVERLAY_CARD_TRANSITION = {
  duration: 0.08,
  ease: [0.16, 1, 0.3, 1],
} as const;

const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;

/** The renderer fills its window, so the window size is the layout size. */
function useOverlayWindowSize(): OverlaySize {
  const [size, setSize] = useState<OverlaySize>(() => ({
    width:
      typeof window !== "undefined"
        ? window.innerWidth
        : OVERLAY_SIZE_PRESETS.default.width,
    height:
      typeof window !== "undefined"
        ? window.innerHeight
        : OVERLAY_SIZE_PRESETS.default.height,
  }));

  useEffect(() => {
    const onResize = () =>
      setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return size;
}

/** Gradient for progress/volume fills: artwork-tinted when a tint was
 *  sampled, the theme accent sweep otherwise. */
function fillGradient(tint: string | null): string {
  return tint
    ? `linear-gradient(90deg, ${tint} 0%, color-mix(in srgb, ${tint} 45%, #ffffff) 100%)`
    : "linear-gradient(90deg, var(--accent-primary), var(--accent-secondary))";
}

interface SeekBarProps {
  positionMs: number;
  durationMs: number;
  tint: string | null;
  onSeek: (positionMs: number) => void;
}

function SeekBar({ positionMs, durationMs, tint, onSeek }: SeekBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [scrubRatio, setScrubRatio] = useState<number | null>(null);

  const duration = Math.max(0, durationMs);
  const ratio =
    scrubRatio ??
    (duration > 0 ? Math.min(1, Math.max(0, positionMs / duration)) : 0);
  const displayMs = ratio * duration;
  const isActive = isHovered || scrubRatio !== null;

  const ratioFromPointer = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return ratio;
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    },
    [ratio],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      if (duration <= 0) return;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setScrubRatio(ratioFromPointer(e.clientX));

      const onPointerMove = (ev: PointerEvent) => {
        setScrubRatio(ratioFromPointer(ev.clientX));
      };
      const onPointerUp = (ev: PointerEvent) => {
        const finalRatio = ratioFromPointer(ev.clientX);
        setScrubRatio(null);
        try {
          (e.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
        } catch {}
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        onSeek(Math.round(finalRatio * duration));
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [duration, onSeek, ratioFromPointer],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (duration <= 0) return;
      const current = ratio * duration;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        onSeek(Math.min(duration, current + 5000));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onSeek(Math.max(0, current - 5000));
      } else if (e.key === "Home") {
        e.preventDefault();
        onSeek(0);
      } else if (e.key === "End") {
        e.preventDefault();
        onSeek(duration);
      }
    },
    [duration, onSeek, ratio],
  );

  return (
    <div
      className="flex flex-col gap-[5px] select-none"
      style={NO_DRAG_STYLE}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.round(displayMs)}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        className="relative flex h-[16px] w-full cursor-pointer items-center outline-none"
      >
        <div
          ref={trackRef}
          className="relative h-[4px] w-full overflow-hidden rounded-full bg-white/[0.14]"
          style={{
            transform: `scaleY(${isActive ? 1.5 : 1})`,
            transition: "transform 150ms ease-out",
          }}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${ratio * 100}%`,
              backgroundImage: fillGradient(tint),
              transition:
                scrubRatio !== null
                  ? "none"
                  : "width 200ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          />
        </div>
        {/* The reference's knob rides the end of the fill, always
            visible, in the fill's lightened end colour. */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_1px_5px_rgba(0,0,0,0.5)]"
          style={{
            left: `${ratio * 100}%`,
            background: tint
              ? `color-mix(in srgb, ${tint} 45%, #ffffff)`
              : "var(--accent-secondary)",
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] tabular-nums leading-none text-white/55">
          {formatPlaybackTime(displayMs)}
        </span>
        <span className="text-[11px] tabular-nums leading-none text-white/55">
          {formatPlaybackTime(duration)}
        </span>
      </div>
    </div>
  );
}

interface VolumePillProps {
  /** User gain from the state payload (0..MAX_USER_VOLUME). */
  volume: number;
  tint: string | null;
  roomy?: boolean;
  /** Rendered inside the pill after the slider, behind a hairline —
   *  the reference pill carries its utility icons inside itself. */
  trailing?: ReactNode;
  onSetVolume: (gain: number) => void;
  onToggleMute: () => void;
}

function VolumePill({
  volume,
  tint,
  roomy = false,
  trailing,
  onSetVolume,
  onToggleMute,
}: VolumePillProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [dragLevel, setDragLevel] = useState<number | null>(null);

  const storedLevel = toOverlayVolumeLevel(volume);
  const level = dragLevel ?? storedLevel;
  const gainPercent = Math.round(toOverlayVolumeGain(level) * 100);
  const isActive = isHovered || dragLevel !== null;

  const levelFromPointer = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return level;
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    },
    [level],
  );

  const applyLevel = useCallback(
    (next: number) => {
      const clamped = Math.min(1, Math.max(0, next));
      setDragLevel(clamped);
      onSetVolume(toOverlayVolumeGain(clamped));
    },
    [onSetVolume],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      applyLevel(levelFromPointer(e.clientX));

      const onPointerMove = (ev: PointerEvent) => {
        applyLevel(levelFromPointer(ev.clientX));
      };
      const onPointerUp = (ev: PointerEvent) => {
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
    [applyLevel, levelFromPointer],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.stopPropagation();
      applyLevel(level + (e.deltaY < 0 ? 0.04 : -0.04));
      setDragLevel(null);
    },
    [applyLevel, level],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        onSetVolume(toOverlayVolumeGain(Math.min(1, level + 0.05)));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        onSetVolume(toOverlayVolumeGain(Math.max(0, level - 0.05)));
      } else if (e.key === "Home") {
        e.preventDefault();
        onSetVolume(0);
      } else if (e.key === "End") {
        e.preventDefault();
        onSetVolume(toOverlayVolumeGain(1));
      }
    },
    [level, onSetVolume],
  );

  return (
    <div
      className={`flex items-center gap-2 rounded-full bg-white/[0.06] ring-1 ring-inset ring-white/[0.07] select-none ${
        roomy ? "h-[34px] px-3" : "h-[30px] px-2.5"
      }`}
      style={NO_DRAG_STYLE}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={handleWheel}
    >
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          onToggleMute();
        }}
        className="flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-white/60 outline-none transition-colors hover:text-white active:scale-90"
        aria-label={gainPercent === 0 ? "Unmute" : "Mute"}
      >
        <PlayerMorphIcon
          icon={
            gainPercent === 0
              ? ICON_VOLUME_MUTE
              : gainPercent < 40
                ? ICON_VOLUME_LOW
                : ICON_VOLUME_HIGH
          }
          size={15}
        />
      </button>

      <div
        role="slider"
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={500}
        aria-valuenow={gainPercent}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        className="relative flex h-full flex-1 cursor-pointer items-center outline-none"
      >
        {/* 100% tick: the hairline where gain crosses unity (same mark
            as the main player's volume slider). */}
        <div
          className="pointer-events-none absolute top-1/2 z-10 h-[10px] w-[2px] -translate-y-1/2 bg-white/50"
          style={{ left: `${OVERLAY_FULL_VOLUME_LEVEL * 100}%` }}
          aria-hidden
        />
        <div
          ref={trackRef}
          className="relative h-[4px] w-full overflow-hidden rounded-full bg-white/[0.14]"
          style={{
            transform: `scaleY(${isActive ? 1.5 : 1})`,
            transition: "transform 150ms ease-out",
          }}
        >
          <div
            className="absolute inset-0 origin-left rounded-full"
            style={{
              transform: `scaleX(${level})`,
              backgroundImage: fillGradient(tint),
            }}
          />
        </div>
        {/* The reference slider's round white knob. */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 z-10 h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_5px_rgba(0,0,0,0.5)]"
          style={{ left: `${level * 100}%` }}
        />
      </div>

      {trailing ? (
        <>
          <div aria-hidden className="h-[16px] w-px shrink-0 bg-white/[0.12]" />
          {trailing}
        </>
      ) : null}
    </div>
  );
}

interface ResizeGripProps {
  onResize: (size: OverlaySize, commit: boolean) => void;
}

/**
 * Corner grip for drag-resizing. It sits outside the card's drag-to-move
 * surface (no-drag region, pointer events stopPropagation), so grabbing
 * it never starts a window move. Live sizes stream to electron on rAF;
 * the final size commits on release and persists.
 */
function ResizeGrip({ onResize }: ResizeGripProps) {
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    latest: OverlaySize;
    rafId: number | null;
  } | null>(null);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const start = {
        startX: e.clientX,
        startY: e.clientY,
        startWidth: window.innerWidth,
        startHeight: window.innerHeight,
        latest: clampOverlaySize({
          width: window.innerWidth,
          height: window.innerHeight,
        }),
        rafId: null as number | null,
      };
      dragRef.current = start;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

      const flush = () => {
        if (dragRef.current) {
          dragRef.current.rafId = null;
          onResize(dragRef.current.latest, false);
        }
      };
      const onPointerMove = (ev: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        drag.latest = clampOverlaySize({
          width: drag.startWidth + (ev.clientX - drag.startX),
          height: drag.startHeight + (ev.clientY - drag.startY),
        });
        if (drag.rafId === null) {
          drag.rafId = requestAnimationFrame(flush);
        }
      };
      const onPointerUp = (ev: PointerEvent) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag?.rafId !== null && drag?.rafId !== undefined) {
          cancelAnimationFrame(drag.rafId);
        }
        try {
          (e.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
        } catch {}
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        if (drag) onResize(drag.latest, true);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [onResize],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 28 : 10;
      const current = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      let next: OverlaySize | null = null;
      if (e.key === "ArrowRight")
        next = { ...current, width: current.width + step };
      else if (e.key === "ArrowLeft")
        next = { ...current, width: current.width - step };
      else if (e.key === "ArrowDown")
        next = { ...current, height: current.height + step };
      else if (e.key === "ArrowUp")
        next = { ...current, height: current.height - step };
      if (next) {
        e.preventDefault();
        onResize(clampOverlaySize(next), true);
      }
    },
    [onResize],
  );

  return (
    <button
      type="button"
      aria-label="Resize overlay"
      title="Drag to resize"
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute right-[3px] bottom-[3px] z-30 flex h-[16px] w-[16px] cursor-nwse-resize items-center justify-center rounded-[5px] border-0 bg-transparent text-white/30 opacity-40 outline-none transition-opacity duration-150 group-hover:opacity-100 hover:text-white/70 hover:opacity-100 focus-visible:opacity-100"
      style={NO_DRAG_STYLE}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path
          d="M9 1 L1 9 M9 5 L5 9 M9 9 L9 9"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </button>
  );
}

interface OverlayPlayerProps {
  // Test seam: deterministic band selection without a real window.
  initialWindowSize?: OverlaySize;
}

export function OverlayPlayer({ initialWindowSize }: OverlayPlayerProps = {}) {
  useDisableButtonFocus();

  const [state, setState] = useState<OverlayStatePayload>({
    status: "idle",
    track: null,
    positionMs: 0,
    durationMs: 0,
    volume: 1,
    isLiked: false,
    shuffle: false,
    repeat: "off",
    contextLabel: null,
  });

  const [isInfoHovered, setIsInfoHovered] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [isShown, setIsShown] = useState(
    () => !window.linerElectron?.onOverlayVisibility,
  );

  const anchorPosRef = useRef(state.positionMs);
  const anchorTimeRef = useRef(performance.now());
  const [interpolatedPosMs, setInterpolatedPosMs] = useState(state.positionMs);
  const lastTrackIdRef = useRef<string | null>(null);

  const measuredWindowSize = useOverlayWindowSize();
  const windowSize = initialWindowSize ?? measuredWindowSize;
  const band = overlaySizeBand(windowSize);
  const density: PanelDensity =
    band === "large"
      ? "large"
      : windowSize.height < 330 || windowSize.width < 580
        ? "compact"
        : "regular";
  const panel = PANEL_TOKENS[density];

  const coverSrc = state.track?.coverUrl || state.track?.cover || null;
  const tint = useArtworkTint(coverSrc);

  const pullLatestState = useCallback(() => {
    window.linerElectron?.getOverlayInitialState?.().then((initial) => {
      if (initial) {
        const pos = sampledPositionMs(initial);
        anchorPosRef.current = pos;
        anchorTimeRef.current = performance.now();
        setInterpolatedPosMs(pos);
        setState(initial);
      }
    });
  }, []);

  useEffect(() => {
    pullLatestState();

    if (window.linerElectron?.onOverlayState) {
      const cleanupState = window.linerElectron.onOverlayState((newState) => {
        setState(newState);
      });
      return cleanupState;
    }
  }, [pullLatestState]);

  useEffect(() => {
    const signal = setTimeout(() => window.linerElectron?.overlayReady?.(), 0);
    return () => clearTimeout(signal);
  }, []);

  useEffect(() => {
    if (!window.linerElectron?.onOverlayVisibility) return;
    const cleanupVisibility = window.linerElectron.onOverlayVisibility(
      (visible) => {
        setIsVisible(visible);
        setIsShown(visible);
        if (visible) pullLatestState();
      },
    );
    return cleanupVisibility;
  }, [pullLatestState]);

  const sendAction = useCallback((action: OverlayAction) => {
    window.linerElectron?.sendOverlayAction?.(action);
  }, []);

  const handleResize = useCallback(
    (size: OverlaySize, commit: boolean) => {
      sendAction({
        type: commit ? "resizeOverlayCommit" : "resizeOverlay",
        payload: size,
      });
    },
    [sendAction],
  );

  const isPlaying = state.status === "playing";
  const rate =
    state.playbackRate && state.playbackRate > 0 ? state.playbackRate : 1;
  const durationMs = Math.max(
    1,
    state.durationMs || state.track?.durationMs || 1,
  );

  const interpolatedPosRef = useRef(interpolatedPosMs);
  useEffect(() => {
    interpolatedPosRef.current = interpolatedPosMs;
  }, [interpolatedPosMs]);

  const {
    status: stateStatus,
    positionMs: statePositionMs,
    positionAt: statePositionAt,
    playbackRate: statePlaybackRate,
  } = state;
  const stateTrackId = state.track?.id;

  useEffect(() => {
    const syncedPos = sampledPositionMs({
      status: stateStatus,
      positionMs: statePositionMs,
      positionAt: statePositionAt,
      playbackRate: statePlaybackRate,
    });
    if (stateTrackId !== lastTrackIdRef.current) {
      lastTrackIdRef.current = stateTrackId ?? null;
      setInterpolatedPosMs(syncedPos);
      anchorPosRef.current = syncedPos;
      anchorTimeRef.current = performance.now();
      return;
    }

    if (stateStatus === "paused") {
      const pos = syncedPos > 0 ? syncedPos : interpolatedPosRef.current;
      setInterpolatedPosMs(pos);
      anchorPosRef.current = pos;
      anchorTimeRef.current = performance.now();
      return;
    }

    if (syncedPos > 0 || interpolatedPosRef.current === 0) {
      setInterpolatedPosMs(syncedPos);
      anchorPosRef.current = syncedPos;
      anchorTimeRef.current = performance.now();
    }
  }, [
    statePositionMs,
    statePositionAt,
    stateStatus,
    statePlaybackRate,
    stateTrackId,
  ]);

  useEffect(() => {
    if (!isPlaying || !isShown) return;
    let animId: number;

    const step = () => {
      const elapsed = performance.now() - anchorTimeRef.current;
      const current = Math.min(
        durationMs,
        anchorPosRef.current + elapsed * rate,
      );
      setInterpolatedPosMs(current);
      animId = requestAnimationFrame(step);
    };
    animId = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(animId);
      const elapsed = performance.now() - anchorTimeRef.current;
      anchorPosRef.current = Math.min(
        durationMs,
        anchorPosRef.current + elapsed * rate,
      );
      anchorTimeRef.current = performance.now();
    };
  }, [isPlaying, isShown, durationMs, rate]);

  const currentPosMs = interpolatedPosMs;
  const progressRatio = Math.min(1, Math.max(0, currentPosMs / durationMs));

  // Keyboard Shortcuts (Miniplayer mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const { miniplayer } = useShortcutsStore.getState();

      // Sound up / down shortcuts
      if (matchesShortcut(e, miniplayer.volumeUp)) {
        e.preventDefault();
        sendAction({ type: "volumeUp" });
        return;
      }

      if (matchesShortcut(e, miniplayer.volumeDown)) {
        e.preventDefault();
        sendAction({ type: "volumeDown" });
        return;
      }

      // Switch to main app
      if (matchesShortcut(e, miniplayer.focusMainWindow)) {
        e.preventDefault();
        sendAction({ type: "focusMainWindow" });
        return;
      }

      // Playback toggle
      if (matchesShortcut(e, miniplayer.playPause)) {
        e.preventDefault();
        sendAction({ type: "togglePlay" });
        return;
      }

      // Seek left / right
      if (matchesShortcut(e, miniplayer.seekBackward)) {
        e.preventDefault();
        sendAction({
          type: "seek",
          payload: { positionMs: Math.max(0, currentPosMs - 5000) },
        });
        return;
      }

      if (matchesShortcut(e, miniplayer.seekForward)) {
        e.preventDefault();
        sendAction({
          type: "seek",
          payload: { positionMs: Math.min(durationMs, currentPosMs + 5000) },
        });
        return;
      }

      // Like
      if (matchesShortcut(e, miniplayer.likeTrack)) {
        e.preventDefault();
        if (!isLocalTrackId(stateTrackId)) sendAction({ type: "like" });
        return;
      }

      // Previous
      if (matchesShortcut(e, miniplayer.prevTrack)) {
        e.preventDefault();
        sendAction({ type: "prev" });
        return;
      }

      // Next
      if (matchesShortcut(e, miniplayer.nextTrack)) {
        e.preventDefault();
        sendAction({ type: "next" });
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentPosMs, durationMs, sendAction, state.volume, stateTrackId]);

  const showLike = !isLocalTrackId(state.track?.id);

  const likeButton = (size: number, iconSize: number) =>
    showLike ? (
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          sendAction({ type: "like" });
        }}
        className={`flex shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent transition-colors outline-none active:scale-90 ${
          state.isLiked ? "text-[#ff3b5c]" : "text-white/40 hover:text-white"
        }`}
        style={{ height: size, width: size }}
        aria-label={state.isLiked ? "Unlike" : "Like"}
      >
        {state.isLiked ? (
          <HeartFill size={iconSize} />
        ) : (
          <HeartLine size={iconSize} />
        )}
      </button>
    ) : null;

  const transportCluster = (opts: {
    button: number;
    icon: number;
    play: number;
    playIcon: number;
  }) => (
    <>
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          sendAction({ type: "prev" });
        }}
        className="flex shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-white/60 transition-all outline-none hover:text-white active:scale-90"
        style={{ height: opts.button, width: opts.button }}
        aria-label="Previous"
      >
        <SkipPrevious size={opts.icon} weight="Bold" />
      </button>

      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          sendAction({ type: "togglePlay" });
        }}
        className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-white text-black shadow transition-all duration-150 ease-out hover:scale-105 active:scale-95"
        style={{ height: opts.play, width: opts.play }}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        <span
          className={`flex items-center justify-center transition-transform ${
            isPlaying ? "" : "translate-x-[0.5px]"
          }`}
        >
          <PlayerMorphIcon
            icon={isPlaying ? ICON_PAUSE : ICON_PLAY}
            size={opts.playIcon}
          />
        </span>
      </button>

      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          sendAction({ type: "next" });
        }}
        className="flex shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-white/60 transition-all outline-none hover:text-white active:scale-90"
        style={{ height: opts.button, width: opts.button }}
        aria-label="Next"
      >
        <SkipNext size={opts.icon} weight="Bold" />
      </button>
    </>
  );

  const coverThumb = (px: number, radius: string) => (
    <div
      className={`relative shrink-0 overflow-hidden bg-[#16161a] shadow-[0_4px_14px_rgba(0,0,0,0.45)] ${radius}`}
      style={{ height: px, width: px }}
    >
      {coverSrc ? (
        <CoverImage
          key={coverSrc}
          src={coverSrc}
          alt={state.track?.title || "Artwork"}
          fill
          sizes={`${px}px`}
          priority
          unoptimized
          draggable={false}
          className="object-cover pointer-events-none select-none"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[13px] text-white/30 select-none">
          ♪
        </div>
      )}
    </div>
  );

  const focusButton = (size: number, iconSize: number) => (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        sendAction({ type: "focusMainWindow" });
      }}
      className="flex shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-white/60 transition-colors outline-none hover:text-white active:scale-90"
      style={{ height: size, width: size }}
      aria-label="Open main window"
    >
      <Maximize size={iconSize} weight="Bold" />
    </button>
  );

  // ── Panel building blocks (the reference card's composition) ──

  const accentColor = tint ?? "var(--accent-primary)";

  const glassCircleClass =
    "flex shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.08] shadow-[0_4px_14px_rgba(0,0,0,0.35)] transition-all outline-none hover:bg-white/[0.15] hover:text-white active:scale-90";

  const panelLikeButton = showLike ? (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        sendAction({ type: "like" });
      }}
      className={`${glassCircleClass} ${
        state.isLiked ? "text-[#ff3b5c]" : "text-white/85"
      }`}
      style={{ height: panel.circle, width: panel.circle }}
      aria-label={state.isLiked ? "Unlike" : "Like"}
    >
      {state.isLiked ? (
        <HeartFill size={panel.circleIcon} />
      ) : (
        <HeartLine size={panel.circleIcon} />
      )}
    </button>
  ) : null;

  const panelCloseButton = (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        sendAction({ type: "closeOverlay" });
      }}
      className={`${glassCircleClass} text-white/85`}
      style={{ height: panel.circle, width: panel.circle }}
      aria-label="Close overlay"
    >
      <svg
        width={panel.circleIcon - 2}
        height={panel.circleIcon - 2}
        viewBox="0 0 12 12"
        aria-hidden
      >
        <path
          d="M2 2 L10 10 M10 2 L2 10"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </button>
  );

  /** Shuffle/repeat at the transport's ends, as in the reference:
   *  accent colour with a dot beneath while the mode is on. */
  const modeButton = (opts: {
    label: string;
    active: boolean;
    onClick: () => void;
    children: ReactNode;
  }) => (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        opts.onClick();
      }}
      className="relative flex shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent transition-all outline-none hover:bg-white/[0.07] active:scale-90"
      style={{
        height: panel.modeButton,
        width: panel.modeButton,
        color: opts.active ? accentColor : "rgba(255,255,255,0.45)",
      }}
      aria-label={opts.label}
      aria-pressed={opts.active}
    >
      {opts.children}
      {opts.active && (
        <span
          aria-hidden
          className="absolute bottom-0 left-1/2 h-[4px] w-[4px] -translate-x-1/2 rounded-full"
          style={{ background: accentColor }}
        />
      )}
    </button>
  );

  const panelSkipButton = (direction: "prev" | "next") => (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        sendAction({ type: direction });
      }}
      className="flex shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-white/90 transition-all outline-none hover:text-white active:scale-90"
      style={{ height: panel.skipButton, width: panel.skipButton }}
      aria-label={direction === "prev" ? "Previous" : "Next"}
    >
      {direction === "prev" ? (
        <SkipPrevious size={panel.skipIcon} weight="Bold" />
      ) : (
        <SkipNext size={panel.skipIcon} weight="Bold" />
      )}
    </button>
  );

  const panelPlayDisc = (
    <button
      type="button"
      tabIndex={-1}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        sendAction({ type: "togglePlay" });
      }}
      className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-white text-black transition-all duration-150 ease-out hover:scale-105 active:scale-95"
      style={{
        height: panel.disc,
        width: panel.disc,
        boxShadow: `0 0 38px ${
          tint
            ? `color-mix(in srgb, ${tint} 55%, transparent)`
            : "rgba(255,255,255,0.32)"
        }, 0 10px 28px rgba(0,0,0,0.5)`,
      }}
      aria-label={isPlaying ? "Pause" : "Play"}
    >
      <span
        className={`flex items-center justify-center transition-transform ${
          isPlaying ? "" : "translate-x-[1px]"
        }`}
      >
        <PlayerMorphIcon
          icon={isPlaying ? ICON_PAUSE : ICON_PLAY}
          size={panel.discIcon}
        />
      </span>
    </button>
  );

  return (
    <div
      className="m-0 flex h-screen w-screen flex-col justify-start overflow-hidden border-0 bg-transparent p-2 font-sans antialiased select-none"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      {/* ── Glass overlay card ──
          The frost lives INSIDE the card: the cover itself, blurred and
          saturated, glows through a translucent dark tint. No backdrop
          filter reaches outside the window, so the effect costs one
          static raster per track change on every platform. */}
      <motion.div
        initial={false}
        animate={{
          opacity: isVisible ? 1 : 0,
          scale: isVisible ? 1 : 0.92,
        }}
        transition={OVERLAY_CARD_TRANSITION}
        className={`group relative flex w-full flex-1 flex-col overflow-hidden bg-[#0b0b11]/70 ring-1 ring-inset ${
          band === "micro"
            ? "rounded-[14px] shadow-[0_18px_44px_rgba(0,0,0,0.55),0_2px_10px_rgba(0,0,0,0.45)] ring-white/[0.13]"
            : `${panel.radius} ${
                density === "large"
                  ? "shadow-[0_36px_90px_rgba(0,0,0,0.55),0_6px_20px_rgba(0,0,0,0.38)] ring-white/25"
                  : "shadow-[0_24px_60px_rgba(0,0,0,0.58),0_4px_14px_rgba(0,0,0,0.42)] ring-white/[0.18]"
              }`
        }`}
        style={{
          willChange: "transform, opacity",
          transformOrigin: "center center",
        }}
        onMouseEnter={() => setIsInfoHovered(true)}
        onMouseLeave={() => setIsInfoHovered(false)}
      >
        {/* Artwork glow backdrop (static per track). The panel pushes
            it harder than the old mini card did — more blur, more
            saturation, higher presence — so the cover's colours bleed
            across the whole translucent body, as in the references. */}
        {coverSrc ? (
          <img
            key={coverSrc}
            src={coverSrc}
            alt=""
            aria-hidden
            draggable={false}
            className={`pointer-events-none absolute inset-0 h-full w-full object-cover select-none ${
              band === "micro"
                ? "scale-[1.6] opacity-50 blur-2xl saturate-150"
                : density === "large"
                  ? "scale-[1.85] opacity-[0.65] blur-3xl saturate-[1.75]"
                  : "scale-[1.75] opacity-[0.55] blur-3xl saturate-[1.7]"
            }`}
          />
        ) : (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-25"
            style={{ backgroundImage: "var(--accent-gradient)" }}
          />
        )}
        {/* Legibility tint + top sheen. The panel's tint runs lighter
            than the old card's — the glass reads translucent, not
            smoked — and the large panel lighter still (the spatial
            reference's airy panels). */}
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 bg-gradient-to-b ${
            band === "micro"
              ? "from-[#0a0a12]/55 via-[#0a0a12]/68 to-[#0a0a12]/82"
              : density === "large"
                ? "from-[#0a0a12]/38 via-[#0a0a12]/50 to-[#0a0a12]/66"
                : "from-[#0a0a12]/50 via-[#0a0a12]/62 to-[#0a0a12]/78"
          }`}
        />
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b to-transparent ${
            band !== "micro" && density === "large"
              ? "from-white/[0.14]"
              : "from-white/[0.09]"
          }`}
        />
        {/* Halo bleed: a soft wash of the artwork's own colour pooled
            where the cover panel meets the player column, so the
            cover's edge glows into the glass instead of ending at a
            hard seam. Static per track, like the glow raster. */}
        {band !== "micro" && tint ? (
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-y-[12%] z-[1] w-[150px] blur-3xl"
            style={{
              left: `calc(${panel.coverPct}% - 75px)`,
              background: tint,
              opacity: density === "large" ? 0.36 : 0.3,
            }}
          />
        ) : null}

        {band === "micro" && (
          <>
            <div className="relative z-[2] flex h-full items-center gap-2 px-2.5">
              {coverThumb(36, "rounded-[10px]")}
              <div className="flex min-w-0 flex-1 flex-col justify-center overflow-hidden">
                <ScrollableText
                  text={state.track?.title || "No track playing"}
                  isParentHovered={isInfoHovered}
                  className="text-[13px] leading-[16px] font-normal tracking-tight text-white"
                />
                {windowSize.width >= 300 && (
                  <ScrollableText
                    text={state.track?.artist || ""}
                    isParentHovered={isInfoHovered}
                    className="mt-px text-[10.5px] leading-[13px] font-light text-white/50"
                  />
                )}
              </div>
              <div
                className="flex shrink-0 items-center gap-0.5"
                style={NO_DRAG_STYLE}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {windowSize.width >= 292 && likeButton(24, 14)}
                {transportCluster({
                  button: 24,
                  icon: 14,
                  play: 30,
                  playIcon: 13,
                })}
              </div>
            </div>
            {/* Micro progress: a gradient hairline on the card's bottom
                edge (display-only; seeking lives in the bigger bands
                and in the keyboard shortcuts). */}
            <div
              aria-hidden
              className="absolute inset-x-0 bottom-0 z-[3] h-[3px] bg-white/[0.08]"
            >
              <div
                className="h-full"
                style={{
                  width: `${progressRatio * 100}%`,
                  backgroundImage: fillGradient(tint),
                  transition: "width 200ms cubic-bezier(0.22, 1, 0.36, 1)",
                }}
              />
            </div>
          </>
        )}

        {band !== "micro" && (
          <div className="relative z-[2] flex h-full">
            {/* Cover panel — the reference's left half: the artwork
                itself at full height, flush to the card's edges (the
                card's radius clips its corners), taking its ~43%. */}
            <div
              className="relative h-full shrink-0 overflow-hidden"
              style={{ width: `${panel.coverPct}%` }}
            >
              {coverSrc ? (
                <CoverImage
                  key={coverSrc}
                  src={coverSrc}
                  alt={state.track?.title || "Artwork"}
                  fill
                  sizes="360px"
                  priority
                  unoptimized
                  draggable={false}
                  className="object-cover pointer-events-none select-none"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-white/[0.04] text-[34px] text-white/25 select-none">
                  ♪
                </div>
              )}
              {/* Seat the panel into the glass: a bright hairline and a
                  soft shade along its right edge. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 w-px bg-white/[0.14]"
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 shadow-[inset_-28px_0_36px_-28px_rgba(0,0,0,0.6)]"
              />
            </div>

            {/* Player column */}
            <div
              className="relative flex min-w-0 flex-1 flex-col"
              style={{
                paddingTop: panel.padTop,
                paddingRight: panel.padRight,
                paddingBottom: panel.padBottom,
                paddingLeft: panel.padLeft,
              }}
            >
              {/* Eyebrow + glass-circle actions */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 pt-[4px]">
                  <EqualiserGlyph color={accentColor} />
                  <span
                    className={`truncate font-semibold tracking-[0.14em] text-white/55 uppercase ${panel.eyebrowClass}`}
                  >
                    {state.contextLabel ?? "Now playing"}
                  </span>
                </div>
                <div
                  className="flex shrink-0 items-center gap-2"
                  style={NO_DRAG_STYLE}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {panelLikeButton}
                  {panelCloseButton}
                </div>
              </div>

              <div className="min-h-[2px] flex-1" />

              <div className="flex min-w-0 flex-col overflow-hidden">
                <ScrollableText
                  text={state.track?.title || "No track playing"}
                  isParentHovered={isInfoHovered}
                  className={panel.titleClass}
                />
                <ScrollableText
                  text={state.track?.artist || ""}
                  isParentHovered={isInfoHovered}
                  className={`mt-[2px] ${panel.artistClass}`}
                />
              </div>

              <div className="min-h-[2px] flex-1" />

              <SeekBar
                positionMs={currentPosMs}
                durationMs={durationMs}
                tint={tint}
                onSeek={(positionMs) =>
                  sendAction({ type: "seek", payload: { positionMs } })
                }
              />

              <div className="min-h-[2px] flex-1" />

              {/* Transport: shuffle and repeat at the ends, the big
                  white disc at the centre — the reference's row. */}
              <div
                className="flex items-center justify-between"
                style={NO_DRAG_STYLE}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {modeButton({
                  label: "Shuffle",
                  active: state.shuffle,
                  onClick: () => sendAction({ type: "toggleShuffle" }),
                  children: <Shuffle size={panel.modeIcon} weight="Bold" />,
                })}
                {panelSkipButton("prev")}
                {panelPlayDisc}
                {panelSkipButton("next")}
                {modeButton({
                  label: state.repeat === "one" ? "Repeat one" : "Repeat",
                  active: state.repeat !== "off",
                  onClick: () => sendAction({ type: "cycleRepeat" }),
                  children:
                    state.repeat === "one" ? (
                      <RepeatOne size={panel.modeIcon} weight="Bold" />
                    ) : (
                      <Repeat size={panel.modeIcon} weight="Bold" />
                    ),
                })}
              </div>

              <div className="min-h-[2px] flex-1" />

              <VolumePill
                volume={state.volume}
                tint={tint}
                roomy={panel.pillRoomy}
                trailing={focusButton(26, 14)}
                onSetVolume={(gain) =>
                  sendAction({ type: "setVolume", payload: { volume: gain } })
                }
                onToggleMute={() => sendAction({ type: "toggleMute" })}
              />
            </div>
          </div>
        )}

        <ResizeGrip onResize={handleResize} />
      </motion.div>
    </div>
  );
}

export default OverlayPlayer;
