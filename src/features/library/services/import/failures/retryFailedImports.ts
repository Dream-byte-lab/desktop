import type { Track } from "@/shared/contracts";
import { findCatalogMatch } from "@/shared/media/matching";
import type { FailedImportEntry } from "./failedImportsStore";

// Retrying the failed-imports collection. A song that could not be
// matched on the day it was imported may match later — catalogues
// change, searches improve, a version appears. A retry re-runs the
// same matching the import used. Only confident matches recover
// automatically; an uncertain candidate keeps the song here with
// its (possibly new) reason rather than guessing it into a
// playlist. Saving the recovered songs is the caller's job.

export interface RetryOutcome {
  matched: { entry: FailedImportEntry; track: Track }[];
  stillFailing: { entry: FailedImportEntry; reason: string }[];
}

type MatchFn = typeof findCatalogMatch;

const RETRY_CONCURRENCY = 4;

export async function retryFailedImports(
  entries: FailedImportEntry[],
  match: MatchFn = findCatalogMatch,
  signal?: AbortSignal,
): Promise<RetryOutcome> {
  const matched: RetryOutcome["matched"] = [];
  const stillFailing: RetryOutcome["stillFailing"] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        const outcome = await match(entry.sourceTrack, signal);
        if (outcome.status === "approved") {
          matched.push({ entry, track: outcome.track });
        } else {
          stillFailing.push({ entry, reason: outcome.reason });
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        stillFailing.push({ entry, reason: "catalog_lookup_failed" });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RETRY_CONCURRENCY, entries.length) }, worker),
  );
  return { matched, stillFailing };
}
