import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { Playlist2Fill } from "@mingcute/react";
import { useTranslation } from "@/languages";
import { Tooltip } from "@/shared/ui";
import { cn } from "@/shared/lib";
import CoverImage from "@/features/covers/ui/CoverImage";
import { usePlaylistsList } from "@/features/library/hooks/usePlaylists";
import { usePinnedPlaylistIds } from "@/features/library/lib/playlistIdentity";
import { pinnedSidebarSection } from "@/features/navigation/data/navigation";
import { useSidebarStore } from "../model/useSidebarStore";

// The sidebar's Pinned section (Interface Build 6): the user's
// pinned playlists, cover + name, click navigating to the playlist
// page. The pins are Wave 3's — the persisted pin set in the
// library's identity store, read through its own hook; this
// component adds no second store. Rows render in pin order and
// only for pins that resolve to a real playlist summary (a pin for
// a since-deleted playlist, or the reserved "likes" id, which has
// no summary, simply renders no row). With no resolvable pins the
// section does not exist — no empty header (the shell's nav
// honesty). Active state follows the same rule as the nav items:
// exactly one selection pill, gliding on the shared layoutId; on a
// pinned playlist's page the Library item yields to this row (see
// SidebarNavItems).

export function SidebarPinnedPlaylists() {
  const { pathname, search } = useLocation();
  const { t } = useTranslation();
  const collapsed = useSidebarStore((state) => state.collapsed);
  const reduceMotion = useReducedMotion();
  const pinnedIds = usePinnedPlaylistIds();
  const { data } = usePlaylistsList();

  const byId = new Map(
    data.playlists.map((playlist) => [playlist.id, playlist]),
  );
  const rows = pinnedIds
    .map((id) => byId.get(id))
    .filter((playlist) => playlist !== undefined);

  if (rows.length === 0) return null;

  const openId =
    pathname === "/library/playlist"
      ? new URLSearchParams(search).get("id")
      : null;

  const renderPill = (active: boolean): ReactNode => {
    if (!active) return null;
    if (reduceMotion) {
      return (
        <span className="absolute inset-0 rounded-full bg-accent-primary/15" />
      );
    }
    return (
      <motion.span
        layoutId="sidebar-active-pill"
        className="absolute inset-0 rounded-full bg-accent-primary/15"
        transition={{ duration: 0.21, ease: [0.22, 1, 0.36, 1] }}
      />
    );
  };

  const cover = (coverUrl: string, title: string, size: number) =>
    coverUrl ? (
      <CoverImage
        src={coverUrl}
        alt={title}
        width={size}
        height={size}
        className="shrink-0 rounded-control object-cover"
        style={{ width: size, height: size }}
      />
    ) : (
      <span
        className="flex shrink-0 items-center justify-center rounded-control bg-fill text-text-tertiary"
        style={{ width: size, height: size }}
      >
        <Playlist2Fill size={Math.round(size * 0.62)} />
      </span>
    );

  if (collapsed) {
    // The rail: cover thumbnails inside the rail's capsule pattern,
    // named by tooltip, exactly like the rail's icon items.
    return (
      <div className="flex flex-col items-center gap-[20px] pt-[20px]">
        <div className="flex justify-center">
          <div className="w-[24px] border-t border-border-primary/50" />
        </div>
        {rows.map((playlist) => {
          const active = openId === playlist.id;
          return (
            <Tooltip
              key={playlist.id}
              content={playlist.title}
              side="right"
              sideOffset={12}
            >
              <Link
                to={`/library/playlist?id=${encodeURIComponent(playlist.id)}`}
                aria-current={active ? "page" : undefined}
                aria-label={playlist.title}
                className={cn(
                  "group relative inline-flex h-[38px] w-[38px] items-center justify-center rounded-full cursor-pointer active:scale-[0.96] transition-all duration-150 motion-reduce:transition-none",
                  !active && "hover:bg-fill",
                )}
              >
                {renderPill(active)}
                <span className="relative z-10">
                  {cover(playlist.coverUrl, playlist.title, 24)}
                </span>
              </Link>
            </Tooltip>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-[21px] pt-[18px] pb-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
        {t(`common.sidebar.section_${pinnedSidebarSection.id}`) ||
          pinnedSidebarSection.label}
      </div>
      <div className="mx-[10px] flex flex-col gap-[2px]">
        {rows.map((playlist) => {
          const active = openId === playlist.id;
          return (
            <Link
              key={playlist.id}
              to={`/library/playlist?id=${encodeURIComponent(playlist.id)}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex h-[38px] w-full items-center gap-[10px] rounded-full px-[11px] cursor-pointer active:scale-[0.98] transition-all duration-150 motion-reduce:transition-none",
                !active && "hover:bg-fill",
              )}
            >
              {renderPill(active)}
              <span className="relative z-10 flex shrink-0">
                {cover(playlist.coverUrl, playlist.title, 24)}
              </span>
              <span
                className={cn(
                  "relative z-10 truncate text-[13px] font-medium",
                  active ? "text-accent-primary" : "text-text-primary",
                )}
              >
                {playlist.title}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
