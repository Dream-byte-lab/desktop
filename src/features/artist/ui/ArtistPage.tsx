import { useSearchParams } from "react-router-dom";
import {
  useEffect,
  useState,
  Suspense,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { PlayFill, ShareForwardLine, CheckLine } from "@mingcute/react";
import { LuShuffle } from "react-icons/lu";
import SongCardWithMenu from "@/features/player/ui/SongCardWithMenu";
import AlbumCard from "@/features/collection/ui/AlbumCard";
import ReleaseCard from "@/features/collection/ui/ReleaseCard";
import CoverImage from "@/features/covers/ui/CoverImage";
import { preloadCoverArt } from "@/features/covers/lib/coverArt";
import { playerEngine } from "@/features/player";
import { AnimatePresence, motion } from "framer-motion";
import type { Track } from "@/shared/types";
import {
  useToast,
  HERO_BUTTON_CLASS,
  HERO_GLASS_BUTTON_CLASS,
} from "@/shared/ui";
import { usePageBackdrop } from "@/shared/lib";
import { useTranslation } from "@/languages";
import { useModalStore } from "@/features/library";
import { buildShareUrl } from "@/shared/utils/share";
import { useStableNavigate } from "@/shared/hooks/useStableNavigate";
import { collectionPath } from "@/features/collection/lib/collectionPreview";
import { useExternalItems, useLikedTracks } from "@/features/library/hooks";
import { stripMarkdown } from "./ArtistAboutText";
import ArtistProfileModal from "./ArtistProfileModal";
import ArtistPageSkeleton from "./ArtistPageSkeleton";
import {
  useArtist,
  type ArtistPageData,
  type SimilarArtistViewModel,
} from "../hooks/useArtist";
import { artistAudience } from "../lib/audience";
import { useArtistAppearances } from "../hooks/useArtistAppearances";
import { useArtistAvatar } from "../hooks/useArtistAvatar";

// The artist page, recomposed after the user's reference (a
// Spotify-style artist profile): a full-bleed hero from the
// artist's own image, the tab row (Popular / Discography / About),
// numbered Popular rows, grid discography.
//
// Data honesty, per the Step 0 inventory — every element below maps
// to a field the catalogue actually supplies:
//  - the hero banner and the avatar are the ONE artist image the
//    API carries (cover); no separate banner field exists.
//  - monthly listeners exist only for YouTube-sourced artists;
//    SoundCloud artists fall back to their follower count (the
//    page's standing audience-label rule).
//  - per-track play counts exist only where the source publishes
//    them (SoundCloud's playback_count, plumbed onto the track by
//    the catalogue mapper); rows without one render no count.
//  - the similar-artists tab is fed by the catalogue itself: the
//    source's own similar shelf where it publishes one (labelled
//    "Fans also like", the source's heading for its own data), or
//    the artists of the source's related-tracks graph (labelled
//    "Similar artists" — relatedness data, never fan data).
//  - the "Appears On" tab is a derivation from the catalogue's
//    own search: tracks where the catalogue credits this artist's
//    id in a non-lead slot. It can understate, never invent.
//  - the card in the reference's "Artist Pick" position is the
//    artist's newest dated release in the catalogue, labelled
//    "Latest release" — the artist picked nothing, so the card
//    never claims they did.
//  - touring and the reference's right rail (listener cities,
//    tour dates) still have NO data source anywhere in the
//    catalogue — no events feed, no listener geography — so the
//    "On Tour" tab and the rail are omitted, never dressed up.
//  - the "Liked Songs" card is the listener's own library: the
//    liked tracks attributed to this artist, counted from the
//    liked-tracks list, and it plays exactly those tracks.
//  - follow state is the app's one follow mechanism (the saved-
//    artists library shelf), toggled through the library modal
//    flow — the same binding the search hero uses.

function VerifiedBadge({ size = 22 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      style={{ height: size, width: size }}
      className="shrink-0 text-[#1d9bf0]"
      fill="currentColor"
      aria-label="Verified"
    >
      <path d="M10.007 2.10377C8.60544 1.65006 7.08181 2.28116 6.41156 3.59306L5.60578 5.17023C5.51004 5.35763 5.35763 5.51004 5.17023 5.60578L3.59306 6.41156C2.28116 7.08181 1.65006 8.60544 2.10377 10.007L2.64923 11.692C2.71404 11.8922 2.71404 12.1078 2.64923 12.308L2.10377 13.993C1.65006 15.3946 2.28116 16.9182 3.59306 17.5885L5.17023 18.3942C5.35763 18.49 5.51004 18.6424 5.60578 18.8298L6.41156 20.407C7.08181 21.7189 8.60544 22.35 10.007 21.8963L11.692 21.3508C11.8922 21.286 12.1078 21.286 12.308 21.3508L13.993 21.8963C15.3946 22.35 16.9182 21.7189 17.5885 20.407L18.3942 18.8298C18.49 18.6424 18.6424 18.49 18.8298 18.3942L20.407 17.5885C21.7189 16.9182 22.35 15.3946 21.8963 13.993L21.3508 12.308C21.286 12.1078 21.286 11.8922 21.3508 11.692L21.8963 10.007C22.35 8.60544 21.7189 7.08181 20.407 6.41156L18.8298 5.60578C18.6424 5.51004 18.49 5.35763 18.3942 5.17023L17.5885 3.59306C16.9182 2.28116 15.3946 1.65006 13.993 2.10377L12.308 2.64923C12.1078 2.71403 11.8922 2.71404 11.692 2.64923L10.007 2.10377Z" />
      <path
        d="M6.75977 11.7573L8.17399 10.343L11.0024 13.1715L16.6593 7.51465L18.0735 8.92886L11.0024 15.9999L6.75977 11.7573Z"
        fill="#ffffff"
        transform="translate(-0.42 0.24)"
      />
    </svg>
  );
}

function formatDuration(durationMs?: number): string | undefined {
  if (!durationMs) return undefined;
  const mins = Math.floor(durationMs / 60000);
  const secs = Math.floor((durationMs % 60000) / 1000)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatPlayCount(playCount?: number): string | undefined {
  if (!playCount || playCount <= 0) return undefined;
  return Intl.NumberFormat("en-US").format(playCount);
}

type ArtistTab = "popular" | "discography" | "similar" | "appears-on" | "about";

function SimilarArtistCard({ artist }: { artist: SimilarArtistViewModel }) {
  const navigate = useStableNavigate();
  // Entries from the source's own shelf carry their cover; the
  // related-tracks derivation carries none, so those resolve
  // through the app's artist-avatar machinery — the same route
  // every other artist image in the app takes.
  const avatar = useArtistAvatar(artist.coverUrl ? undefined : artist.id);
  const src = artist.coverUrl || avatar || "";
  const open = () => navigate(`/artist?id=${encodeURIComponent(artist.id)}`);
  return (
    <div className="flex w-[104px] shrink-0 flex-col items-center gap-[8px]">
      <button
        type="button"
        onClick={open}
        className="relative block h-[96px] w-[96px] cursor-pointer overflow-hidden rounded-full border-none bg-border-alpha-14 p-0"
        aria-label={artist.name}
      >
        {src ? (
          <CoverImage
            src={src}
            alt={artist.name}
            fill
            sizes="96px"
            className="object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[34px] font-[700] text-border-alpha-33">
            {artist.name.charAt(0)}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={open}
        className="max-w-full cursor-pointer truncate border-none bg-transparent p-0 text-label font-[500] text-text-primary"
      >
        {artist.name}
      </button>
    </div>
  );
}

const BANNER_FADE_MASK =
  "linear-gradient(to bottom, black 84%, transparent 100%)";

function ArtistContent() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const id = searchParams.get("id");

  const { data, loading } = useArtist(id);
  usePageBackdrop(data?.coverUrl);
  const [showAllTracks, setShowAllTracks] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ArtistTab>("popular");
  const [imagesLoaded, setImagesLoaded] = useState(() => !loading && !!data);
  const [skeletonExited, setSkeletonExited] = useState(
    () => !loading && !!data,
  );
  const shownIdRef = useRef(id);
  const scrollRef = useRef<HTMLDivElement>(null);

  const decodedId = id ? decodeURIComponent(id) : "";
  const { data: savedArtists } = useExternalItems("artist");
  const inLibrary = savedArtists.some((artist) => artist.id === decodedId);

  // The listener's own liked tracks attributed to this artist —
  // by catalogue artist id only, never by name matching, so the
  // count can understate but never invent.
  const { data: likedData } = useLikedTracks();
  const likedByArtist = useMemo(() => {
    if (!decodedId) return [];
    return (likedData?.tracks ?? []).filter(
      (track) =>
        track.artistId === decodedId ||
        track.artistList?.some((artist) => artist.id === decodedId),
    );
  }, [likedData, decodedId]);

  const navigate = useStableNavigate();

  // Appearances: catalogue tracks crediting this artist in a
  // non-lead slot (see useArtistAppearances for the derivation).
  // Tracks already in the artist's own list are not appearances
  // "on" anything — they live under Popular.
  const { data: appearanceData } = useArtistAppearances(
    decodedId || null,
    data?.title ?? null,
  );
  const appearances = useMemo(() => {
    const ownIds = new Set((data?.tracks ?? []).map((track) => track.id));
    return (appearanceData ?? []).filter((track) => !ownIds.has(track.id));
  }, [appearanceData, data]);

  // The card in the reference's "Artist Pick" position, honestly
  // derived: the artist's newest DATED release in the catalogue.
  // The artist picked nothing, so the card is labelled "Latest
  // release" — exactly what it is. Undated releases cannot be
  // ordered, so an artist with no dated release gets no card.
  const latestRelease = useMemo(() => {
    if (!data) return null;
    const candidates = [
      ...data.albums.map((album) => ({
        id: album.id,
        title: album.title,
        coverUrl: album.coverUrl,
        year: album.releaseDate ?? "",
        kind: "album" as const,
        kindKey: "artist.release_album",
        totalTracks: album.totalTracks,
      })),
      ...data.singles.map((single) => ({
        id: single.id,
        title: single.title,
        coverUrl: single.coverUrl,
        year: single.releaseDate ?? "",
        kind: single.releaseType,
        kindKey:
          single.releaseType === "ep"
            ? "artist.release_ep"
            : "artist.release_single",
        totalTracks: single.totalTracks,
      })),
    ].filter((release) => /^\d{4}$/.test(release.year));
    if (candidates.length === 0) return null;
    // Albums win ties: candidates are ordered albums-first and
    // the scan replaces only on a strictly newer year.
    let newest = candidates[0];
    for (const release of candidates.slice(1)) {
      if (release.year > newest.year) newest = release;
    }
    return newest;
  }, [data]);

  const urlsToPreload = useMemo(() => {
    if (!data) return [];
    const urls = new Set<string>();
    if (data.coverUrl) urls.add(data.coverUrl);
    return Array.from(urls);
  }, [data]);

  useEffect(() => {
    if (loading || !data) {
      setImagesLoaded(false);
      setSkeletonExited(false);
      return;
    }
    if (urlsToPreload.length === 0) {
      setImagesLoaded(true);
      return;
    }
    let active = true;
    let settled = false;
    const timer = setTimeout(() => {
      if (active && !settled) {
        settled = true;
        setImagesLoaded(true);
      }
    }, 300);

    const promises = urlsToPreload.map((url) => preloadCoverArt(url));

    Promise.all(promises).then(() => {
      if (active && !settled) {
        settled = true;
        clearTimeout(timer);
        setImagesLoaded(true);
      }
    });

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [loading, data, urlsToPreload]);

  const isReady = !loading && !!data && imagesLoaded;

  useEffect(() => {
    if (isReady && !skeletonExited) {
      const timer = setTimeout(() => {
        setSkeletonExited(true);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [isReady, skeletonExited]);

  useEffect(() => {
    if (shownIdRef.current === id) return;
    shownIdRef.current = id;
    setShowAllTracks(false);
    setActiveTab("popular");
    setIsProfileModalOpen(false);
    setImagesLoaded(false);
    setSkeletonExited(false);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [id]);

  const handlePlayAll = () => {
    if (!data || data.tracks.length === 0) return;
    const [first] = data.tracks;
    playerEngine.clearQueue();
    playerEngine.playTrack(first, data.tracks, data.title, data.coverUrl);
  };

  const handlePlayLiked = () => {
    if (!data || likedByArtist.length === 0) return;
    const [first] = likedByArtist;
    playerEngine.clearQueue();
    playerEngine.playTrack(first, likedByArtist, data.title, data.coverUrl);
  };

  const handleShufflePlay = useCallback(() => {
    if (!data || data.tracks.length === 0) return;
    playerEngine.clearQueue();
    void playerEngine.playShuffled(data.tracks, data.title, data.coverUrl);
  }, [data]);

  const { toast } = useToast();

  const handleSaveToLibrary = () => {
    if (!data || !id) return;
    const decoded = decodeURIComponent(id);
    if (inLibrary) {
      useModalStore.getState().openRemoveFromLibrary({
        id: decoded,
        title: data.title,
        coverUrl: data.coverUrl,
        type: "artist",
      });
    } else {
      useModalStore.getState().openAddToLibrary({
        id: decoded,
        title: data.title,
        coverUrl: data.coverUrl,
        type: "artist",
      });
    }
  };

  const handleShare = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard && decodedId) {
      navigator.clipboard.writeText(buildShareUrl("artist", decodedId));
      toast(t("common.link_copied"), "checkmark", {
        description: data?.title || undefined,
      });
    }
  };

  if (!loading && !data) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-transparent">
        <span className="text-text-secondary">
          {t("artist.artist_not_found")}
        </span>
      </div>
    );
  }

  const audience = data ? artistAudience(data) : null;
  const audienceLabel = audience
    ? audience.kind === "monthly"
      ? t("artist.monthly_audience", { count: audience.count })
      : `${audience.count} ${t("artist.followers")}`
    : null;

  const iconButtonClass = `${HERO_BUTTON_CLASS} ${HERO_GLASS_BUTTON_CLASS} !w-[52px] !p-0 text-text-primary`;
  const sectionTitleClass = "text-[22px] font-[500] text-text-primary m-0";

  const hasDiscography = Boolean(
    data && (data.albums.length > 0 || data.singles.length > 0),
  );
  const hasAbout = Boolean(
    data &&
    (data.description ||
      data.geniusImageUrl ||
      data.geniusUsername ||
      (data.geniusAka && data.geniusAka.length > 0)),
  );
  const similarArtists = data?.similarArtists ?? [];
  const tabs: { key: ArtistTab; label: string }[] = data
    ? [
        { key: "popular", label: t("artist.popular_songs") },
        ...(hasDiscography
          ? [
              {
                key: "discography" as ArtistTab,
                label: t("artist.discography"),
              },
            ]
          : []),
        ...(similarArtists.length > 0
          ? [
              {
                key: "similar" as ArtistTab,
                // The label follows the data's provenance: the
                // source's own fan shelf keeps the source's
                // heading; the related-tracks derivation is
                // labelled what it is.
                label:
                  data.similarArtistsBasis === "fans"
                    ? t("artist.fans_also_like")
                    : t("artist.similar_artists"),
              },
            ]
          : []),
        ...(appearances.length > 0
          ? [
              {
                key: "appears-on" as ArtistTab,
                label: t("artist.appears_on"),
              },
            ]
          : []),
        ...(hasAbout
          ? [{ key: "about" as ArtistTab, label: t("artist.about_artist") }]
          : []),
      ]
    : [];
  const effectiveTab = tabs.some((tab) => tab.key === activeTab)
    ? activeTab
    : "popular";

  const renderTrack = (track: Track, index: number) =>
    data && (
      <SongCardWithMenu
        key={track.id}
        id={track.id}
        title={track.title}
        artists={track.artists}
        artistId={track.artistId}
        artistList={track.artistList}
        coverUrl={track.coverUrl || data.coverUrl}
        duration={formatDuration(track.durationMs)}
        durationMs={track.durationMs}
        explicit={track.explicit}
        trackNumber={index + 1}
        showCoverWithNumber
        playCount={formatPlayCount(track.playCount)}
        onPlay={() =>
          playerEngine.playTrack(track, data.tracks, data.title, data.coverUrl)
        }
      />
    );

  const renderHero = (artist: ArtistPageData) => (
    <section className="relative" aria-label={artist.title}>
      {/* The banner is the artist's own image as a static raster,
          dissolved at its foot by a gradient mask into the page's
          blurred-cover backdrop — no backdrop-filter, per the
          project's glass/performance rules. */}
      <div className="relative h-[clamp(250px,38vh,330px)] w-full overflow-hidden bg-bg-panel">
        <div
          className="absolute inset-0"
          style={{
            maskImage: BANNER_FADE_MASK,
            WebkitMaskImage: BANNER_FADE_MASK,
          }}
        >
          {artist.coverUrl ? (
            <CoverImage
              src={artist.coverUrl}
              alt={artist.title}
              fill
              sizes="100vw"
              className="object-cover"
              draggable={false}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <span className="text-[96px] font-[700] text-border-alpha-33">
                {artist.title.charAt(0)}
              </span>
            </div>
          )}
        </div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
      </div>

      <div className="absolute inset-x-0 bottom-[24px] flex items-end gap-[22px] px-[28px]">
        <div className="relative h-[128px] w-[128px] shrink-0 overflow-hidden rounded-full bg-bg-panel shadow-[0_18px_44px_rgba(0,0,0,0.45)] ring-1 ring-white/30">
          {artist.coverUrl ? (
            <CoverImage
              src={artist.coverUrl}
              alt={artist.title}
              fill
              sizes="128px"
              className="object-cover"
              draggable={false}
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[52px] font-[700] text-border-alpha-33">
              {artist.title.charAt(0)}
            </span>
          )}
        </div>
        <div className="min-w-0 pb-[4px]">
          {artist.verified ? (
            <div className="mb-[8px] flex items-center gap-[7px] text-white">
              <VerifiedBadge size={19} />
              <span className="text-[13px] font-[600] tracking-[0.03em]">
                {t("artist.verified_artist")}
              </span>
            </div>
          ) : null}
          <h1 className="m-0 truncate text-[clamp(38px,5.6vw,68px)] leading-[1.04] font-[800] tracking-tight text-white">
            {artist.title}
          </h1>
          {audienceLabel ? (
            <p className="m-0 mt-[10px] text-[14px] font-[500] text-white/85">
              {audienceLabel}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );

  const renderActions = (artist: ArtistPageData) => (
    <div className="flex items-center gap-[14px] px-[28px] pt-[20px]">
      <button
        type="button"
        onClick={handlePlayAll}
        disabled={artist.tracks.length === 0}
        aria-label={t("artist.play")}
        title={t("artist.play")}
        className="flex h-[56px] w-[56px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-accent-primary text-white shadow-[0_10px_28px_rgba(0,0,0,0.35)] transition-transform duration-150 hover:scale-[1.05] active:scale-[0.96] disabled:cursor-default disabled:opacity-50 disabled:hover:scale-100"
      >
        <PlayFill size={24} />
      </button>
      <button
        type="button"
        onClick={handleSaveToLibrary}
        aria-pressed={inLibrary}
        title={
          inLibrary
            ? t("artist.remove_from_library")
            : t("artist.save_to_library")
        }
        className={`flex h-[40px] cursor-pointer items-center gap-[7px] rounded-full border-0 px-[20px] text-[14px] font-[600] transition-colors ${
          inLibrary
            ? "bg-accent-gradient text-white"
            : "bg-border-alpha-14 text-text-primary hover:bg-border-alpha-20"
        }`}
      >
        {inLibrary ? <CheckLine size={15} /> : null}
        <span>{inLibrary ? t("artist.following") : t("artist.follow")}</span>
      </button>
      <button
        type="button"
        onClick={handleShufflePlay}
        disabled={artist.tracks.length === 0}
        className={iconButtonClass}
        title={t("common.shuffle")}
        aria-label={t("common.shuffle")}
      >
        <LuShuffle size={18} />
      </button>
      <button
        type="button"
        onClick={handleShare}
        className={iconButtonClass}
        title={t("artist.share")}
        aria-label={t("artist.share")}
      >
        <ShareForwardLine size={18} />
      </button>
    </div>
  );

  const renderTabs = () => (
    <div
      role="tablist"
      aria-label={data?.title}
      className="mx-[28px] mt-[26px] flex items-center gap-[26px] border-b border-rim"
    >
      {tabs.map((tab) => {
        const selected = effectiveTab === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => setActiveTab(tab.key)}
            className={`-mb-px cursor-pointer border-0 border-b-[2px] bg-transparent px-[2px] pb-[10px] text-[15px] font-[600] transition-colors ${
              selected
                ? "border-accent-primary text-text-primary"
                : "border-transparent text-text-secondary hover:text-text-primary"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );

  const renderPopular = (artist: ArtistPageData) => (
    <section>
      {likedByArtist.length > 0 ? (
        <button
          type="button"
          onClick={handlePlayLiked}
          className="mb-[22px] flex w-full max-w-[440px] cursor-pointer items-center gap-[14px] rounded-panel border border-rim bg-bg-panel p-[12px] text-left transition-colors hover:bg-bg-elevated"
        >
          <span className="relative block h-[52px] w-[52px] shrink-0 overflow-hidden rounded-full bg-border-alpha-14">
            {artist.coverUrl ? (
              <CoverImage
                src={artist.coverUrl}
                alt={artist.title}
                fill
                sizes="52px"
                className="object-cover"
                draggable={false}
              />
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-[600] text-text-primary">
              {t("artist.liked_songs")}
            </span>
            <span className="block truncate text-caption text-text-secondary">
              {likedByArtist.length === 1
                ? t("artist.liked_songs_detail_one")
                : t("artist.liked_songs_detail", {
                    count: likedByArtist.length,
                  })}
            </span>
            <span className="block truncate text-caption text-text-tertiary">
              {t("artist.liked_songs_by", { name: artist.title })}
            </span>
          </span>
          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-accent-primary text-white">
            <PlayFill size={15} />
          </span>
        </button>
      ) : null}

      {latestRelease ? (
        <button
          type="button"
          onClick={() => navigate(collectionPath("album", latestRelease.id))}
          className="mb-[22px] flex w-full max-w-[440px] cursor-pointer items-center gap-[14px] rounded-panel border border-rim bg-bg-panel p-[12px] text-left transition-colors hover:bg-bg-elevated"
        >
          <span className="relative block h-[64px] w-[64px] shrink-0 overflow-hidden rounded-[10px] bg-border-alpha-14">
            {latestRelease.coverUrl ? (
              <CoverImage
                src={latestRelease.coverUrl}
                alt={latestRelease.title}
                fill
                sizes="64px"
                className="object-cover"
                draggable={false}
              />
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-caption font-[600] tracking-[0.08em] text-text-tertiary uppercase">
              {t("artist.latest_release")}
            </span>
            <span className="block truncate text-[15px] font-[600] text-text-primary">
              {latestRelease.title}
            </span>
            <span className="block truncate text-caption text-text-secondary">
              {t(latestRelease.kindKey)} • {latestRelease.year}
              {latestRelease.totalTracks
                ? ` • ${latestRelease.totalTracks} ${t("artist.tracks")}`
                : ""}
            </span>
          </span>
        </button>
      ) : null}

      {artist.tracks.length > 5 && (
        <div className="mb-[8px] flex items-center justify-end">
          <button
            type="button"
            onClick={() => setShowAllTracks((prev) => !prev)}
            className="cursor-pointer border-0 bg-transparent p-0 text-body font-[500] text-text-secondary transition-colors hover:text-text-primary"
          >
            {showAllTracks ? t("artist.show_less") : t("artist.show_all")}
          </button>
        </div>
      )}
      <div className="-mx-[8px] flex flex-col">
        {artist.tracks.slice(0, 5).map(renderTrack)}

        <AnimatePresence initial={false}>
          {showAllTracks && (
            <motion.div
              key="expanded-tracks"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{
                duration: 0.28,
                ease: [0.25, 1, 0.5, 1],
              }}
              className="flex flex-col overflow-hidden"
            >
              {artist.tracks.slice(5).map(renderTrack)}
            </motion.div>
          )}
        </AnimatePresence>

        {artist.tracks.length === 0 && (
          <p className="px-[8px] py-[14px] text-text-secondary">
            {t("artist.no_popular_songs")}
          </p>
        )}
      </div>
    </section>
  );

  const renderSimilar = (artist: ArtistPageData) => (
    <section>
      <div className="flex flex-wrap gap-x-[22px] gap-y-[22px]">
        {artist.similarArtists.map((similar) => (
          <SimilarArtistCard key={similar.id} artist={similar} />
        ))}
      </div>
    </section>
  );

  const renderAppearsOn = (artist: ArtistPageData) => (
    <section>
      <div className="-mx-[8px] flex flex-col">
        {appearances.map((track) => (
          <SongCardWithMenu
            key={track.id}
            id={track.id}
            title={track.title}
            artists={track.artists}
            artistId={track.artistId}
            artistList={track.artistList}
            coverUrl={track.coverUrl || artist.coverUrl}
            duration={formatDuration(track.durationMs)}
            durationMs={track.durationMs}
            explicit={track.explicit}
            playCount={formatPlayCount(track.playCount)}
            onPlay={() =>
              playerEngine.playTrack(
                track,
                appearances,
                artist.title,
                artist.coverUrl,
              )
            }
          />
        ))}
      </div>
    </section>
  );

  const renderDiscography = (artist: ArtistPageData) => (
    <div className="flex flex-col gap-[40px]">
      {artist.albums.length > 0 && (
        <section>
          <h2 className={`${sectionTitleClass} mb-[16px]`}>
            {t("artist.albums")}
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-[18px] gap-y-[24px]">
            {artist.albums.map((album) => (
              <AlbumCard
                key={album.id}
                id={album.id}
                title={album.title}
                coverUrl={album.coverUrl}
                year={album.releaseDate}
                explicit={album.explicit}
                trackCount={album.totalTracks}
                className="w-full"
              />
            ))}
          </div>
        </section>
      )}

      {artist.singles.length > 0 && (
        <section>
          <h2 className={`${sectionTitleClass} mb-[16px]`}>
            {t("artist.singles")}
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-[18px] gap-y-[24px]">
            {artist.singles.map((single) => (
              <ReleaseCard
                key={single.id}
                id={single.id}
                title={single.title}
                coverUrl={single.coverUrl}
                releaseType={single.releaseType}
                year={single.releaseDate}
                explicit={single.explicit}
                className="w-full"
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );

  const renderAbout = (artist: ArtistPageData) => {
    const followersLabel =
      artist.followers && artist.monthlyListeners
        ? `${Intl.NumberFormat("en-US", { notation: "compact" }).format(artist.followers)} ${t("artist.followers")}`
        : null;
    const stats: string[] = [
      ...(audienceLabel ? [audienceLabel] : []),
      ...(followersLabel ? [followersLabel] : []),
      ...(artist.totalTracks
        ? [`${artist.totalTracks} ${t("artist.tracks")}`]
        : []),
    ];
    return (
      <section className="max-w-[720px]">
        {stats.length > 0 ? (
          <div className="mb-[20px] flex flex-wrap gap-x-[28px] gap-y-[8px]">
            {stats.map((stat) => (
              <span
                key={stat}
                className="text-[15px] font-[600] text-text-primary"
              >
                {stat}
              </span>
            ))}
          </div>
        ) : null}
        {artist.description ? (
          <p className="m-0 text-body leading-[1.65] whitespace-pre-wrap text-text-secondary select-text">
            {stripMarkdown(artist.description)}
          </p>
        ) : (
          <p className="m-0 text-body text-text-secondary">
            {t("artist.no_biography")}
          </p>
        )}
        {artist.geniusAka && artist.geniusAka.length > 0 ? (
          <p className="mt-[16px] text-caption text-text-tertiary">
            {t("artist.aka")}: {artist.geniusAka.join(", ")}
          </p>
        ) : null}
        {artist.geniusImageUrl || artist.geniusUsername ? (
          <button
            type="button"
            onClick={() => setIsProfileModalOpen(true)}
            className="mt-[18px] cursor-pointer rounded-full border-0 bg-border-alpha-14 px-[16px] py-[8px] text-label font-[500] text-text-primary transition-colors hover:bg-border-alpha-20"
          >
            {t("artist.genius_profile")}
          </button>
        ) : null}
      </section>
    );
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-transparent">
      <div className="relative z-1 grid h-full min-h-0 w-full grid-cols-1 overflow-hidden">
        {data && (
          <div
            className={`col-start-1 row-start-1 h-full min-h-0 w-full overflow-hidden transition-opacity duration-200 ease-out ${
              isReady ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <div
              ref={scrollRef}
              data-no-window-drag
              className="relative z-10 box-border h-full min-h-0 w-full overflow-x-hidden overflow-y-auto overscroll-contain pt-(--page-inset-top) pb-(--page-inset-bottom)"
              style={{ willChange: "scroll-position" }}
            >
              {renderHero(data)}
              {renderActions(data)}
              {renderTabs()}
              <div className="relative z-10 px-[28px] pt-[24px] pb-[8px]">
                {effectiveTab === "popular" && renderPopular(data)}
                {effectiveTab === "discography" &&
                  hasDiscography &&
                  renderDiscography(data)}
                {effectiveTab === "similar" &&
                  similarArtists.length > 0 &&
                  renderSimilar(data)}
                {effectiveTab === "appears-on" &&
                  appearances.length > 0 &&
                  renderAppearsOn(data)}
                {effectiveTab === "about" && hasAbout && renderAbout(data)}
              </div>
            </div>
          </div>
        )}

        {!skeletonExited && (
          <div
            className={`pointer-events-none col-start-1 row-start-1 z-10 h-full w-full overflow-hidden transition-opacity duration-300 ease-out ${
              isReady ? "opacity-0" : "opacity-100"
            }`}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget) setSkeletonExited(true);
            }}
          >
            <ArtistPageSkeleton />
          </div>
        )}
      </div>

      {data && (
        <ArtistProfileModal
          open={isProfileModalOpen}
          onClose={() => setIsProfileModalOpen(false)}
          name={data.title}
          verified={data.verified}
          geniusImageUrl={data.geniusImageUrl}
          fallbackImageUrl={data.coverUrl}
          geniusUsername={data.geniusUsername}
          geniusAka={data.geniusAka}
          bio={data.description}
        />
      )}
    </div>
  );
}

export default function ArtistPage() {
  return (
    <Suspense fallback={<ArtistPageSkeleton />}>
      <ArtistContent />
    </Suspense>
  );
}
