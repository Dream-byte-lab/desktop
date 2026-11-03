import type { LyricsCandidate } from "@/shared/contracts/lyrics";

// Client-side LRCLIB fallback: when the Liner server stream completes with
// no lyrics candidates at all, the renderer can ask lrclib.net directly.
// This is a fallback of last resort, not a second primary source — the
// server lookup always runs first and alone decides when it has results.

const LRCLIB_BASE_URL = "https://lrclib.net";
const LRCLIB_TIMEOUT_MS = 6000;
// search hits are only trusted when their duration is this close to the
// track the user is actually playing
const SEARCH_DURATION_TOLERANCE_S = 2;

// LRCLIB asks API clients to identify themselves with this header
const LRCLIB_CLIENT_HEADER = "Linerave (https://lrclib.net)";

export interface LrclibTrackHint {
  title: string;
  artist: string;
  durationMs?: number;
}

interface LrclibRecord {
  trackName?: string;
  name?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

// one network attempt per track per session, no matter how often the
// track is replayed — a miss on LRCLIB is not retried until restart
const attemptedTrackIds = new Set<string>();

export function hasAttemptedLrclibFallback(trackId: string): boolean {
  return attemptedTrackIds.has(trackId);
}

export function markLrclibFallbackAttempted(trackId: string): void {
  attemptedTrackIds.add(trackId);
}

export function resetLrclibFallbackAttempts(): void {
  attemptedTrackIds.clear();
}

export interface LrclibFallbackDecision {
  streamCompleted: boolean;
  candidateCount: number;
  instrumental: boolean;
  enabled: boolean;
  alreadyAttempted: boolean;
  hasCachedFallback: boolean;
}

// Pure trigger decision for the fallback. Only a COMPLETED primary stream
// (its done event arrived) with zero candidates qualifies — a stream that
// threw (server outage) must never fall through to here.
export function shouldAttemptLrclibFallback(
  decision: LrclibFallbackDecision,
): boolean {
  return (
    decision.streamCompleted &&
    decision.candidateCount === 0 &&
    !decision.instrumental &&
    decision.enabled &&
    !decision.alreadyAttempted &&
    !decision.hasCachedFallback
  );
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function recordToCandidate(record: LrclibRecord): LyricsCandidate | null {
  if (record.instrumental) return null;

  const synced = record.syncedLyrics?.trim() ? record.syncedLyrics : null;
  const plain = record.plainLyrics?.trim() ? record.plainLyrics : null;
  if (!synced && !plain) return null;

  const isSynced = Boolean(synced);
  return {
    provider: "LRCLIB",
    contentKind: isSynced ? "line_synced" : "plain",
    syncLevel: isSynced ? "line_level" : "plain",
    quality: {
      // deliberately below typical server candidates (65-95 in fixtures):
      // this is an unverified direct fallback, shown only when the server
      // had nothing at all
      total: 50,
      match: 15,
      content: 20,
      sync: isSynced ? 10 : 0,
      source: 5,
      reasons: ["client-side LRCLIB fallback (lrclib.net)"],
    },
    lyrics: {
      format: isSynced ? "lrc" : "plain",
      content: (synced ?? plain) as string,
    },
  };
}

async function fetchJson(
  url: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LRCLIB_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      headers: { "Lrclib-Client": LRCLIB_CLIENT_HEADER },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, body: null };
    }
    const body: unknown = await response.json();
    return { ok: true, status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

function isRecord(value: unknown): value is LrclibRecord {
  return typeof value === "object" && value !== null;
}

// Fetches one candidate from LRCLIB, or null when there is no trustworthy
// result. Never throws: network errors, timeouts, 404s and malformed
// payloads all resolve to null so the caller keeps its no-lyrics outcome.
export async function fetchLrclibCandidate(
  hint: LrclibTrackHint,
  signal?: AbortSignal,
): Promise<LyricsCandidate | null> {
  const title = hint.title?.trim();
  const artist = hint.artist?.trim();
  if (!title || !artist) return null;

  const durationS =
    hint.durationMs && hint.durationMs > 0
      ? Math.round(hint.durationMs / 1000)
      : undefined;

  try {
    const getParams = new URLSearchParams({
      track_name: title,
      artist_name: artist,
    });
    if (durationS !== undefined) {
      getParams.set("duration", String(durationS));
    }
    const exact = await fetchJson(
      `${LRCLIB_BASE_URL}/api/get?${getParams.toString()}`,
      signal,
    );
    if (exact.ok && isRecord(exact.body)) {
      // /api/get matched on title/artist/duration server-side; an
      // instrumental or lyric-less record is a definitive miss
      return recordToCandidate(exact.body);
    }

    // fall back to search, but only accept a hit that provably is this
    // track: same normalized title + artist and duration within ±2s
    if (durationS === undefined) return null;
    const searchParams = new URLSearchParams({
      track_name: title,
      artist_name: artist,
    });
    const search = await fetchJson(
      `${LRCLIB_BASE_URL}/api/search?${searchParams.toString()}`,
      signal,
    );
    if (!search.ok || !Array.isArray(search.body)) return null;

    const wantedTitle = normalizeForMatch(title);
    const wantedArtist = normalizeForMatch(artist);
    for (const hit of search.body) {
      if (!isRecord(hit)) continue;
      const hitTitle = normalizeForMatch(hit.trackName ?? hit.name ?? "");
      const hitArtist = normalizeForMatch(hit.artistName ?? "");
      if (hitTitle !== wantedTitle || hitArtist !== wantedArtist) continue;
      if (
        typeof hit.duration !== "number" ||
        Math.abs(hit.duration - durationS) > SEARCH_DURATION_TOLERANCE_S
      ) {
        continue;
      }
      const candidate = recordToCandidate(hit);
      if (candidate) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}
