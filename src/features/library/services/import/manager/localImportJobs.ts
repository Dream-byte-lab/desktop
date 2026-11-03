import {
  LOCAL_IMPORT_PREFIX,
  registerLocalImportHandler,
} from "@/shared/api/localImports";
import type {
  ImportJob,
  ImportPartialInfo,
  ImportReview,
  ImportSource,
  Track,
} from "@/shared/contracts";
import { saveFailedSongsToPlaylist } from "../failures/failedPlaylist";
import type { FailedImportTrack } from "./clientImportManager";
import { finalizeImportedPlaylist } from "./finalizeImport";

interface LocalImportRecord {
  job: ImportJob;
  reviewItems: ImportReview[];
}

type JobListener = (job: ImportJob) => void;

const records = new Map<string, LocalImportRecord>();
const listeners = new Set<JobListener>();

function newJobId(): string {
  const random =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${LOCAL_IMPORT_PREFIX}${random}`;
}

export function createLocalImportJob(
  source: ImportSource,
  sourceUrl: string,
): ImportJob {
  const job: ImportJob = {
    id: newJobId(),
    source,
    sourceUrl,
    status: "running",
    requiresDecision: false,
    result: { total: 0, imported: 0, skipped: 0 },
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  records.set(job.id, { job, reviewItems: [] });
  return job;
}

export function updateLocalImportJob(
  jobId: string,
  patch: Partial<ImportJob>,
  reviewItems?: ImportReview[],
): ImportJob | undefined {
  const record = records.get(jobId);
  if (!record) return undefined;
  record.job = { ...record.job, ...patch };
  if (reviewItems) record.reviewItems = reviewItems;
  listeners.forEach((listener) => listener(record.job));
  return record.job;
}

export function onLocalImportJobChange(listener: JobListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function finalizeLocalImport(
  jobId: string,
  tracks: Track[],
  title?: string,
  description?: string,
  matchingFailures: FailedImportTrack[] = [],
  partial?: ImportPartialInfo,
): Promise<{ finalized: boolean }> {
  const record = records.get(jobId);
  if (!record) throw new Error("Import was not found.");
  if (record.job.status === "completed") return { finalized: true };
  const total = record.job.result?.total ?? tracks.length;
  const importTitle = title || record.job.title || "Imported playlist";
  updateLocalImportJob(jobId, { status: "finalizing" });
  try {
    const { playlistId, saved, failedTracks } = await finalizeImportedPlaylist(
      importTitle,
      description ?? record.job.description,
      tracks,
    );
    // Every song that failed — at matching, at saving, or left
    // over at review — is saved into the ONE failed-songs playlist
    // ("Could not import"), automatically, here inside the import
    // itself: the job is only marked completed after this save, so
    // a finished import always means the playlist is already
    // populated. The import itself completes with whatever
    // succeeded.
    const failedAt = new Date().toISOString();
    // Review leftovers: this job's review items whose proposed
    // track is NOT among the tracks being finalized were turned
    // down (or skipped wholesale) in the review modal — both the
    // decide and the skip flows funnel into this finalize, and
    // until now those songs were recorded nowhere.
    const finalizedIds = new Set(tracks.map((track) => track.id));
    const deniedReviewItems = record.reviewItems.filter(
      (item) => item.proposedTrack && !finalizedIds.has(item.proposedTrack.id),
    );
    saveFailedSongsToPlaylist([
      ...matchingFailures.map((failure) => ({
        source: record.job.source,
        sourceTrack: failure.sourceTrack,
        reason: failure.reason,
        stage: "matching" as const,
        importTitle,
        failedAt,
      })),
      ...failedTracks.map((track) => ({
        source: record.job.source,
        sourceTrack: {
          sourceId: track.id,
          title: track.title,
          artists: track.artists.map((artist) => artist.name),
          ...(track.durationMs ? { durationMs: track.durationMs } : {}),
        },
        reason: "save_failed",
        stage: "saving" as const,
        importTitle,
        failedAt,
      })),
      ...deniedReviewItems.map((item) => ({
        source: record.job.source,
        sourceTrack: item.sourceTrack,
        reason: "review_denied",
        stage: "review" as const,
        importTitle,
        failedAt,
      })),
    ]);
    updateLocalImportJob(
      jobId,
      {
        status: "completed",
        requiresDecision: false,
        playlistId,
        result: { total, imported: saved, skipped: Math.max(0, total - saved) },
        // A partial import completes WITH its shortfall attached —
        // "completed-with-partial", never presented as a clean
        // complete. (A partial recorded earlier, e.g. at parse time
        // on an awaiting-decision job, survives untouched when no
        // newer one is passed.)
        ...(partial ? { partial } : {}),
        finishedAt: new Date().toISOString(),
      },
      [],
    );
    return { finalized: true };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to save imported playlist";
    updateLocalImportJob(jobId, {
      status: "failed",
      error: { code: "FINALIZE_FAILED", message },
      finishedAt: new Date().toISOString(),
    });
    throw error;
  }
}

registerLocalImportHandler({
  getJob: (jobId) => records.get(jobId)?.job,
  getReview: (jobId) => records.get(jobId)?.reviewItems ?? [],
  finalize: finalizeLocalImport,
});
