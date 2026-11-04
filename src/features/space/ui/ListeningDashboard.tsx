// The Your Space dashboard (/space, Editorial) — interface slice
// S2. Every number on this page is the listener's own, computed by
// the pure aggregator over the merged server+device record, and
// the coverage line states the denominator in plain words: how
// many plays, which span came from the account history, and which
// from this device. Sections render only from data that exists —
// nothing is padded, nothing is zero-filled, and global numbers
// never appear here.

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "@/languages";
import { EditorialLayout } from "@/shared/ui/layouts";
import CoverImage from "@/features/covers/ui/CoverImage";
import {
  collectionPath,
  collectionPreviewState,
} from "@/features/collection/lib/collectionPreview";
import { useStableNavigate } from "@/shared/hooks/useStableNavigate";
import { useListeningStats } from "../hooks/useListeningStats";
import {
  THIN_FLOOR_COUNTED_PLAYS,
  type ListeningStats,
  type MovementEntry,
} from "../lib/listeningStats";
import { formatDay } from "../lib/format";

/** The artist page's route, built the way every other surface
 * builds it (CollectionPage, SearchPage, the deeplink handler). */
function artistHref(artistId: string): string {
  return `/artist?id=${encodeURIComponent(artistId)}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[14px] px-3">
      <h2 className="text-title font-[600] text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

function CoverageLine({
  stats,
  stale,
  refreshFailed,
  onRetry,
}: {
  stats: ListeningStats;
  stale: boolean;
  refreshFailed: boolean;
  onRetry: () => void;
}) {
  const { t, locale } = useTranslation();
  const now = Date.now();
  const c = stats.coverage;
  const parts: string[] = [
    t("space.coverage.plays", { count: stats.countedPlays }),
  ];
  if (c.serverEvents > 0 && c.serverFromMs !== null) {
    parts.push(
      c.deviceStartMs !== null
        ? t("space.coverage.accountTo", {
            date: formatDay(c.deviceStartMs, locale, now),
          })
        : t("space.coverage.accountSince", {
            date: formatDay(c.serverFromMs, locale, now),
          }),
    );
  }
  if (c.deviceStartMs !== null) {
    parts.push(
      t("space.coverage.deviceSince", {
        date: formatDay(c.deviceStartMs, locale, now),
      }),
    );
  }
  if (!c.complete) {
    parts.push(
      c.truncatedBy === "months"
        ? t("space.coverage.monthsLimit", { months: 13 })
        : t("space.coverage.recentLimit", { count: 2000 }),
    );
  }
  return (
    <div className="flex flex-col gap-[4px]">
      <p className="text-body text-text-secondary tabular-nums">
        {parts.join(" · ")}
      </p>
      {refreshFailed ? (
        <p className="text-body text-text-tertiary">
          {t("space.coverage.refreshFailed")}{" "}
          <button
            type="button"
            onClick={onRetry}
            className="text-text-secondary underline underline-offset-2"
          >
            {t("space.retry")}
          </button>
        </p>
      ) : stale ? (
        <p className="text-body text-text-tertiary">
          {t("space.coverage.stale")}
        </p>
      ) : null}
    </div>
  );
}

function TotalTime({ ms }: { ms: number }) {
  const { t } = useTranslation();
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return <>{t("space.totalTime.minutes", { minutes })}</>;
  return <>{t("space.totalTime.hoursMinutes", { hours, minutes })}</>;
}

function MovementList({ entries }: { entries: MovementEntry[] }) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <ul className="flex flex-col gap-[6px]">
      {entries.map((entry) => {
        const delta =
          entry.previousRank === null || entry.currentRank === null
            ? null
            : entry.previousRank - entry.currentRank;
        return (
          <li
            key={entry.label}
            className="flex items-baseline justify-between gap-3"
          >
            {entry.artistId ? (
              <Link
                to={artistHref(entry.artistId)}
                className="min-w-0 truncate text-body text-text-primary no-underline underline-offset-2 cursor-pointer hover:underline"
              >
                {entry.label}
              </Link>
            ) : (
              <span className="min-w-0 truncate text-body text-text-primary">
                {entry.label}
              </span>
            )}
            <span className="shrink-0 text-body text-text-tertiary tabular-nums">
              {entry.currentRank === null
                ? t("space.movement.gone")
                : entry.previousRank === null
                  ? t("space.movement.new")
                  : delta !== null && delta > 0
                    ? `↑ ${delta}`
                    : delta !== null && delta < 0
                      ? `↓ ${-delta}`
                      : "→"}
              {" · "}
              {t("space.coverage.plays", { count: entry.currentPlays })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ReadyDashboard({ stats }: { stats: ListeningStats }) {
  const { t } = useTranslation();
  const joins = stats.joins;
  return (
    <>
      {stats.topArtists.length > 0 && (
        <Section title={t("space.topArtists")}>
          <div className="flex flex-wrap gap-[18px]">
            {stats.topArtists.map((artist) => {
              const portrait = (
                <>
                  <div className="h-[72px] w-[72px] overflow-hidden rounded-full bg-border-alpha-14">
                    {artist.coverUrl ? (
                      <CoverImage
                        src={artist.coverUrl}
                        alt=""
                        className="h-full w-full object-cover transition-all duration-300 group-hover:brightness-[1.15]"
                      />
                    ) : null}
                  </div>
                  <span className="w-full truncate text-body font-medium text-text-primary">
                    {artist.name}
                  </span>
                  <span className="text-caption text-text-tertiary tabular-nums">
                    {t("space.coverage.plays", { count: artist.plays })}
                  </span>
                </>
              );
              // A portrait with a resolved artist id is a door to the
              // artist page (the AlbumCard whole-tile Link idiom);
              // without one it stays a plain portrait — never a
              // guessed link.
              return artist.artistId ? (
                <Link
                  key={artist.name}
                  to={artistHref(artist.artistId)}
                  className="group flex w-[96px] flex-col items-center gap-[6px] text-center no-underline cursor-pointer"
                >
                  {portrait}
                </Link>
              ) : (
                <div
                  key={artist.name}
                  className="flex w-[96px] flex-col items-center gap-[6px] text-center"
                >
                  {portrait}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {stats.topTracks.length > 0 && (
        <Section title={t("space.topTracks")}>
          <ol className="flex flex-col">
            {stats.topTracks.map((entry, i) => {
              // A song's page, as the app defines it: there is no
              // track route — a song opens on its album's collection
              // page (the deeplink handler resolves albums the same
              // way). A track whose album carries no id has no page
              // to go to and its row stays plain.
              const albumId = entry.track.album?.id;
              const identity = (
                <>
                  <div className="h-[40px] w-[40px] shrink-0 overflow-hidden rounded-[8px] bg-border-alpha-14">
                    {entry.track.coverUrl ? (
                      <CoverImage
                        src={entry.track.coverUrl}
                        alt=""
                        className="h-full w-full object-cover transition-all duration-300 group-hover:brightness-[1.15]"
                      />
                    ) : null}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-medium text-text-primary">
                      {entry.track.title}
                    </span>
                    <span className="truncate text-caption text-text-tertiary">
                      {entry.track.artists}
                    </span>
                  </div>
                </>
              );
              return (
                <li
                  key={entry.track.id}
                  className="flex items-center gap-3 py-[6px]"
                >
                  <span className="w-[22px] shrink-0 text-body text-text-tertiary tabular-nums">
                    {i + 1}
                  </span>
                  {albumId ? (
                    <Link
                      to={collectionPath("album", albumId)}
                      state={collectionPreviewState({
                        coverUrl: entry.track.coverUrl,
                        title: entry.track.title,
                        subtitle: entry.track.artists,
                      })}
                      className="group flex min-w-0 flex-1 items-center gap-3 no-underline cursor-pointer"
                    >
                      {identity}
                    </Link>
                  ) : (
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      {identity}
                    </div>
                  )}
                  <span className="shrink-0 text-body text-text-tertiary tabular-nums">
                    {t("space.coverage.plays", { count: entry.plays })}
                  </span>
                </li>
              );
            })}
          </ol>
        </Section>
      )}

      <Section title={t("space.listeningTime")}>
        <p className="text-[28px] leading-tight font-semibold text-text-primary tabular-nums">
          <TotalTime ms={stats.totalListeningMs} />
        </p>
        <div className="flex flex-wrap gap-x-[26px] gap-y-[6px] text-body text-text-secondary tabular-nums">
          <span>{t("space.stat.activeDays", { count: stats.activeDays })}</span>
          {stats.currentStreakDays > 1 && (
            <span>
              {t("space.stat.streak", { count: stats.currentStreakDays })}
            </span>
          )}
          {stats.skipRate !== null && (
            <span>{t("space.stat.skips", { count: stats.skipCount })}</span>
          )}
          {(stats.loopCount > 0 || stats.replayCount > 0) && (
            <span>
              {t("space.stat.repeats", {
                count: stats.loopCount + stats.replayCount,
              })}
            </span>
          )}
        </div>
      </Section>

      {(stats.playlistGenres.length > 0 || stats.basicGenres.length > 0) && (
        <Section title={t("space.genres.title")}>
          {stats.playlistGenres.length > 0 && (
            <>
              <h3 className="text-caption font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                {t("space.genres.playlistGenres")}
              </h3>
              <ul className="flex flex-col gap-[6px]">
                {stats.playlistGenres.map((g) => (
                  <li
                    key={g.label}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="min-w-0 truncate text-body text-text-primary">
                      {g.label}
                    </span>
                    <span className="shrink-0 text-body text-text-tertiary tabular-nums">
                      {t("space.coverage.plays", { count: g.plays })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {stats.basicGenres.length > 0 ? (
            <>
              <h3 className="text-caption font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                {t("space.genres.basicGenres")}
              </h3>
              <ul className="flex flex-col gap-[6px]">
                {stats.basicGenres.map((g) => (
                  <li
                    key={g.label}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="min-w-0 truncate text-body text-text-primary">
                      {g.label}
                    </span>
                    <span className="shrink-0 text-body text-text-tertiary tabular-nums">
                      {t("space.coverage.plays", { count: g.plays })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-body text-text-tertiary">
              {t("space.genres.basicUnavailable")}
            </p>
          )}
        </Section>
      )}

      {stats.movement &&
        (stats.movement.artists.length > 0 ||
          stats.movement.playlistGenres.length > 0) && (
          <Section title={t("space.movement.title")}>
            <p className="text-body text-text-tertiary">
              {t("space.movement.subtitle")}
            </p>
            <MovementList entries={stats.movement.artists} />
            <MovementList entries={stats.movement.playlistGenres} />
          </Section>
        )}

      {joins && (
        <Section title={t("space.dj.title")}>
          <div className="flex flex-wrap gap-x-[26px] gap-y-[6px] text-body text-text-secondary tabular-nums">
            <span>{t("space.dj.joins", { count: joins.performed })}</span>
            {joins.averageGrade !== null && (
              <span>
                {t("space.dj.grade", {
                  percent: Math.round(joins.averageGrade * 100),
                })}
              </span>
            )}
          </div>
        </Section>
      )}
    </>
  );
}

function GuestDashboard({
  summary,
}: {
  summary: import("../lib/listeningStats").GuestSpaceSummary;
}) {
  const { t, locale } = useTranslation();
  const now = Date.now();
  const maxWeight = summary.tasteTopArtists[0]?.weight ?? 0;
  return (
    <>
      <p className="px-3 text-body text-text-secondary">
        {t("space.guest.body")}
      </p>
      {summary.tasteTopArtists.length > 0 && (
        <Section title={t("space.guest.topArtists")}>
          <ul className="flex flex-col gap-[8px]">
            {summary.tasteTopArtists.map((artist) => (
              <li key={artist.artist} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-body text-text-primary">
                  {artist.artist}
                </span>
                <span className="h-[6px] w-[120px] shrink-0 overflow-hidden rounded-full bg-border-alpha-14">
                  <span
                    className="block h-full rounded-full bg-text-tertiary"
                    style={{
                      width:
                        maxWeight > 0
                          ? `${Math.round((artist.weight / maxWeight) * 100)}%`
                          : "0%",
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {summary.device && (
        <Section title={t("space.guest.deviceTitle")}>
          <div className="flex flex-wrap gap-x-[26px] gap-y-[6px] text-body text-text-secondary tabular-nums">
            <span>
              {t("space.coverage.plays", {
                count: summary.device.countedPlays,
              })}
            </span>
            <span>
              <TotalTime ms={summary.device.listeningMs} />
            </span>
            <span>
              {t("space.coverage.deviceSince", {
                date: formatDay(summary.device.sinceMs, locale, now),
              })}
            </span>
          </div>
        </Section>
      )}
    </>
  );
}

function ThinState() {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  return (
    <div className="flex flex-col items-start gap-[10px] px-3">
      <p className="text-title font-[600] text-text-primary">
        {t("space.thin.title")}
      </p>
      <p className="max-w-[520px] text-body text-text-secondary">
        {t("space.thin.body")}
      </p>
      <div className="flex gap-[10px]">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-full bg-fill px-4 py-2 text-body font-medium text-text-primary"
        >
          {t("space.thin.home")}
        </button>
        <button
          type="button"
          onClick={() => navigate("/for-you")}
          className="rounded-full bg-fill px-4 py-2 text-body font-medium text-text-primary"
        >
          {t("space.thin.forYou")}
        </button>
      </div>
    </div>
  );
}

export default function ListeningDashboard() {
  const { t } = useTranslation();
  const state = useListeningStats();

  return (
    <EditorialLayout
      hero={
        <div className="flex flex-col gap-[6px] px-3">
          <h1 className="text-[30px] leading-tight font-semibold text-text-primary">
            {t("space.title")}
          </h1>
          {state.status === "ready" && (
            <CoverageLine
              stats={state.stats}
              stale={state.stale}
              refreshFailed={state.refreshFailed}
              onRetry={state.retry}
            />
          )}
        </div>
      }
    >
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
      {state.status === "guest" && <GuestDashboard summary={state.summary} />}
      {state.status === "ready" &&
        (state.stats.countedPlays < THIN_FLOOR_COUNTED_PLAYS ? (
          <ThinState />
        ) : (
          <ReadyDashboard stats={state.stats} />
        ))}
    </EditorialLayout>
  );
}
