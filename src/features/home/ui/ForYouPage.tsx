import { useCallback, useState } from "react";
import { playerEngine } from "@/features/player";
import { useStableNavigate } from "@/shared/hooks/useStableNavigate";
import { useTranslation, type TFunction } from "@/languages";
import Button from "@/shared/ui/Button";
import ScrollableRow from "@/shared/ui/ScrollableRow";
import { useForYouFeed } from "../hooks/useForYouFeed";
import type { ForYouMix } from "../lib/forYouFeed";
import type { PopularItem } from "../hooks/usePopularTracks";
import type { Track } from "@/shared/types";
import HomePageSkeleton from "./HomePageSkeleton";
import PopularTracksSection from "./PopularTracksSection";
import SectionHeading from "./SectionHeading";
import ForYouMixCard, {
  MixCoverCollage,
  uniqueCoverUrls,
} from "./ForYouMixCard";

// The For You feed (Step 8): a page built ONLY from the signed-in
// listener's own evidence — their plays, likes, shelves and the
// library's own derived analysis. Nothing here is a global chart
// and nothing is backfilled from anyone else's listening; a section
// exists only when the listener's own data supports it.
//
// Layout follows the design read's page law (ref 21): a featured
// item at the top, horizontal collections under it, smaller
// sections after, and then the page simply ends. The header is
// ref 03's pattern: a large title with a provenance line under it.

export default function ForYouPage() {
  const [attempt, setAttempt] = useState(0);
  return <ForYouFeed key={attempt} onRetry={() => setAttempt((n) => n + 1)} />;
}

function mixTitle(mix: ForYouMix, t: TFunction): string {
  switch (mix.basis.kind) {
    case "playlistGenre":
      return t("forYou.mixGenreTitle", { label: mix.basis.label });
    case "artistFamily":
      return t("forYou.mixArtistTitle", { artist: mix.basis.label });
    case "era":
      return t("forYou.mixEraTitle", { era: mix.basis.label });
    case "derivedEnergy":
      return mix.basis.label === "high"
        ? t("forYou.mixEnergyHighTitle")
        : t("forYou.mixEnergyLowTitle");
    case "derivedTempo":
      return mix.basis.label === "slow"
        ? t("forYou.mixTempoSlowTitle")
        : t("forYou.mixTempoDrivingTitle");
  }
}

function mixSubtitle(mix: ForYouMix, t: TFunction): string {
  switch (mix.basis.kind) {
    case "playlistGenre":
      return t("forYou.mixGenreSubtitle");
    case "artistFamily":
      return t("forYou.mixFamilySubtitle");
    case "era":
      return t("forYou.mixEraSubtitle");
    case "derivedEnergy":
      // An energy mix is derived from analysis, never filed by the
      // listener — it carries the derived honesty label.
      return t("forYou.moodsDerived");
    case "derivedTempo":
      // A tempo mix is derived from analysis too, so it carries the
      // same derived honesty label as the energy mix.
      return t("forYou.moodsDerived");
  }
}

function toPopularItems(tracks: readonly Track[]): PopularItem[] {
  return tracks.map((track) => ({
    type: "track" as const,
    item: track,
    playCount: track.playCount ?? 0,
  }));
}

function FeaturedMix({
  mix,
  marginTop,
}: {
  mix: ForYouMix;
  marginTop: string;
}) {
  const { t } = useTranslation();
  const covers = uniqueCoverUrls(mix.tracks);
  const title = mixTitle(mix, t);
  const subtitle = mixSubtitle(mix, t);

  const handleClick = useCallback(() => {
    const firstTrack = mix.tracks[0];
    if (!firstTrack) return;
    void playerEngine.playTrack(firstTrack, mix.tracks, title, covers[0]);
  }, [mix, title, covers]);

  return (
    <div className={`${marginTop} px-3`}>
      <div
        className="group flex w-full cursor-pointer select-none items-stretch overflow-hidden rounded-hero bg-fill"
        onClick={handleClick}
      >
        <div className="relative aspect-square w-[168px] shrink-0 overflow-hidden bg-border-alpha-14">
          <MixCoverCollage covers={covers} sizes="336px" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-[6px] p-[20px]">
          <span className="text-caption font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            {t("forYou.featuredLabel")}
          </span>
          <span className="truncate text-[24px] leading-tight font-semibold text-text-primary">
            {title}
          </span>
          <span className="truncate text-body text-text-secondary">
            {subtitle}
          </span>
          <span className="text-body text-text-tertiary">
            {mix.tracks.length} {t("library.tracks")}
          </span>
        </div>
      </div>
    </div>
  );
}

function ForYouFeed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const {
    mixes,
    becauseRows,
    genreShelves,
    moodRows,
    isLoading,
    hasAnyData,
    loadFailed,
  } = useForYouFeed();

  if (isLoading) {
    return (
      <div className="relative h-full w-full overflow-y-auto overflow-x-hidden bg-transparent pt-(--page-inset-top) pb-(--page-inset-bottom)">
        <HomePageSkeleton />
      </div>
    );
  }

  const featuredMix = mixes[0];
  const remainingMixes = mixes.slice(1);

  // Sections render in a fixed order; each claims the top margin
  // only when something sits above it (Home's margin chain).
  let above = false;
  const takeMargin = (shown: boolean) => {
    const margin = above ? "mt-[22px]" : "mt-0";
    if (shown) above = true;
    return margin;
  };
  const featuredMargin = takeMargin(featuredMix != null);
  const mixesMargin = takeMargin(remainingMixes.length > 0);
  const becauseMargins = becauseRows.map(() => takeMargin(true));
  const shelfMargins = genreShelves.map(() => takeMargin(true));
  const moodMargins = moodRows.map(() => takeMargin(true));

  const moodTitle = (kind: (typeof moodRows)[number]["kind"]): string => {
    switch (kind) {
      case "lowEnergy":
        return t("forYou.moodLowEnergy");
      case "highEnergy":
        return t("forYou.moodHighEnergy");
      case "vocalLed":
        return t("forYou.moodVocalLed");
      case "instrumental":
        return t("forYou.moodInstrumental");
    }
  };

  return (
    <div className="relative h-full w-full overflow-y-auto overflow-x-hidden bg-transparent pt-(--page-inset-top) pb-(--page-inset-bottom)">
      <div className="relative z-1 grid grid-cols-1 items-start w-full">
        {loadFailed && (
          <div className="col-start-1 row-start-1 flex min-h-[60vh] w-full flex-col items-center justify-center gap-[6px] px-[24px] text-center">
            <span className="text-title font-[600] text-text-primary">
              {t("home.load_failed")}
            </span>
            <span className="text-body text-text-secondary">
              {t("playlist.load_failed_desc")}
            </span>
            <Button
              variant="secondary"
              onClick={onRetry}
              className="mt-[10px] !h-[36px] !rounded-[10px] !border-0 px-[16px]"
            >
              {t("offline.try_again")}
            </Button>
          </div>
        )}

        {!loadFailed && !hasAnyData && (
          <div className="col-start-1 row-start-1 flex min-h-[60vh] w-full flex-col items-center justify-center gap-[6px] px-[24px] text-center">
            <span className="text-title font-[600] text-text-primary">
              {t("forYou.emptyTitle")}
            </span>
            <span className="text-body text-text-secondary">
              {t("forYou.emptyDesc")}
            </span>
            <Button
              variant="secondary"
              onClick={() => navigate("/library")}
              className="mt-[10px] !h-[36px] !rounded-[10px] !border-0 px-[16px]"
            >
              {t("home.emptyLibraryAction")}
            </Button>
          </div>
        )}

        {!loadFailed && hasAnyData && (
          <div className="col-start-1 row-start-1 w-full pb-[16px]">
            <div className="px-3 mb-[16px]">
              <h1 className="m-0 text-[26px] leading-tight font-bold tracking-tight text-text-primary">
                {t("forYou.title")}
              </h1>
              <p className="m-0 mt-[6px] text-body text-text-tertiary">
                {t("forYou.subtitle")}
              </p>
            </div>

            {featuredMix && (
              <FeaturedMix mix={featuredMix} marginTop={featuredMargin} />
            )}

            {remainingMixes.length > 0 && (
              <div className="flex flex-col">
                <SectionHeading
                  title={t("forYou.mixesTitle")}
                  marginTop={mixesMargin}
                />
                <ScrollableRow className="flex gap-[28px] pl-3 pr-3 mt-[12px] overflow-x-auto pb-[2px]">
                  {remainingMixes.map((mix) => (
                    <ForYouMixCard
                      key={mix.id}
                      mix={mix}
                      title={mixTitle(mix, t)}
                      subtitle={mixSubtitle(mix, t)}
                    />
                  ))}
                </ScrollableRow>
              </div>
            )}

            {becauseRows.map((row, index) => (
              <PopularTracksSection
                key={`because-${index}`}
                title={
                  row.seed.kind === "track"
                    ? t("forYou.becausePlayed", { title: row.seed.track.title })
                    : t("forYou.becauseArtist", { artist: row.seed.artist })
                }
                subtitle={t("forYou.becauseSubtitle")}
                items={toPopularItems(row.tracks)}
                headingMarginTop={becauseMargins[index]}
              />
            ))}

            {genreShelves.map((shelf, index) => (
              <PopularTracksSection
                key={`shelf-${shelf.kind}-${shelf.label}-${index}`}
                title={shelf.label}
                subtitle={
                  shelf.kind === "playlistGenre"
                    ? t("forYou.genreShelfSubtitle")
                    : t("forYou.genreBasicSubtitle")
                }
                items={toPopularItems(shelf.tracks)}
                headingMarginTop={shelfMargins[index]}
              />
            ))}

            {moodRows.map((row, index) => (
              <PopularTracksSection
                key={`mood-${row.kind}-${index}`}
                title={moodTitle(row.kind)}
                subtitle={t("forYou.moodsDerived")}
                items={toPopularItems(row.tracks)}
                headingMarginTop={moodMargins[index]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
