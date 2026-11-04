// The on-device play log's access layer (interface slice S2).
//
// The log lives in linerDb's `plays` store; this module is its only
// reader/writer in the app. Records come back off disk untrusted
// (an older build, a hand-edited database), so reads validate
// defensively — a malformed record is skipped, never repaired into
// a fake play and never a crash.

import { linerDb, type CachedPlayEventRecord } from "@/shared/storage/linerDb";

function isValidRecord(value: unknown): value is CachedPlayEventRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.trackId === "string" &&
    typeof r.listenedAtMs === "number" &&
    Number.isFinite(r.listenedAtMs) &&
    typeof r.playedDurationMs === "number" &&
    typeof r.completionRate === "number" &&
    !!r.track &&
    typeof (r.track as Record<string, unknown>).id === "string"
  );
}

/** The whole device log, oldest first, malformed records skipped. */
export async function readDevicePlayEvents(): Promise<CachedPlayEventRecord[]> {
  const raw = await linerDb.getPlayEvents();
  return raw.filter(isValidRecord);
}

export async function appendDevicePlayEvent(
  record: CachedPlayEventRecord,
): Promise<void> {
  await linerDb.putPlayEvent(record);
}

/** The instant the device log takes over: its earliest event, or null. */
export function deviceLogStartMs(
  records: readonly CachedPlayEventRecord[],
): number | null {
  if (records.length === 0) return null;
  return Math.min(...records.map((r) => r.listenedAtMs));
}
