import { memo, useState } from "react";
import { useStableNavigate } from "@/shared/hooks/useStableNavigate";
import ScrollableRow from "@/shared/ui/ScrollableRow";
import CoverImage from "@/features/covers/ui/CoverImage";
import { usePlaylistGenreLabels } from "@/features/genres/playlistGenreStore";
import type { LibraryPlaylistSummary } from "@/features/library/hooks/usePlaylists";
import {
  orderPinnedFirst,
  usePinnedPlaylistIds,
} from "@/features/library/lib/playlistIdentity";
import SectionHeading from "./SectionHeading";

// The signed-in listener's own playlists, as a Home rail. Cards
// navigate to the same library playlist page the Library itself
// opens. Where the owner has filed a playlist under a Playlist
// Genre, the label rides on the card as a badge — their own filing,
// shown because it exists, never invented when it doesn't.

export interface YourPlaylistsSectionProps {
  title: string;
  icon?: React.ReactNode;
  playlists: LibraryPlaylistSummary[];
  headingMarginTop?: string;
}

function GenreBadges({ playlistId }: { playlistId: string }) {
  const labels = usePlaylistGenreLabels(playlistId);
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-[4px] mt-[6px]">
      {labels.slice(0, 2).map((label) => (
        <span
          key={label}
          className="max-w-full truncate rounded-full bg-bg-elevated px-[7px] py-[1px] text-[10px] font-[500] text-text-secondary"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function PlaylistRailCard({ playlist }: { playlist: LibraryPlaylistSummary }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const navigate = useStableNavigate();

  const handleClick = () => {
    navigate(`/library/playlist?id=${encodeURIComponent(playlist.id)}`);
  };

  return (
    <div
      className="group flex-shrink-0 w-[175px] cursor-pointer select-none"
      onClick={handleClick}
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-control bg-border-alpha-14">
        {playlist.coverUrl && (
          <CoverImage
            src={playlist.coverUrl}
            alt={playlist.title}
            fill
            sizes="175px"
            className={`object-cover transition-all duration-300 group-hover:brightness-[1.15] ${
              imageLoaded ? "opacity-100" : "opacity-0"
            }`}
            onLoad={() => setImageLoaded(true)}
          />
        )}
      </div>
      <div className="flex flex-col mt-[8px]">
        <span className="truncate text-label font-[500] text-text-primary">
          {playlist.title}
        </span>
        <span className="truncate text-body text-text-tertiary">
          {playlist.trackCount > 0 ? `${playlist.trackCount} tracks` : ""}
        </span>
        <GenreBadges playlistId={playlist.id} />
      </div>
    </div>
  );
}

function YourPlaylistsSection({
  title,
  icon,
  playlists,
  headingMarginTop = "mt-[22px]",
}: YourPlaylistsSectionProps) {
  // Pinned playlists first (shared ordering helper); covers already
  // carry any custom-cover overlay from the summary choke point.
  const pinnedIds = usePinnedPlaylistIds();
  const ordered = orderPinnedFirst(playlists, pinnedIds);
  return (
    <div className="flex flex-col">
      <SectionHeading title={title} icon={icon} marginTop={headingMarginTop} />
      <ScrollableRow className="flex gap-[28px] pl-3 pr-3 mt-[12px] overflow-x-auto pb-[2px]">
        {ordered.map((playlist) => (
          <PlaylistRailCard key={playlist.id} playlist={playlist} />
        ))}
      </ScrollableRow>
    </div>
  );
}

export default memo(YourPlaylistsSection);
