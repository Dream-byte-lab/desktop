import type { ReactNode } from "react";
import { cn } from "@/shared/lib";

export interface GridLayoutProps {
  children?: ReactNode;
  minItemWidth?: number;
  className?: string;
}

/**
 * Grid layout family — catalogue cards at the catalogue radius, with
 * captions below. The grid auto-fills to the available width.
 *
 * Assigned screens: Discover grids; Albums; Artists; Playlists;
 * Genre/Mood collections; New Releases; Search album/playlist blocks;
 * Discography blocks; Related albums; Favorites grids.
 */
export default function GridLayout({
  children,
  minItemWidth = 160,
  className,
}: GridLayoutProps) {
  return (
    <div
      className={cn("grid w-full gap-[20px]", className)}
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(${minItemWidth}px, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}
