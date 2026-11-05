import { memo, useCallback, useMemo, useState } from "react";
import { HeartFill, HeartLine } from "@mingcute/react";
import SongCard from "./SongCard";
import { useSongMenuItems } from "../hooks/useSongMenuItems";
import {
  useIsTrackLiked,
  useLikeTrack,
  useUnlikeTrack,
} from "@/features/library";
import { playerEngine } from "../engine/playerEngine";
import { usePlayerStore } from "../store/playerStore";
import { useToast } from "@/shared/ui";
import { useTranslation } from "@/languages";

import type { TrackArtist } from "@/shared/types";
import { isLocalTrackId } from "@/shared/media/local";

export interface SongCardWithMenuProps {
  id?: string;
  title: string;
  artists: string;
  artistId?: string;
  artistList?: TrackArtist[];
  coverUrl: string;
  className?: string;
  onPlay?: () => void;
  duration?: string;
  durationMs?: number;
  releaseDate?: string;
  explicit?: boolean;
  hideArtists?: boolean;
  imageShape?: "square" | "circle";
  trackNumber?: number;
  /** numbered rows that keep their artwork (artist Popular rows) */
  showCoverWithNumber?: boolean;
  /** preformatted lifetime play count, where the source supplies one */
  playCount?: string;
  repostedBy?: string;
  searchType?: "track" | "album" | "artist" | "playlist";
  totalTracks?: number;
  playlistId?: string;
  playlistItemId?: string;
  playlistTitle?: string;
  onNavigate?: () => void;
  compact?: boolean;
  icon?: React.ReactNode;
  showReorderHandle?: boolean;
  onGrabStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
  highlight?: string;
  trailingAction?: React.ReactNode;
  /** play queue rows: adds "Remove from queue" to the card menu */
  onRemoveFromQueue?: () => void;
  onRemoveFromDevice?: () => void;
}

function SongCardWithMenu({
  id,
  title,
  artists,
  artistId,
  artistList,
  coverUrl,
  className,
  onPlay,
  duration,
  durationMs,
  releaseDate,
  explicit,
  hideArtists,
  imageShape,
  trackNumber,
  showCoverWithNumber,
  playCount,
  repostedBy,
  searchType,
  totalTracks,
  playlistId,
  playlistItemId,
  playlistTitle,
  onNavigate,
  compact,
  icon,
  showReorderHandle,
  onGrabStart,
  highlight,
  trailingAction,
  onRemoveFromQueue,
  onRemoveFromDevice,
}: SongCardWithMenuProps) {
  const resolvedDurationMs = useMemo(() => {
    if (durationMs !== undefined) return durationMs;
    if (!duration) return 0;
    const parts = duration.split(":").map(Number);
    if (parts.length === 2) {
      return (parts[0] * 60 + parts[1]) * 1000;
    }
    if (parts.length === 3) {
      return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    }
    return 0;
  }, [duration, durationMs]);

  const menuItems = useSongMenuItems({
    id,
    title,
    artists,
    coverUrl,
    duration,
    durationMs: resolvedDurationMs,
    searchType,
    totalTracks,
    playlistId,
    playlistItemId,
    playlistTitle,
    onRemoveFromQueue,
    onRemoveFromDevice,
  });

  // One-click like heart (upstream #250). It mirrors the menu's Like
  // action exactly: track rows only (the menu builds no like item for
  // album/artist/playlist rows), cloud tracks only (the menu drops its
  // like item for local-device tracks — see CLOUD_ONLY_ITEMS in
  // useSongMenuItems), and a real track id. State and toggling ride the
  // shared library machinery (useIsTrackLiked / useLikeTrack /
  // useUnlikeTrack), so Liked Songs and every other view update at once.
  const likeable =
    Boolean(id) &&
    (searchType === "track" || !searchType) &&
    !isLocalTrackId(id);
  const liked = useIsTrackLiked(likeable ? id : undefined);
  const likeMutation = useLikeTrack();
  const unlikeMutation = useUnlikeTrack();

  const handleLikeToggle = useCallback(
    (e: React.MouseEvent) => {
      // The row plays on click: the heart must never fall through to it,
      // and it must not open the menu either.
      e.preventDefault();
      e.stopPropagation();
      if (!id) return;
      if (liked) {
        unlikeMutation.mutate(id);
      } else {
        likeMutation.mutate(id);
      }
    },
    [id, liked, likeMutation, unlikeMutation],
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const { t } = useTranslation();
  const { toast } = useToast();

  // SongCard renders trailingAction immediately right of the ⋮ button,
  // which is exactly where upstream #250 wants the heart: [⋮] [♡]. Any
  // trailing action a consumer supplied keeps its place after the heart.
  // Like the ⋮ button it is always rendered (SongCard never hover-hides
  // the ⋮), so touch and narrow windows keep a reachable target; the
  // filled accent heart still reads at a glance when the track is liked.
  const likeButton = likeable ? (
    <button
      type="button"
      aria-label={liked ? t("common.unlike") : t("common.like")}
      aria-pressed={liked}
      title={liked ? t("common.unlike") : t("common.like")}
      onClick={handleLikeToggle}
      className={`rounded-control bg-transparent border-0 p-0 transition-all duration-150 active:scale-[0.96] flex items-center justify-center cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-text-secondary ${
        liked
          ? "text-accent-primary"
          : "text-text-secondary hover:text-text-primary"
      }`}
    >
      {liked ? <HeartFill size={20} /> : <HeartLine size={20} />}
    </button>
  ) : null;
  const trackDoubleClickBehavior = usePlayerStore(
    (state) => state.trackDoubleClickBehavior,
  );

  const handleDoubleClick = useCallback(() => {
    if (!id) return;
    if (trackDoubleClickBehavior === "queue") {
      playerEngine.addToQueue({
        id,
        title,
        artists,
        coverUrl,
        durationMs: resolvedDurationMs,
        playCount: 0,
      });
      toast(t("common.added_to_queue"), "checkmark", {
        description: artists ? `${title} — ${artists}` : title,
      });
    } else if (onPlay) {
      onPlay();
    }
  }, [
    trackDoubleClickBehavior,
    id,
    title,
    artists,
    coverUrl,
    resolvedDurationMs,
    onPlay,
    toast,
    t,
  ]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (menuItems.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      setMenuPosition({ x: e.clientX, y: e.clientY });
      setMenuOpen(true);
    },
    [menuItems],
  );

  const handleMenuOpenChange = useCallback((isOpen: boolean) => {
    setMenuOpen(isOpen);
    if (!isOpen) setMenuPosition(null);
  }, []);

  return (
    <SongCard
      id={id}
      title={title}
      highlight={highlight}
      artists={artists}
      artistId={artistId}
      artistList={artistList}
      artistsClickable={!isLocalTrackId(id)}
      coverUrl={coverUrl}
      className={className}
      onPlay={onPlay}
      onDoubleClick={handleDoubleClick}
      duration={duration}
      releaseDate={releaseDate}
      explicit={explicit}
      hideArtists={hideArtists}
      imageShape={imageShape}
      trackNumber={trackNumber}
      showCoverWithNumber={showCoverWithNumber}
      playCount={playCount}
      repostedBy={repostedBy}
      menuItems={menuItems}
      menuOpen={menuOpen}
      onMenuOpenChange={handleMenuOpenChange}
      onContextMenu={handleContextMenu}
      menuPosition={menuPosition}
      onNavigate={onNavigate}
      compact={compact}
      icon={icon}
      showReorderHandle={showReorderHandle}
      onGrabStart={onGrabStart}
      trailingAction={
        likeButton || trailingAction ? (
          <>
            {likeButton}
            {trailingAction}
          </>
        ) : undefined
      }
    />
  );
}

export default memo(SongCardWithMenu);
