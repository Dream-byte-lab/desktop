/**
 * The user-volume curve (gain 0..5 ↔ slider level 0..1), mirrored from
 * src/features/player/engine/volume.ts.
 *
 * The overlay window's bundle is deliberately forbidden from importing
 * features/player/engine (see src/app/overlayImportGraph.test.ts — the
 * mini player must stay light enough to live over other apps), so this
 * small pure curve is duplicated here. The engine remains the authority:
 * every setVolume the overlay sends is applied and clamped by
 * playerEngine with the real curve. If the curve in the engine ever
 * changes, change this mirror too — volumeCurve.test.ts pins the anchor
 * points so drift is visible.
 */
export const OVERLAY_MAX_USER_VOLUME = 5;
export const OVERLAY_FULL_VOLUME_LEVEL = 0.7;

const VOLUME_CURVE = 2;
const BOOST_CURVE = 1.5;

function clampLevel(level: number): number {
  return Math.min(1, Math.max(0, level));
}

function clampGain(gain: number): number {
  return Math.min(OVERLAY_MAX_USER_VOLUME, Math.max(0, gain));
}

/** Maps linear web audio gain (0..5) to perceptual slider level (0..1). */
export function toOverlayVolumeLevel(gain: number): number {
  const clamped = clampGain(gain);
  if (clamped <= 1) {
    return OVERLAY_FULL_VOLUME_LEVEL * Math.sqrt(clamped);
  }
  return (
    OVERLAY_FULL_VOLUME_LEVEL +
    (1 - OVERLAY_FULL_VOLUME_LEVEL) *
      Math.pow((clamped - 1) / (OVERLAY_MAX_USER_VOLUME - 1), 1 / BOOST_CURVE)
  );
}

/** Converts a UI slider level (0..1) back to linear gain (0..5). */
export function toOverlayVolumeGain(level: number): number {
  const clamped = clampLevel(level);
  if (clamped <= OVERLAY_FULL_VOLUME_LEVEL) {
    return Math.pow(clamped / OVERLAY_FULL_VOLUME_LEVEL, VOLUME_CURVE);
  }
  return (
    1 +
    Math.pow(
      (clamped - OVERLAY_FULL_VOLUME_LEVEL) / (1 - OVERLAY_FULL_VOLUME_LEVEL),
      BOOST_CURVE,
    ) *
      (OVERLAY_MAX_USER_VOLUME - 1)
  );
}
