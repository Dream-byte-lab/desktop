// One-shot intent between the playback bar and the Now Playing
// surface: the bar's lyrics button asks the surface to land on the
// full-screen lyrics view instead of the split view. The two are
// separate mounts — the surface mounts when the fullscreen player
// opens — so the request travels as a timestamped one-shot that the
// surface consumes on mount. The timestamp guards the failure edge:
// if the open never happens, a stale request is ignored rather than
// ambushing a later, unrelated open.

const INTENT_TTL_MS = 5_000;

let requestedAt: number | null = null;

/** Record a request for the lyrics view (bar lyrics button). */
export function requestLyricsViewOpen(now: number = Date.now()): void {
  requestedAt = now;
}

/**
 * Take the pending request, if any. Returns true exactly once per
 * fresh request; consuming clears it either way.
 */
export function consumeLyricsViewOpenRequest(
  now: number = Date.now(),
): boolean {
  if (requestedAt === null) return false;
  const fresh = now - requestedAt <= INTENT_TTL_MS;
  requestedAt = null;
  return fresh;
}
