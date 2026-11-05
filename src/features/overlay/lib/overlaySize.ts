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
  /**
   * The glass player panel (the reference card's composition): a
   * full-height cover panel on the left, the player column on the right.
   * 600x344 leaves a 584x328 visible card inside the shadow margin —
   * wide enough for the cover to take its ~43% and the transport row
   * to breathe, small enough to live over other apps.
   */
  default: { width: 600, height: 344 },
  /** The same panel with air: roomier spacing, deeper translucency. */
  large: { width: 760, height: 456 },
} as const satisfies Record<string, OverlaySize>;

export type OverlaySizePreset = keyof typeof OVERLAY_SIZE_PRESETS;

/**
 * The pre-panel default anchor (368x168). A persisted size matching it
 * exactly is treated as "the old default", not a deliberate custom
 * choice, and migrates to the new default — the old mini card's bones
 * are gone, and 368x168 would otherwise fall into the micro band.
 */
export const LEGACY_DEFAULT_OVERLAY_SIZE: OverlaySize = {
  width: 368,
  height: 168,
};

export function isLegacyDefaultOverlaySize(size: OverlaySize): boolean {
  return (
    size.width === LEGACY_DEFAULT_OVERLAY_SIZE.width &&
    size.height === LEGACY_DEFAULT_OVERLAY_SIZE.height
  );
}

export const OVERLAY_MIN_SIZE: OverlaySize = { width: 280, height: 56 };
export const OVERLAY_MAX_SIZE: OverlaySize = { width: 820, height: 520 };

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
 * Layout bands. The panel composition needs real height — below the
 * floor a window is always the micro strip, however wide it is dragged;
 * the large panel needs both the width and the height to breathe;
 * everything else gets the default panel.
 */
export type OverlaySizeBand = "micro" | "default" | "large";

export function overlaySizeBand(size: OverlaySize): OverlaySizeBand {
  if (size.height < 244) return "micro";
  if (size.width >= 700 && size.height >= 392) return "large";
  return "default";
}
