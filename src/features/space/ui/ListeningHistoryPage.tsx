// The Listening History page (/space/history, List) — interface
// slice S2. The one chronological door onto the merged listening
// record: day-grouped rows, newest first, loading further pages
// within the same stated bound the statistics walk uses. A failed
// first load is a failure state with retry; a failed later page
// leaves the rows on screen standing and says so.

import { useEffect, useRef } from "react";
import { useTranslation } from "@/languages";
import { ListLayout } from "@/shared/ui/layouts";
import CoverImage from "@/features/covers/ui/CoverImage";
import { useListeningHistory } from "../hooks/useListeningHistory";
import { countsAsPlay, type PlayEvent } from "../lib/listeningStats";
import { localDayStartMs, previousDayStartMs } from "../lib/listeningStats";
import { formatDay, formatPlayedMs, formatTimeOfDay } from "../lib/format";

function dayLabel(
  dayStartMs: number,
  locale: string,
  nowMs: number,
  t: (key: string) => string,
): string {
  const today = localDayStartMs(nowMs);
  if (dayStartMs === today) return t("space.history.today");
  if (dayStartMs === previousDayStartMs(today))
    return t("space.history.yesterday");
  return formatDay(dayStartMs, locale, nowMs);
}

function HistoryRow({ event, locale }: { event: PlayEvent; locale: string }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-3 py-[8px]">
      <div className="h-[44px] w-[44px] shrink-0 overflow-hidden rounded-[8px] bg-border-alpha-14">
        {event.track.coverUrl ? (
          <CoverImage
            src={event.track.coverUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium text-text-primary">
          {event.track.title}
        </span>
        <span className="truncate text-caption text-text-tertiary">
          {event.track.artists}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-[2px]">
        <span className="text-body text-text-secondary tabular-nums">
          {formatTimeOfDay(event.listenedAtMs, locale)}
        </span>
        <span className="text-caption text-text-tertiary tabular-nums">
          {t("space.history.playedFor", {
            duration: formatPlayedMs(event.playedDurationMs),
          })}
          {event.loopCount > 0
            ? ` · ${t("space.history.looped", { count: event.loopCount })}`
            : ""}
          {event.skipped
            ? ` · ${t("space.history.skipped")}`
            : !countsAsPlay(event)
              ? ` · ${t("space.history.brief")}`
              : ""}
        </span>
      </div>
    </li>
  );
}

export default function ListeningHistoryPage() {
  const { t, locale } = useTranslation();
  const state = useListeningHistory();
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const now = Date.now();

  const hasMore = state.status === "ready" && state.hasMore;
  const loadingMore = state.status === "ready" && state.loadingMore;
  const loadMore = state.status === "ready" ? state.loadMore : () => undefined;

  // Continue on scroll when the sentinel approaches; the button
  // below remains the always-available path (and the only one
  // where IntersectionObserver does not exist).
  useEffect(() => {
    if (!hasMore || loadingMore) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, loadMore]);

  return (
    <div className="flex w-full flex-col gap-[24px]">
      <div className="flex flex-col gap-[6px] px-3">
        <h1 className="text-[30px] leading-tight font-semibold text-text-primary">
          {t("space.history.title")}
        </h1>
        {state.status === "ready" && state.totalEvents > 0 && (
          <p className="text-body text-text-secondary tabular-nums">
            {t("space.history.count", { count: state.totalEvents })}
          </p>
        )}
      </div>

      {state.status === "loading" && (
        <p className="px-3 text-body text-text-tertiary">
          {t("space.loading")}
        </p>
      )}

      {state.status === "failed" && (
        <div className="flex flex-col items-start gap-[10px] px-3">
          <p className="text-body text-text-secondary">{t("space.failed")}</p>
          <button
            type="button"
            onClick={state.retry}
            className="rounded-full bg-fill px-4 py-2 text-body font-medium text-text-primary"
          >
            {t("space.retry")}
          </button>
        </div>
      )}

      {state.status === "ready" && state.totalEvents === 0 && (
        <p className="px-3 text-body text-text-secondary">
          {t("space.history.empty")}
        </p>
      )}

      {state.status === "ready" &&
        state.groups.map((group) => (
          <section key={group.dayStartMs} className="flex flex-col px-3">
            <h2 className="pb-[4px] text-title font-[600] text-text-primary">
              {dayLabel(group.dayStartMs, locale, now, t)}
            </h2>
            <ListLayout divided>
              {group.events.map((event, i) => (
                <HistoryRow
                  key={`${event.listenedAtMs}-${event.track.id}-${i}`}
                  event={event}
                  locale={locale}
                />
              ))}
            </ListLayout>
          </section>
        ))}

      {state.status === "ready" && state.totalEvents > 0 && (
        <div className="flex flex-col items-center gap-[8px] px-3 pb-[12px]">
          <div ref={sentinelRef} />
          {state.loadMoreFailed && (
            <p className="text-body text-text-tertiary">
              {t("space.history.moreFailed")}
            </p>
          )}
          {state.hasMore ? (
            <button
              type="button"
              onClick={state.loadMore}
              disabled={state.loadingMore}
              className="rounded-full bg-fill px-4 py-2 text-body font-medium text-text-primary disabled:opacity-50"
            >
              {state.loadingMore
                ? t("space.history.loadingMore")
                : t("space.history.loadMore")}
            </button>
          ) : state.boundReached ? (
            <p className="text-body text-text-tertiary">
              {t("space.history.boundNote")}
            </p>
          ) : (
            <p className="text-body text-text-tertiary">
              {t("space.history.endNote")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
