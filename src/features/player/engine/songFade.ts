import type { PlayerState } from "../store/playerStore";
import type { Track } from "@/shared/types";
import { isRadioContext } from "./radioMode";

/**
 * Song fade (plain playback only): as a track nears its end the volume
 * fades out, and the next track fades in over the same window. This is
 * a fade through the change on a single audio element — NOT an
 * overlapping crossfade. True two-source overlap lives in the DJ
 * engine's decks; when a DJ session is running it owns the joins and
 * this fade never engages (the plain element is not the playing
 * source, and queue advance is routed to the session).
 */

/** Shortest fade window worth performing; below this the fade is skipped. */
export const MIN_SONG_FADE_MS = 250;

/** Longest fade the preference can ask for, in seconds. */
export const MAX_SONG_FADE_SECONDS = 30;

/**
 * The track an automatic end-of-track advance would play next, for
 * fade purposes. Mirrors PlayerEngine.computeNextIndex with isAutoEnd
 * semantics, with two deliberate differences: repeat-one has no fade
 * target (the same track restarts — fading it would be theatre), and
 * radio contexts are excluded (their queue refills underneath, so
 * "next" is not stable enough to fade toward).
 */
export function nextTrackForSongFade(state: PlayerState): Track | null {
  const queue = state.queue;
  const currentIndex = state.currentIndex;
  if (queue.length === 0 || currentIndex < 0) return null;
  if (state.repeat === "one") return null;
  if (isRadioContext(state.playbackContext)) return null;

  const current = queue[currentIndex];
  if (currentIndex + 1 < queue.length) return queue[currentIndex + 1];
  if (state.repeat === "all" && queue.length > 1) {
    const first = queue[0];
    return first && current && first.id !== current.id ? first : null;
  }
  return null;
}

/**
 * The fade window in milliseconds: the listener's preference, bounded
 * by half the outgoing track and half the incoming track (when its
 * duration is known), so a fade can never swallow most of a short
 * song. Returns 0 when no audible fade should happen.
 */
export function songFadeWindowMs(
  preferenceSeconds: number,
  outgoingDurationSec: number,
  incomingDurationSec: number | null,
): number {
  if (!preferenceSeconds || preferenceSeconds <= 0) return 0;
  if (!Number.isFinite(outgoingDurationSec) || outgoingDurationSec <= 0)
    return 0;
  let windowSec = Math.min(preferenceSeconds, outgoingDurationSec / 2);
  if (
    incomingDurationSec !== null &&
    Number.isFinite(incomingDurationSec) &&
    incomingDurationSec > 0
  ) {
    windowSec = Math.min(windowSec, incomingDurationSec / 2);
  }
  const windowMs = Math.round(windowSec * 1000);
  return windowMs >= MIN_SONG_FADE_MS ? windowMs : 0;
}

/** Clamps a raw preference value to the supported range, in whole seconds. */
export function clampSongFadeSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_SONG_FADE_SECONDS, Math.max(0, Math.round(value)));
}
