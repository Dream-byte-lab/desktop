import { useState, useEffect, useMemo } from "react";
import PopularTracksSection from "./PopularTracksSection";
import DailyMixesSection from "./DailyMixesSection";
import YourPlaylistsSection from "./YourPlaylistsSection";
import YourSavedAlbumsSection from "./YourSavedAlbumsSection";
import HomePageSkeleton, { MixesSectionSkeleton } from "./HomePageSkeleton";
import { useRecentlyPlayed } from "../hooks/useRecentlyPlayed";
import { useHeavyRotation } from "../hooks/useHeavyRotation";
import { useDailyMixes } from "../hooks/useDailyMixes";
import type { PopularItem } from "../hooks/usePopularTracks";
import {
  useExternalItems,
  useLikedTracks,
  usePlaylistsList,
} from "@/features/library/hooks";
import { useStableNavigate } from "@/shared/hooks/useStableNavigate";
import { useTranslation } from "@/languages";
import Button from "@/shared/ui/Button";
import { usePageBackdrop } from "@/shared/lib";
import { useHomeBackdrop } from "../hooks/useHomeBackdrop";
import {
  BookmarkFill,
  HeartFill,
  MusicFill,
  PlaylistFill,
  TimeFill,
} from "@mingcute/react";

// Home is personal now (user ruling, 2026-11-03): nothing on this
// page comes from global charts or anyone else's listening. Every
// rail is the signed-in listener's own data — their mixes, their
// history, their heavy rotation, their playlists, their likes and
// saves. A rail with nothing honest to show simply does not render;
// the page is never backfilled with server-generic content.

export default function HomePage() {
  const [attempt, setAttempt] = useState(0);
  return <HomeFeed key={attempt} onRetry={() => setAttempt((n) => n + 1)} />;
}

function firstCoverOf(items: PopularItem[]): string | undefined {
  for (const entry of items) {
    if (entry.item.coverUrl) return entry.item.coverUrl;
  }
  return undefined;
}

function HomeFeed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();

  const { data: dailyMixes, isLoading: mixesLoading } = useDailyMixes();
  const { data: recentlyPlayed, isLoading: recentLoading } =
    useRecentlyPlayed(20);
  const { data: heavyRotation, isLoading: heavyLoading } = useHeavyRotation(20);
  const {
    data: playlistsData,
    error: playlistsError,
    isLoading: playlistsLoading,
  } = usePlaylistsList();
  const {
    data: likedData,
    isLoading: likedLoading,
    error: likedError,
  } = useLikedTracks();
  const { data: savedAlbums, isLoading: savedAlbumsLoading } =
    useExternalItems("album");

  const hasMixes = dailyMixes.length > 0;
  const myPlaylists = playlistsData.playlists;
  const likedItems = useMemo<PopularItem[]>(
    () =>
      likedData.tracks.slice(0, 20).map((track) => ({
        type: "track" as const,
        item: track,
        playCount: track.playCount ?? 0,
      })),
    [likedData.tracks],
  );

  const homeBackdrop = useHomeBackdrop(dailyMixes);
  const usesMixBackdrop = hasMixes || mixesLoading;
  // The backdrop comes from the listener's own covers now: their
  // mixes when present, otherwise heavy rotation, then recently
  // played — never a chart album.
  const personalCover =
    firstCoverOf(heavyRotation) ?? firstCoverOf(recentlyPlayed);
  usePageBackdrop(
    usesMixBackdrop ? homeBackdrop.backdrop : personalCover,
    usesMixBackdrop ? { blur: 56, dim: 0.22 } : undefined,
  );

  const isDataLoading =
    mixesLoading ||
    recentLoading ||
    heavyLoading ||
    playlistsLoading ||
    likedLoading ||
    savedAlbumsLoading;

  const isReady = !isDataLoading;
  const nothingLoaded =
    !mixesLoading &&
    !hasMixes &&
    recentlyPlayed.length === 0 &&
    heavyRotation.length === 0 &&
    myPlaylists.length === 0 &&
    likedItems.length === 0 &&
    savedAlbums.length === 0;
  // Empty is only a failure when a personal source actually failed;
  // a fresh or guest profile with nothing yet is an honest state,
  // not an error.
  const loadFailed = nothingLoaded && (likedError || Boolean(playlistsError));
  const [skeletonExited, setSkeletonExited] = useState(() => !isDataLoading);

  useEffect(() => {
    if (isReady && !skeletonExited) {
      const timer = setTimeout(() => {
        setSkeletonExited(true);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [isReady, skeletonExited]);

  // Rails render in a fixed personal order; each claims the top
  // margin only when something personal sits above it.
  const showRecent = recentlyPlayed.length > 0;
  const showHeavy = heavyRotation.length > 0;
  const showPlaylists = myPlaylists.length > 0;
  const showLiked = likedItems.length > 0;
  const showSavedAlbums = savedAlbums.length > 0;
  let above = hasMixes || mixesLoading;
  const takeMargin = (shown: boolean) => {
    const margin = above ? "mt-[22px]" : "mt-0";
    if (shown) above = true;
    return margin;
  };
  const recentMargin = takeMargin(showRecent);
  const heavyMargin = takeMargin(showHeavy);
  const playlistsMargin = takeMargin(showPlaylists);
  const likedMargin = takeMargin(showLiked);
  const savedAlbumsMargin = takeMargin(showSavedAlbums);

  return (
    <div className="relative h-full w-full overflow-y-auto overflow-x-hidden bg-transparent pt-(--page-inset-top) pb-(--page-inset-bottom)">
      <div className="relative z-1 grid grid-cols-1 items-start w-full">
        {isReady && nothingLoaded && loadFailed && (
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

        {isReady && nothingLoaded && !loadFailed && (
          <div className="col-start-1 row-start-1 flex min-h-[60vh] w-full flex-col items-center justify-center gap-[6px] px-[24px] text-center">
            <span className="text-title font-[600] text-text-primary">
              {t("home.emptyTitle")}
            </span>
            <span className="text-body text-text-secondary">
              {t("home.emptyDesc")}
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

        {isReady && !nothingLoaded && (
          <div className="col-start-1 row-start-1 w-full pb-[16px]">
            {mixesLoading ? (
              <MixesSectionSkeleton />
            ) : (
              hasMixes && (
                <div style={{ animation: "page-enter 200ms ease-out" }}>
                  <DailyMixesSection
                    mixes={dailyMixes}
                    headingMarginTop="mt-0"
                    accentCoverUrl={homeBackdrop.cover}
                  />
                </div>
              )
            )}

            {showRecent && (
              <PopularTracksSection
                title={t("home.jumpBackIn")}
                icon={<TimeFill />}
                items={recentlyPlayed}
                headingMarginTop={recentMargin}
              />
            )}

            {showHeavy && (
              <PopularTracksSection
                title={t("home.heavyRotation")}
                icon={<MusicFill />}
                items={heavyRotation}
                headingMarginTop={heavyMargin}
              />
            )}

            {showPlaylists && (
              <YourPlaylistsSection
                title={t("home.yourPlaylists")}
                icon={<PlaylistFill />}
                playlists={myPlaylists}
                headingMarginTop={playlistsMargin}
              />
            )}

            {showLiked && (
              <PopularTracksSection
                title={t("home.yourLikedSongs")}
                icon={<HeartFill />}
                items={likedItems}
                headingMarginTop={likedMargin}
              />
            )}

            {showSavedAlbums && (
              <YourSavedAlbumsSection
                title={t("home.yourSavedAlbums")}
                icon={<BookmarkFill />}
                albums={savedAlbums}
                headingMarginTop={savedAlbumsMargin}
              />
            )}
          </div>
        )}

        {!skeletonExited && (
          <div
            className={`col-start-1 row-start-1 w-full z-10 transition-opacity duration-300 ease-out ${
              isReady
                ? "opacity-0 pointer-events-none"
                : "opacity-100 pointer-events-auto"
            }`}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget) setSkeletonExited(true);
            }}
          >
            <HomePageSkeleton />
          </div>
        )}
      </div>
    </div>
  );
}
