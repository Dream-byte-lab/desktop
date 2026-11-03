// user volume spans gain 0..5: the slider can push past 100% up to 500%
export const MAX_USER_VOLUME = 5;

// 100% (gain 1.0) sits at 70% of the slider's travel, not at the top: the
// boost zone above 100% needs travel room of its own, so the familiar
// 0..100% range is compressed into the first 70% and the last 30% is
// reserved for boost
export const FULL_VOLUME_LEVEL = 0.7;

const VOLUME_CURVE = 2;
const BOOST_CURVE = 1.5;

function clampLevel(level: number): number {
  return Math.min(1, Math.max(0, level));
}

// clamps a user volume (gain) into its 0..MAX_USER_VOLUME domain
export function clampUserVolume(volume: number): number {
  return Math.min(MAX_USER_VOLUME, Math.max(0, volume));
}

// maps linear web audio gain (0..5) to perceptual slider level (0..1)
export function toVolumeLevel(gain: number): number {
  const clamped = clampUserVolume(gain);
  if (clamped <= 1) {
    // below 100%: the square-root perceptual law, rescaled so gain 1.0
    // lands at FULL_VOLUME_LEVEL of travel
    return FULL_VOLUME_LEVEL * Math.sqrt(clamped);
  }
  return (
    FULL_VOLUME_LEVEL +
    (1 - FULL_VOLUME_LEVEL) *
      Math.pow((clamped - 1) / (MAX_USER_VOLUME - 1), 1 / BOOST_CURVE)
  );
}

// converts ui slider level (0..1) back to linear gain (0..5)
export function toVolumeGain(level: number): number {
  const clamped = clampLevel(level);
  if (clamped <= FULL_VOLUME_LEVEL) {
    // the existing square perceptual law, rescaled to the 0..100% zone
    return Math.pow(clamped / FULL_VOLUME_LEVEL, VOLUME_CURVE);
  }
  return (
    1 +
    Math.pow(
      (clamped - FULL_VOLUME_LEVEL) / (1 - FULL_VOLUME_LEVEL),
      BOOST_CURVE,
    ) *
      (MAX_USER_VOLUME - 1)
  );
}
