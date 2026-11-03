import { create } from "zustand";
import type { ImportJob, ImportReview } from "@/shared/api";
import type { ImportSource, Track } from "@/shared/contracts";
import { notifyLibraryChanged } from "../hooks/usePlaylists";
import { detectImportSource } from "../services/import";
import { saveFailedSongsToPlaylist } from "../services/import/failures/failedPlaylist";
import { parseExportFile } from "../services/import/sources/spotify/spotifyExport";
import {
  runClientImport,
  runClientImportFromPlaylist,
  type ImportProgress,
} from "../services/import/manager/clientImportManager";
import {
  createLocalImportJob,
  finalizeLocalImport,
  onLocalImportJobChange,
  updateLocalImportJob,
} from "../services/import/manager/localImportJobs";
import { useModalStore, type TrackDetail } from "./modalStore";
import { watchPendingTrackAfterImport } from "./importPendingTrack";

export interface ActiveImportState {
  job: ImportJob | null;
  isPolling: boolean;
  error: string | null;
  pendingTrack: TrackDetail | null;
  reviewItems: ImportReview[] | null;
  approvedTracks: Track[] | null;
  startImport: (
    url: string,
    pendingTrack?: TrackDetail | null,
  ) => Promise<ImportJob>;
  startFileImport: (
    fileName: string,
    text: string,
  ) => Promise<{ playlists: number; imported: number; kept: number }>;
  cancelPolling: () => void;
  reset: () => void;
}

let activeAbortController: AbortController | null = null;

function cleanupActiveImport() {
  activeAbortController?.abort();
  activeAbortController = null;
}

function progressPatch(progress: ImportProgress): Partial<ImportJob> {
  return {
    status: "running",
    result: progress.result,
    ...(progress.title ? { title: progress.title } : {}),
    ...(progress.description ? { description: progress.description } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Import failed";
}

export const useImportStore = create<ActiveImportState>((set, get) => ({
  job: null,
  isPolling: false,
  error: null,
  pendingTrack: null,
  reviewItems: null,
  approvedTracks: null,

  reset: () => {
    cleanupActiveImport();
    set({
      job: null,
      isPolling: false,
      error: null,
      pendingTrack: null,
      reviewItems: null,
      approvedTracks: null,
    });
  },

  cancelPolling: () => {
    cleanupActiveImport();
    set({ isPolling: false });
  },

  startImport: async (url: string, pendingTrack: TrackDetail | null = null) => {
    get().cancelPolling();
    let source: ImportSource;
    try {
      source = detectImportSource(url);
    } catch (error) {
      set({ error: errorMessage(error), isPolling: false, pendingTrack: null });
      throw error;
    }

    const job = createLocalImportJob(source, url.trim());
    const controller = new AbortController();
    activeAbortController = controller;
    set({
      job,
      error: null,
      isPolling: true,
      pendingTrack,
      reviewItems: null,
      approvedTracks: null,
    });

    void (async () => {
      try {
        const outcome = await runClientImport(url, {
          signal: controller.signal,
          onProgress: (progress) =>
            updateLocalImportJob(job.id, progressPatch(progress)),
        });
        if (controller.signal.aborted) return;
        const meta = {
          title: outcome.title,
          description: outcome.description,
          result: outcome.result,
          ...(outcome.partial ? { partial: outcome.partial } : {}),
        };

        if (outcome.reviewItems.length > 0) {
          if (outcome.failedTracks.length > 0) {
            // Matching failures are final the moment matching ends —
            // save them into the one failed-songs playlist whatever
            // the review below decides. (When there is no review,
            // finalizeLocalImport saves them instead.)
            const failedAt = new Date().toISOString();
            saveFailedSongsToPlaylist(
              outcome.failedTracks.map((failure) => ({
                source,
                sourceTrack: failure.sourceTrack,
                reason: failure.reason,
                stage: "matching" as const,
                importTitle: outcome.title,
                failedAt,
              })),
            );
          }
          updateLocalImportJob(
            job.id,
            { ...meta, status: "awaiting_decision", requiresDecision: true },
            outcome.reviewItems,
          );
          set({
            isPolling: false,
            reviewItems: outcome.reviewItems,
            approvedTracks: outcome.approvedTracks,
          });
          useModalStore.setState({
            importReviewPrefetched: outcome.reviewItems,
            importReviewApprovedTracks: outcome.approvedTracks,
          });
          useModalStore
            .getState()
            .openImportReview(
              job.id,
              outcome.reviewItems,
              outcome.approvedTracks,
            );
          return;
        }

        updateLocalImportJob(job.id, meta);
        await finalizeLocalImport(
          job.id,
          outcome.approvedTracks,
          outcome.title,
          outcome.description,
          outcome.failedTracks,
          outcome.partial,
        );
        set({ isPolling: false });
        notifyLibraryChanged();
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = errorMessage(error);
        updateLocalImportJob(job.id, {
          status: "failed",
          error: { code: "IMPORT_FAILED", message },
        });
        set({ isPolling: false, error: message });
      } finally {
        if (activeAbortController === controller) activeAbortController = null;
      }
    })();

    return job;
  },

  startFileImport: async (fileName: string, text: string) => {
    const { playlists } = parseExportFile(fileName, text);
    let imported = 0;
    let kept = 0;
    set({ isPolling: true, error: null });
    try {
      for (const playlist of playlists) {
        const job = createLocalImportJob(playlist.source, `file:${fileName}`);
        const outcome = await runClientImportFromPlaylist(playlist);
        updateLocalImportJob(job.id, {
          title: outcome.title,
          description: outcome.description,
          result: outcome.result,
        });
        // A file import runs unattended (a data download can hold
        // many playlists), so songs that would need a decision are
        // not dropped: they are saved into the one failed-songs
        // playlist, where a later retry can still bring them home.
        const failedAt = new Date().toISOString();
        const needsDecision = outcome.reviewItems.map((item) => ({
          source: playlist.source,
          sourceTrack: item.sourceTrack,
          reason: item.reason,
          stage: "review" as const,
          importTitle: outcome.title,
          failedAt,
        }));
        if (needsDecision.length > 0) saveFailedSongsToPlaylist(needsDecision);
        await finalizeLocalImport(
          job.id,
          outcome.approvedTracks,
          outcome.title,
          outcome.description,
          outcome.failedTracks,
          outcome.partial,
        );
        imported += outcome.result.imported;
        kept += outcome.failedTracks.length + needsDecision.length;
      }
    } finally {
      set({ isPolling: false });
    }
    notifyLibraryChanged();
    return { playlists: playlists.length, imported, kept };
  },
}));

onLocalImportJobChange((job) => {
  if (useImportStore.getState().job?.id === job.id)
    useImportStore.setState({ job });
});

watchPendingTrackAfterImport(useImportStore);
