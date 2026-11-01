// Level matching: the gain a track should play at so every song in
// the set sits at roughly the same loudness. Records are mastered at
// wildly different levels; without this, a quiet master reads as the
// party losing energy and a loud one slams. The session applies this
// gain per deck, underneath the user's volume and the blend
// automation, so nothing else has to know it exists.
//
// The correction is deliberately modest — clamped to ±6 dB — because
// the goal is consistency, not flattening every track to identical
// loudness: dynamics inside a song still belong to the song.

/** The loudness (overall RMS) tracks are matched toward. */
export const TARGET_LOUDNESS = 0.4;
const MIN_GAIN = 0.5;
const MAX_GAIN = 2;

/** Playback gain for a track measured at the given loudness. */
export function levelGainFor(loudness: number): number {
  if (!Number.isFinite(loudness) || loudness <= 0) return 1;
  const gain = TARGET_LOUDNESS / loudness;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain));
}
