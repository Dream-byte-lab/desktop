import { useTranslation } from "@/languages";
import { PlaylistFill } from "@mingcute/react";
import { useTweenedNumber } from "@/shared/hooks";
import { SegmentBar } from "@/shared/ui";
import type { ImportJob } from "@/shared/contracts/imports";
import type { LibraryViewMode } from "../types";
import { useModalStore } from "../store/modalStore";
import { useImportStore } from "../store/importStore";

interface ImportingPlaylistCardProps {
  job: ImportJob;
  viewMode?: LibraryViewMode;
}

export default function ImportingPlaylistCard({
  job,
  viewMode = "grid",
}: ImportingPlaylistCardProps) {
  const { t } = useTranslation();
  const isAwaiting = job.status === "awaiting_decision";
  const isRunning = job.status === "running";
  const isQueued = job.status === "queued";
  const isFinalizing = job.status === "finalizing";
  // A completed import that landed fewer tracks than the source
  // holds: it must read as partial — with counts and, when the
  // source can resume, a way to continue — never as a clean complete.
  const isPartial = job.status === "completed" && Boolean(job.partial);
  const canResume = isPartial && job.partial?.resumable === true;

  const displayTitle = job.title || t("import.active_import");
  const total = job.result?.total ?? 0;
  const imported = job.result?.imported ?? 0;
  const skipped = job.result?.skipped ?? 0;
  const processed = Math.round(useTweenedNumber(imported + skipped));
  const showProgress = isRunning && total > 0;

  const getSubtitle = () => {
    if (isPartial) {
      const expected = job.partial?.expectedTotal ?? total;
      const missing = job.partial?.missing ?? Math.max(0, expected - imported);
      return t("import.status_partial_sub", {
        imported,
        total: expected,
        missing,
      });
    }
    if (isQueued) {
      return t("import.status_queued");
    }
    if (isRunning) {
      if (total) {
        return t("import.status_running_progress", {
          count: processed,
          total,
        });
      }
      return t("import.status_searching_sub");
    }
    if (isAwaiting) return t("import.status_awaiting_decision");
    if (isFinalizing) return t("import.status_finalizing_sub");
    return t("import.status_searching");
  };

  const displaySubtitle = getSubtitle();

  const handleClick = () => {
    if (isAwaiting) {
      const { reviewItems, approvedTracks } = useImportStore.getState();
      useModalStore
        .getState()
        .openImportReview(
          job.id,
          reviewItems ?? undefined,
          approvedTracks ?? undefined,
        );
      return;
    }
    if (canResume) {
      // Re-running the same source resumes the remainder from the
      // checkpoint the failed attempt left behind.
      void useImportStore.getState().startImport(job.sourceUrl);
    }
  };

  if (viewMode === "list") {
    return (
      <div
        onClick={handleClick}
        className={`w-full flex items-center justify-between rounded-control p-[8px] select-none transition-all duration-150 ${
          isAwaiting || canResume
            ? "cursor-pointer hover:bg-fill opacity-90"
            : "cursor-default opacity-70"
        }`}
      >
        <div className="flex items-center gap-[16px] min-w-0 flex-1">
          <div className="relative h-[48px] w-[48px] shrink-0 overflow-hidden rounded-control bg-fill flex items-center justify-center">
            {isAwaiting || isPartial ? (
              <PlaylistFill size={22} className="text-text-tertiary/60" />
            ) : (
              <div className="h-[20px] w-[20px] animate-spin rounded-full border-[2px] border-text-tertiary/20 border-t-text-primary" />
            )}
          </div>

          <div className="min-w-0 flex flex-col gap-[2px] flex-1">
            <h3
              className="m-0 max-w-[min(52vw,560px)] overflow-hidden text-ellipsis whitespace-nowrap text-[16px] leading-[1.2] text-text-primary"
              style={{
                fontWeight: 400,
              }}
            >
              {displayTitle}
            </h3>
            <p
              className="m-0 flex min-w-0 items-center gap-[6px] text-label leading-[1.2] overflow-hidden text-text-secondary"
              style={{
                fontWeight: 350,
              }}
            >
              <span
                className={`inline-block h-[6px] w-[6px] rounded-full bg-text-primary shrink-0 ${
                  isAwaiting || isPartial ? "" : "animate-pulse"
                }`}
              />
              <span className="truncate">{displaySubtitle}</span>
            </p>
          </div>
        </div>

        {isAwaiting && (
          <span className="shrink-0 text-[11px] px-[8px] py-[3px] rounded-full bg-fill-hover text-text-primary font-[500]">
            {t("import.review_action")}
          </span>
        )}
        {canResume && (
          <span className="shrink-0 text-[11px] px-[8px] py-[3px] rounded-full bg-fill-hover text-text-primary font-[500]">
            {t("import.resume_action")}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      onClick={handleClick}
      className={`group flex flex-col gap-[8px] select-none transition-all ${
        isAwaiting || canResume
          ? "cursor-pointer opacity-90 hover:opacity-100"
          : "cursor-default opacity-70"
      }`}
      draggable={false}
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-control flex flex-col items-center justify-center bg-fill">
        {isAwaiting || isPartial ? (
          <PlaylistFill size={44} className="text-text-tertiary/50" />
        ) : showProgress ? null : (
          <div className="h-[28px] w-[28px] animate-spin rounded-full border-[2px] border-text-tertiary/20 border-t-text-primary" />
        )}

        {showProgress ? (
          // the storage overview in miniature: count, total and a share bar
          <div className="absolute inset-x-[12px] bottom-[12px] flex flex-col gap-[10px]">
            <div className="flex items-baseline gap-[5px]">
              <span className="text-[28px] font-[600] leading-none tracking-[-0.02em] tabular-nums text-text-primary">
                {processed}
              </span>
              <span className="text-title tabular-nums text-text-tertiary">
                / {total}
              </span>
            </div>
            <SegmentBar
              className="h-[6px]"
              segments={[
                { key: "imported", value: imported, swatch: "bg-text-primary" },
                {
                  key: "skipped",
                  value: skipped,
                  swatch: "bg-text-tertiary/60",
                },
                {
                  key: "left",
                  value: Math.max(0, total - imported - skipped),
                  swatch: "bg-fill-hover",
                },
              ]}
            />
          </div>
        ) : null}

        {isAwaiting && (
          <span className="absolute top-[8px] right-[8px] text-[10px] px-[6px] py-[2px] rounded-full bg-fill-hover text-text-primary font-[500]">
            {t("import.status_awaiting_decision")}
          </span>
        )}
        {canResume && (
          <span className="absolute top-[8px] right-[8px] text-[10px] px-[6px] py-[2px] rounded-full bg-fill-hover text-text-primary font-[500]">
            {t("import.resume_action")}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-[4px] min-w-0">
        <span className="truncate text-label font-[500] text-text-primary">
          {displayTitle}
        </span>
        <span className="truncate text-body text-text-tertiary flex items-center gap-[5px]">
          <span
            className={`inline-block h-[6px] w-[6px] rounded-full bg-text-primary shrink-0 ${
              isAwaiting || isPartial ? "" : "animate-pulse"
            }`}
          />
          <span className="truncate">{displaySubtitle}</span>
        </span>
      </div>
    </div>
  );
}
