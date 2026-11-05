// The dashboard's DJ block input: a read-only summary of the
// performed-join log (interface slice S2).
//
// The log is the new engine's behaviour record (design §3.6): every
// performed join and every fallback/degradation the session lands
// is appended to the engine's own storage, and storage.ts's
// listBehaviour() is its read API. This reader reduces that log to
// the dashboard's summary shape, defensively — a malformed record
// is skipped, never a crash.
//
// The summary reports exactly what the record holds, counted by
// its reason: "performed" entries are joins the draw sounded,
// "user-act" entries are joins a person triggered, the
// fallback/degradation reasons are counted under their own names,
// and "set-end" markers close the count. Nothing else is inferred
// from the record — in particular it carries no evaluation of how
// good a join was, so no such figure appears in the summary or on
// the dashboard.

import {
  listBehaviour,
  type BehaviourRecord,
} from "@/features/mixer/liverave/storage";
import type { JoinSummary } from "./listeningStats";

function isRecordLike(value: unknown): value is BehaviourRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}

/**
 * The behaviour log reduced to its honest counts, or null when the
 * log holds no usable records at all — the dashboard's DJ block
 * renders only from a non-null summary.
 */
export async function readJoinSummary(): Promise<JoinSummary | null> {
  let records: BehaviourRecord[];
  try {
    records = await listBehaviour();
  } catch {
    // The log itself is unreadable (storage unavailable): the
    // summary is absent, exactly as when it is empty — the rest
    // of the dashboard must not fail with the DJ block.
    return null;
  }
  if (!Array.isArray(records) || records.length === 0) return null;

  const summary: JoinSummary = {
    performed: 0,
    userAct: 0,
    fallbackUnprepared: 0,
    fallbackInvalid: 0,
    degradedUntrusted: 0,
    setEnd: 0,
  };
  let seen = 0;
  for (const entry of records) {
    if (!isRecordLike(entry)) continue;
    seen += 1;
    switch (entry.reason) {
      case "performed":
        summary.performed += 1;
        break;
      case "user-act":
        summary.userAct += 1;
        break;
      case "fallback-unprepared":
        summary.fallbackUnprepared += 1;
        break;
      case "fallback-invalid":
        summary.fallbackInvalid += 1;
        break;
      case "degraded-untrusted":
        summary.degradedUntrusted += 1;
        break;
      case "set-end":
        summary.setEnd += 1;
        break;
      default:
        // A reason this reader does not know: counted as seen (the
        // block exists) but attributed to no count it cannot name.
        break;
    }
  }
  if (seen === 0) return null;
  return summary;
}
