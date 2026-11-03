import type { Track } from "@/shared/contracts";
import {
  FailedImportsStore,
  failedImports,
  type FailedImportEntry,
} from "./failedImportsStore";
import { retryFailedImports } from "./retryFailedImports";
import { finalizeImportedPlaylist } from "../manager/finalizeImport";

// Recovery from the one failed-songs playlist ("Could not
// import"). Retrying re-runs the same matching the imports used;
// songs that now match confidently LEAVE the failed playlist and
// join the library properly, saved into a "<import title> —
// recovered" playlist per original import (the recovery landing
// this app has always used). Songs that still cannot match keep
// their place in the failed playlist with their reason refreshed,
// and a song that matches but cannot be saved stays too, as a
// saving failure — recovery never loses a song either.

export interface RecoverFailedOutcome {
  recoveredCount: number;
  stillFailingCount: number;
  recoveredKeys: string[];
}

export interface RecoverFailedDeps {
  match?: Parameters<typeof retryFailedImports>[1];
  save?: (title: string, tracks: Track[]) => Promise<{ failedTracks: Track[] }>;
  store?: FailedImportsStore;
}

export async function recoverFailedImports(
  entries: FailedImportEntry[],
  deps: RecoverFailedDeps = {},
): Promise<RecoverFailedOutcome> {
  const store = deps.store ?? failedImports;
  const save =
    deps.save ??
    (async (title: string, tracks: Track[]) => {
      const result = await finalizeImportedPlaylist(title, undefined, tracks);
      return { failedTracks: result.failedTracks };
    });

  const outcome = await retryFailedImports(entries, deps.match);
  const failedAt = new Date().toISOString();

  // Refresh the held entries for songs that still cannot match.
  if (outcome.stillFailing.length > 0) {
    store.record(
      outcome.stillFailing.map(({ entry, reason }) => ({
        source: entry.source,
        sourceTrack: entry.sourceTrack,
        reason,
        stage: entry.stage,
        importTitle: entry.importTitle,
        failedAt,
      })),
    );
  }

  // Save the recovered songs, grouped back under their import.
  const recoveredByTitle = new Map<
    string,
    { entry: FailedImportEntry; track: Track }[]
  >();
  for (const pair of outcome.matched) {
    const list = recoveredByTitle.get(pair.entry.importTitle) ?? [];
    list.push(pair);
    recoveredByTitle.set(pair.entry.importTitle, list);
  }

  const recoveredKeys: string[] = [];
  let recoveredCount = 0;
  for (const [title, pairs] of recoveredByTitle) {
    const savedResult = await save(
      `${title} — recovered`,
      pairs.map((pair) => pair.track),
    );
    const unsavedIds = new Set(
      savedResult.failedTracks.map((track) => track.id),
    );
    for (const pair of pairs) {
      if (unsavedIds.has(pair.track.id)) {
        // Matched but could not be saved: it stays in the playlist.
        store.record([
          {
            source: pair.entry.source,
            sourceTrack: pair.entry.sourceTrack,
            reason: "save_failed",
            stage: "saving",
            importTitle: pair.entry.importTitle,
            failedAt,
          },
        ]);
      } else {
        recoveredKeys.push(pair.entry.key);
        recoveredCount += 1;
      }
    }
  }

  if (recoveredKeys.length > 0) store.remove(recoveredKeys);

  return {
    recoveredCount,
    stillFailingCount: outcome.stillFailing.length,
    recoveredKeys,
  };
}
