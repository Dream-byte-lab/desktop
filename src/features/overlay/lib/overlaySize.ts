import type { OverlaySize } from "../contracts";

/**
 * The overlay's size system. Sizes are whole-window sizes (the renderer
 * fills the window edge to edge, so window size == layout size).
 *
 * Three anchors, chosen in Settings → Overlay or reached by dragging the
 * card's corner grip; any in-between size is "custom" and still maps to
 * one of the three layout bands below.
 */
export const OVERLAY_SIZE_PRESETS = {
  /** Micro strip: at/below the footprint of the original 320x56 pill. */
  small: { width: 320, height: 64 },
  /** The glass mini-player card; the default. */
  default: { width: 368, height: 168 },
  /** Expanded glass panel: player strip on top, roomier body below. */
  large: { width: 480, height: 360 },
} as const satisfies Record<string, OverlaySize>;

export type OverlaySizePreset = keyof typeof OVERLAY_SIZE_PRESETS;

export const OVERLAY_MIN_SIZE: OverlaySize = { width: 280, height: 56 };
export const OVERLAY_MAX_SIZE: OverlaySize = { width: 560, height: 440 };

export function clampOverlaySize(size: OverlaySize): OverlaySize {
  const clamp = (value: number, min: number, max: number) =>
    Math.round(
      Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)),
    );
  return {
    width: clamp(size.width, OVERLAY_MIN_SIZE.width, OVERLAY_MAX_SIZE.width),
    height: clamp(
      size.height,
      OVERLAY_MIN_SIZE.height,
      OVERLAY_MAX_SIZE.height,
    ),
  };
}

export function isOverlaySize(value: unknown): value is OverlaySize {
  if (!value || typeof value !== "object") return false;
  const { width, height } = value as Partial<OverlaySize>;
  return (
    typeof width === "number" &&
    Number.isFinite(width) &&
    typeof height === "number" &&
    Number.isFinite(height)
  );
}

/** The preset a size exactly matches, or "custom" for anything between. */
export function matchOverlaySizePreset(
  size: OverlaySize,
): OverlaySizePreset | "custom" {
  for (const [name, preset] of Object.entries(OVERLAY_SIZE_PRESETS)) {
    if (preset.width === size.width && preset.height === size.height) {
      return name as OverlaySizePreset;
    }
  }
  return "custom";
}

/**
 * Layout bands. A short window is always the micro strip, however wide it
 * is dragged; the expanded panel needs both the width and the height to
 * breathe, anything else gets the default card.
 */
export type OverlaySizeBand = "micro" | "default" | "large";

export function overlaySizeBand(size: OverlaySize): OverlaySizeBand {
  if (size.height < 110) return "micro";
  if (size.width >= 424 && size.height >= 264) return "large";
  return "default";
}
