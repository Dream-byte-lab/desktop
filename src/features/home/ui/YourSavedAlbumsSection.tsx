import { memo, useState } from "react";
import { useStableNavigate } from "@/shared/hooks/useStableNavigate";
import ScrollableRow from "@/shared/ui/ScrollableRow";
import CoverImage from "@/features/covers/ui/CoverImage";
import type { LibraryItemViewModel } from "@/features/library/types";
import SectionHeading from "./SectionHeading";

// Albums the listener saved to their own library (the library's
// saved-collections data, not the global "most saved" chart this
// rail replaces). Cards carry the library view model's own subtitle
// (year / track count) and open the album through its own href.

export interface YourSavedAlbumsSectionProps {
  title: string;
  icon?: React.ReactNode;
  albums: LibraryItemViewModel[];
  headingMarginTop?: string;
}

function SavedAlbumCard({ album }: { album: LibraryItemViewModel }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const navigate = useStableNavigate();

  return (
    <div
      className="group flex-shrink-0 w-[175px] cursor-pointer select-none"
      onClick={() => navigate(album.href)}
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-control bg-border-alpha-14">
        {album.imageUrl && (
          <CoverImage
            src={album.imageUrl}
            alt={album.title}
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
          {album.title}
        </span>
        <span className="truncate text-body text-text-tertiary">
          {album.subtitle}
        </span>
      </div>
    </div>
  );
}

function YourSavedAlbumsSection({
  title,
  icon,
  albums,
  headingMarginTop = "mt-[22px]",
}: YourSavedAlbumsSectionProps) {
  return (
    <div className="flex flex-col">
      <SectionHeading title={title} icon={icon} marginTop={headingMarginTop} />
      <ScrollableRow className="flex gap-[28px] pl-3 pr-3 mt-[12px] overflow-x-auto pb-[2px]">
        {albums.map((album) => (
          <SavedAlbumCard key={album.id} album={album} />
        ))}
      </ScrollableRow>
    </div>
  );
}

export default memo(YourSavedAlbumsSection);
