import { memo, useEffect, useMemo, useState } from "react";
import { LuArrowUpNarrowWide } from "react-icons/lu";
import Button from "@/shared/ui/Button";
import {
  DropdownMenu,
  HERO_BUTTON_CLASS,
  HERO_GLASS_BUTTON_CLASS,
} from "@/shared/ui";
import { useTranslation } from "@/languages";

export type TrackSortOption =
  | "default"
  | "added"
  | "title"
  | "artist"
  | "album"
  | "duration"
  | "popularity";

export const TRACK_SORT_OPTIONS: TrackSortOption[] = [
  "default",
  "added",
  "title",
  "artist",
  "album",
  "duration",
  "popularity",
];

interface SortableTrack {
  title: string;
  durationMs: number;
  playCount: number;
  addedAt?: string;
  /**
   * Artist data as the track lists actually carry it: the client Track
   * (`@/shared/types`) stores a joined display string in `artists`
   * (e.g. "A, B") plus the structured list in `artistList`, while the
   * contract Track (`@/shared/contracts`) stores `artists` as an array
   * of `{ name }`. All optional so either shape satisfies this type.
   */
  artists?: string | readonly { name: string }[];
  artistList?: readonly { name: string }[];
  /** Album data as carried: an object with a title (or a bare title). */
  album?: { title: string } | string;
}

function addedTime(track: SortableTrack): number {
  const time = track.addedAt ? Date.parse(track.addedAt) : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

/**
 * Sort key for "artist": the track's joined artist names (", "-joined),
 * so a multi-artist track sorts under its full credit, first artist
 * first. Falls back to `artistList` when the display string is empty.
 * Undefined when the track carries no artist data.
 */
function artistKey(track: SortableTrack): string | undefined {
  if (typeof track.artists === "string") {
    const key = track.artists.trim();
    if (key) return key;
  } else if (Array.isArray(track.artists)) {
    const key = track.artists
      .map((artist) => artist?.name?.trim() ?? "")
      .filter(Boolean)
      .join(", ");
    if (key) return key;
  }
  if (track.artistList?.length) {
    const key = track.artistList
      .map((artist) => artist?.name?.trim() ?? "")
      .filter(Boolean)
      .join(", ");
    if (key) return key;
  }
  return undefined;
}

/** Sort key for "album": the album's title. Undefined when absent/blank. */
function albumKey(track: SortableTrack): string | undefined {
  if (!track.album) return undefined;
  const title =
    typeof track.album === "string" ? track.album : track.album.title;
  const key = title?.trim();
  return key ? key : undefined;
}

function compareTextKeys(
  aKey: string | undefined,
  bKey: string | undefined,
): number {
  if (aKey && bKey) {
    return aKey.localeCompare(bKey, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  }
  // Tracks missing the field sort after tracks that have it.
  if (aKey) return -1;
  if (bKey) return 1;
  return 0;
}

export function sortOptionsFor(tracks: SortableTrack[]): TrackSortOption[] {
  const hasDates = tracks.some(
    (track) => !Number.isNaN(Date.parse(track.addedAt ?? "")),
  );
  const hasArtists = tracks.some((track) => artistKey(track) !== undefined);
  const hasAlbums = tracks.some((track) => albumKey(track) !== undefined);
  return TRACK_SORT_OPTIONS.filter(
    (option) =>
      (option !== "added" || hasDates) &&
      (option !== "artist" || hasArtists) &&
      (option !== "album" || hasAlbums),
  );
}

/** Stable sort; "default" keeps the source order untouched. */
export function sortTracks<T extends SortableTrack>(
  tracks: T[],
  option: TrackSortOption,
): T[] {
  if (option === "default") return tracks;
  const indexed = tracks.map((track, index) => ({ track, index }));
  indexed.sort((a, b) => {
    let diff = 0;
    if (option === "title") {
      diff = a.track.title.localeCompare(b.track.title, undefined, {
        sensitivity: "base",
        numeric: true,
      });
    } else if (option === "artist") {
      diff = compareTextKeys(artistKey(a.track), artistKey(b.track));
    } else if (option === "album") {
      diff = compareTextKeys(albumKey(a.track), albumKey(b.track));
    } else if (option === "duration") {
      diff = (a.track.durationMs || 0) - (b.track.durationMs || 0);
    } else if (option === "added") {
      const a1 = addedTime(a.track);
      const b1 = addedTime(b.track);
      diff = a1 === b1 ? 0 : b1 > a1 ? 1 : -1;
    } else if (option === "popularity") {
      diff = (b.track.playCount || 0) - (a.track.playCount || 0);
    }
    return diff !== 0 ? diff : a.index - b.index;
  });
  return indexed.map((entry) => entry.track);
}

export interface TrackSortState<T> {
  option: TrackSortOption;
  options: TrackSortOption[];
  setOption: (option: TrackSortOption) => void;
  sorted: T[];
}

/** Sort state for a track list; resets to "default" when `key` changes (another playlist/album). */
export function useTrackSort<T extends SortableTrack>(
  tracks: T[],
  key: string | null | undefined,
): TrackSortState<T> {
  const [option, setOption] = useState<TrackSortOption>("default");

  useEffect(() => {
    setOption("default");
  }, [key]);

  const sorted = useMemo(() => sortTracks(tracks, option), [tracks, option]);
  const options = useMemo(() => sortOptionsFor(tracks), [tracks]);

  return { option, options, setOption, sorted };
}

interface TrackSortMenuProps {
  sort: TrackSortState<unknown>;
  disabled?: boolean;
}

export const TrackSortMenu = memo(function TrackSortMenu({
  sort,
  disabled,
}: TrackSortMenuProps) {
  const { t } = useTranslation();

  const labels: Record<TrackSortOption, string> = {
    default: t("track_sort.default"),
    added: t("track_sort.added") || "By date added",
    title: t("track_sort.title"),
    artist: t("track_sort.artist") || "By artist",
    album: t("track_sort.album") || "By album",
    duration: t("track_sort.duration"),
    popularity: t("track_sort.popularity"),
  };

  return (
    <DropdownMenu
      align="end"
      trigger={
        <Button
          variant="secondary"
          disabled={disabled}
          className={`${HERO_BUTTON_CLASS} ${HERO_GLASS_BUTTON_CLASS} !w-[52px] !p-0 text-text-primary`}
          title={t("track_sort.label")}
          aria-label={t("track_sort.label")}
        >
          <LuArrowUpNarrowWide size={18} />
        </Button>
      }
      items={sort.options.map((option) => ({
        id: option,
        label: labels[option],
        active: sort.option === option,
        onClick: () => sort.setOption(option),
      }))}
    />
  );
});

export default TrackSortMenu;
