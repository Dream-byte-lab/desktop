/**
 * Crossfade (plain playback only): a real overlapping crossfade. As a
 * track nears its end, the next track starts playing on a second audio
 * element and the two sound together — the outgoing leg fades out on an
 * equal-power curve while the incoming leg fades in on the complementary
 * curve — until the outgoing ends and the incoming element is promoted
 * to primary. Both legs feed the one shared effects graph (see
 * pitchShifter's secondary leg), so EQ / reverb / pitch / volume boost
 * treat the incoming exactly as they treat the primary.
 *
 * This is deliberately distinct from the song fade in ./songFade: that
 * is a fade THROUGH the change on one element (out, silence point, in).
 * Interplay ruling: the two never stack on one boundary. While the
 * crossfade preference is on (> 0), the crossfade owns every boundary
 * it can arm for, and the song fade does not engage at all; with the
 * crossfade off, the song fade behaves exactly as before.
 *
 * Next-track determination and the window maths are shared with the
 * song fade (nextTrackForSongFade / songFadeWindowMs in ./songFade):
 * the same auto-end semantics, the same exclusions (repeat-one and
 * radio never crossfade), and the same bound — the window never takes
 * more than half of either song.
 */

/** Longest crossfade the preference can ask for, in seconds. */
export const MAX_CROSSFADE_SECONDS = 30;

/** Clamps a raw preference value to the supported range, in whole seconds. */
export function clampCrossfadeSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_CROSSFADE_SECONDS, Math.max(0, Math.round(value)));
}

/**
 * Equal-power gains for an overlap at `progress` in [0, 1]: the
 * outgoing leg follows cos, the incoming leg follows sin, so the sum
 * of squares is 1 throughout — for uncorrelated material the total
 * power stays constant across the join instead of dipping the way a
 * linear (or fade-through) ramp does at its centre.
 */
export function crossfadeGains(progress: number): {
  outGain: number;
  inGain: number;
} {
  const p = Math.min(1, Math.max(0, progress));
  const angle = (p * Math.PI) / 2;
  return { outGain: Math.cos(angle), inGain: Math.sin(angle) };
}
