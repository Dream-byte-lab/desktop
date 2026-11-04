// The device play log's writer (interface slice S2).
//
// STANDALONE BY DESIGN: this module is complete and tested, and the
// one-line hookup that feeds it — calling recordDevicePlay with the
// same payload the player engine sends to api.recordPlaybackEvent —
// is listed in the slice report's SEAMS OWED, because the engine
// file belongs to another fence. Nothing here imports the player
// engine; the payload type is the shared recording contract, the
// same shape both reports are built from.

import { toClientTrack } from "@/shared/api";
import type { RecordPlaybackEventRequest } from "@/shared/contracts/history";
import type { CachedPlayEventRecord } from "@/shared/storage/linerDb";
import type { Track } from "@/shared/types";
import { appendDevicePlayEvent } from "./playLog";

let sequence = 0;

function fallbackTrack(payload: RecordPlaybackEventRequest): Track {
  return {
    id: payload.trackId,
    title: "",
    artists: "",
    coverUrl: "",
    durationMs: payload.trackDurationMs ?? 0,
    playCount: 0,
  };
}

/**
 * Builds the stored record for one reported play. `listenedAtMs` is
 * when the play ended on this device (the report fires at the end
 * of a play, like the server report it mirrors). Returns null when
 * the payload carries no track id — a play of nothing is not
 * recorded as anything.
 */
export function devicePlayEventFromPayload(
  payload: RecordPlaybackEventRequest,
  listenedAtMs: number,
): CachedPlayEventRecord | null {
  if (!payload.trackId) return null;
  sequence += 1;
  const track = payload.trackSnapshot
    ? toClientTrack(payload.trackSnapshot)
    : fallbackTrack(payload);
  return {
    id: `${listenedAtMs.toString(36)}-${sequence.toString(36)}-${payload.trackId}`,
    trackId: payload.trackId,
    track,
    playedDurationMs: payload.playedDurationMs,
    completionRate: payload.completionRate,
    completed: payload.completed ?? false,
    skipped: payload.skipped ?? false,
    loopCount: payload.loopCount ?? 0,
    hasSeekBackward: payload.hasSeekBackward ?? false,
    contextType: payload.context?.type,
    contextId: payload.context?.id,
    playbackSessionId: payload.playbackSessionId,
    listenedAtMs,
  };
}

/**
 * Records one reported play in the device log. Fire-and-forget by
 * contract: it never throws and never rejects — a log failure must
 * not disturb playback or the server report it shadows.
 */
export function recordDevicePlay(
  payload: RecordPlaybackEventRequest,
  listenedAtMs: number = Date.now(),
): void {
  try {
    const record = devicePlayEventFromPayload(payload, listenedAtMs);
    if (!record) return;
    void appendDevicePlayEvent(record).catch(() => undefined);
  } catch {
    // The log is an enhancement; silence is the correct failure mode.
  }
}
