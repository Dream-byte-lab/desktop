// The dashboard's DJ block input: a read-only summary of the
// performed-join log (interface slice S2).
//
// The log lives in linerDb's `joins` store under one record whose
// id has its shared home beside the store itself
// (JOINS_LOG_RECORD_ID in shared/storage — the slice report's
// SEAMS OWED (d), landed at the 0.1.15 integration pass). The
// payload is `unknown` at the storage layer BY DESIGN:
// the engine owns the shape and its validation. This reader
// validates defensively the same way the engine's own evaluation
// read does — a malformed record or evaluation reads as absent,
// never as a failing grade and never as a crash.

import { linerDb, JOINS_LOG_RECORD_ID } from "@/shared/storage";
import type { JoinSummary } from "./listeningStats";

function gradeOf(record: unknown): number | null {
  if (!record || typeof record !== "object") return null;
  const evaluation = (record as Record<string, unknown>).evaluation;
  if (!evaluation || typeof evaluation !== "object") return null;
  const overall = (evaluation as Record<string, unknown>).overall;
  if (
    typeof overall !== "number" ||
    !Number.isFinite(overall) ||
    overall < 0 ||
    overall > 1
  )
    return null;
  return overall;
}

/**
 * Joins performed + the §28 grade summary, or null when no joins
 * records exist — the dashboard's DJ block renders only from a
 * non-null summary, and its grade line only from graded joins.
 */
export async function readJoinSummary(): Promise<JoinSummary | null> {
  const record = await linerDb.getJoinLog(JOINS_LOG_RECORD_ID);
  const joins: unknown = record?.joins;
  if (!Array.isArray(joins) || joins.length === 0) return null;

  let performed = 0;
  let graded = 0;
  let gradeSum = 0;
  for (const entry of joins) {
    if (!entry || typeof entry !== "object") continue;
    performed += 1;
    const grade = gradeOf(entry);
    if (grade !== null) {
      graded += 1;
      gradeSum += grade;
    }
  }
  if (performed === 0) return null;
  return {
    performed,
    graded,
    averageGrade: graded > 0 ? gradeSum / graded : null,
  };
}
