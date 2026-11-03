import { memo, useCallback, useRef } from "react";
import { MusicFill } from "@mingcute/react";
import CoverImage from "@/features/covers/ui/CoverImage";
import { playerEngine } from "@/features/player";
import { useStableNavigate } from "@/shared/hooks/useStableNavigate";
import type { Track } from "@/shared/types";
import type { ForYouMix } from "../lib/forYouFeed";

export interface ForYouMixCardProps {
  mix: ForYouMix;
  title: string;
  subtitle: string;
}

/** Up to four unique cover URLs from a track list, in track order. */
export function uniqueCoverUrls(tracks: readonly Track[]): string[] {
  const seen = new Set<string>();
  const covers: string[] = [];
  for (const track of tracks) {
    if (track.coverUrl && !seen.has(track.coverUrl)) {
      seen.add(track.coverUrl);
      covers.push(track.coverUrl);
      if (covers.length === 4) break;
    }
  }
  return covers;
}

/**
 * The mix cover: a 2x2 collage of the mix's own track covers (one
 * cover fills the square; two split it vertically; none falls back
 * to a matte placeholder). Shared by the card and the page's
 * featured hero so a mix looks the same at both sizes.
 */
export function MixCoverCollage({
  covers,
  sizes = "175px",
}: {
  covers: string[];
  sizes?: string;
}) {
  if (covers.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-border-alpha-14 text-text-tertiary">
        <MusicFill size={28} />
      </div>
    );
  }

  if (covers.length === 1) {
    return (
      <CoverImage
        src={covers[0]}
        alt=""
        fill
        sizes={sizes}
        className="object-cover"
      />
    );
  }

  const cells =
    covers.length === 2
      ? covers.map((cover) => ({ cover, className: "row-span-2" }))
      : covers.map((cover, index) => ({
          cover,
          className: covers.length === 3 && index === 2 ? "col-span-2" : "",
        }));

  return (
    <div className="grid h-full w-full grid-cols-2 grid-rows-2">
      {cells.map(({ cover, className }, index) => (
        <div key={`${cover}-${index}`} className={`relative ${className}`}>
          <CoverImage
            src={cover}
            alt=""
            fill
            sizes={sizes}
            className="object-cover"
          />
        </div>
      ))}
    </div>
  );
}

// A generated mix in the DailyMixCard family: same 175px footprint
// and click contract as the Home rail's DailyMixCard — a single
// click OPENS the mix (its collection page lists the songs), a
// double click plays it. Deliberately no context menu: a mix is a
// generated view over the listener's own library, not a library
// object with its own actions. (Before Note 23 the single click
// only played, so a mix shown here could never be opened at all.)
function ForYouMixCard({ mix, title, subtitle }: ForYouMixCardProps) {
  const navigate = useStableNavigate();
  const covers = uniqueCoverUrls(mix.tracks);
  const firstCover = covers[0];
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePlay = useCallback(() => {
    const firstTrack = mix.tracks[0];
    if (!firstTrack) return;
    void playerEngine.playTrack(firstTrack, mix.tracks, title, firstCover);
  }, [mix, title, firstCover]);

  const handleClick = (e: React.MouseEvent) => {
    if (e.detail >= 2) {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      handlePlay();
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      navigate(`/collection?type=playlist&id=${encodeURIComponent(mix.id)}`);
    }, 200);
  };

  return (
    <div
      className="group flex-shrink-0 w-[175px] cursor-pointer select-none"
      onClick={handleClick}
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-control bg-border-alpha-14">
        <MixCoverCollage covers={covers} />
      </div>

      <div className="flex flex-col mt-[8px]">
        <span className="truncate text-label font-medium text-text-primary">
          {title}
        </span>
        <span className="truncate text-body text-text-tertiary">
          {subtitle}
        </span>
      </div>
    </div>
  );
}

export default memo(ForYouMixCard);
