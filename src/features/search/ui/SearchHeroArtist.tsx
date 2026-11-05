import { memo, useCallback } from "react";
import { More1Line } from "@mingcute/react";
import { LuShuffle } from "react-icons/lu";
import CoverImage from "@/features/covers/ui/CoverImage";
import { playerEngine } from "@/features/player";
import { useArtist } from "@/features/artist/hooks/useArtist";
import { artistAudience } from "@/features/artist/lib/audience";
import { useExternalItems } from "@/features/library/hooks/useExternalItems";
import { useModalStore } from "@/features/library/store/modalStore";
import { useTranslation } from "@/languages";
import type { SearchRowItem } from "../lib/searchPageItems";

// The Search page's artist hero (reference 04): the top artist as a
// large circular portrait with the action cluster — a Following
// state button, Shuffle Play, overflow — and the related artists as
// smaller circles with Follow pills.
//
// Two honesty rules govern this component:
//  - THE STAT LINE IS THE ARTIST PAGE'S OWN. Under the name sits
//    the audience figure, produced by the artist page's standing
//    rule (artistAudience): the source's monthly-audience figure
//    where the source publishes one, otherwise the follower
//    count — source-labelled identically in both places, never
//    both, never invented. (An earlier register pinned this
//    figure's ABSENCE here; the user's order of 2026-11-05 to add
//    the omitted sections superseded that pin, and the tests now
//    pin the labelled presence instead.)
//  - ONE FOLLOW MECHANISM. The follow state and its toggle are the
//    artist page's own: saved state from useExternalItems("artist"),
//    changes through the library modal store's add/remove flow.
//    This component binds that mechanism; it implements no second
//    one.

export interface SearchHeroArtistProps {
  hero: SearchRowItem;
  related: SearchRowItem[];
  onNavigateArtist: (artist: SearchRowItem) => void;
}

function VerifiedMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[26px] w-[26px] shrink-0 text-[#1d9bf0]"
      fill="currentColor"
      aria-label="Verified"
    >
      <path d="M10.007 2.10377C8.60544 1.65006 7.08181 2.28116 6.41156 3.59306L5.60578 5.17023C5.51004 5.35763 5.35763 5.51004 5.17023 5.60578L3.59306 6.41156C2.28116 7.08181 1.65006 8.60544 2.10377 10.007L2.64923 11.692C2.71404 11.8922 2.71404 12.1078 2.64923 12.308L2.10377 13.993C1.65006 15.3946 2.28116 16.9182 3.59306 17.5885L5.17023 18.3942C5.35763 18.49 5.51004 18.6424 5.60578 18.8298L6.41156 20.407C7.08181 21.7189 8.60544 22.35 10.007 21.8963L11.692 21.3508C11.8922 21.286 12.1078 21.286 12.308 21.3508L13.993 21.8963C15.3946 22.35 16.9182 21.7189 17.5885 20.407L18.3942 18.8298C18.49 18.6424 18.6424 18.49 18.8298 18.3942L20.407 17.5885C21.7189 16.9182 22.35 15.3946 21.8963 13.993L21.3508 12.308C21.286 12.1078 21.286 11.8922 21.3508 11.692L21.8963 10.007C22.35 8.60544 21.7189 7.08181 20.407 6.41156L18.8298 5.60578C18.49 5.51004 18.49 5.35763 18.3942 5.17023L17.5885 3.59306C16.9182 2.28116 15.3946 1.65006 13.993 2.10377L12.308 2.64923C11.8922 2.71403 11.8922 2.71404 11.692 2.64923L10.007 2.10377Z" />
      <path
        d="M6.75977 11.7573L8.17399 10.343L11.0024 13.1715L16.6593 7.51465L18.0735 8.92886L11.0024 15.9999L6.75977 11.7573Z"
        fill="#ffffff"
        transform="translate(-0.42 0.24)"
      />
    </svg>
  );
}

function useFollowToggle(artist: SearchRowItem) {
  const { data: savedArtists } = useExternalItems("artist");
  const following = savedArtists.some((saved) => saved.id === artist.id);
  const toggleFollow = useCallback(() => {
    const detail = {
      id: artist.id,
      title: artist.title,
      coverUrl: artist.coverUrl,
      type: "artist" as const,
    };
    if (following) {
      useModalStore.getState().openRemoveFromLibrary(detail);
    } else {
      useModalStore.getState().openAddToLibrary(detail);
    }
  }, [artist, following]);
  return { following, toggleFollow };
}

function RelatedArtist({
  artist,
  onNavigateArtist,
}: {
  artist: SearchRowItem;
  onNavigateArtist: (artist: SearchRowItem) => void;
}) {
  const { t } = useTranslation();
  const { following, toggleFollow } = useFollowToggle(artist);
  return (
    <div className="flex w-[104px] shrink-0 flex-col items-center gap-[6px]">
      <button
        type="button"
        onClick={() => onNavigateArtist(artist)}
        className="relative block h-[76px] w-[76px] cursor-pointer overflow-hidden rounded-full border-none bg-border-alpha-14 p-0"
        aria-label={artist.title}
      >
        {artist.coverUrl ? (
          <CoverImage
            src={artist.coverUrl}
            alt={artist.title}
            fill
            sizes="76px"
            className="object-cover"
          />
        ) : null}
      </button>
      <button
        type="button"
        onClick={() => onNavigateArtist(artist)}
        className="max-w-full cursor-pointer truncate border-none bg-transparent p-0 text-label font-[500] text-text-primary"
      >
        {artist.title}
      </button>
      <div className="flex items-center gap-[4px]">
        <button
          type="button"
          onClick={toggleFollow}
          className={`cursor-pointer rounded-full px-[10px] py-[3px] text-caption font-[500] transition-colors ${
            following
              ? "bg-accent-gradient text-white"
              : "bg-border-alpha-14 text-text-secondary hover:text-text-primary"
          }`}
        >
          {following ? t("search.page.following") : t("search.page.follow")}
        </button>
        <button
          type="button"
          onClick={() => onNavigateArtist(artist)}
          aria-label={t("common.more")}
          className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-text-tertiary transition-colors hover:text-text-primary"
        >
          <More1Line size={15} />
        </button>
      </div>
    </div>
  );
}

export const SearchHeroArtist = memo(function SearchHeroArtist({
  hero,
  related,
  onNavigateArtist,
}: SearchHeroArtistProps) {
  const { t } = useTranslation();
  const { data } = useArtist(hero.id);
  const { following, toggleFollow } = useFollowToggle(hero);
  const audience = data ? artistAudience(data) : null;
  const audienceLabel = audience
    ? audience.kind === "monthly"
      ? t("artist.monthly_audience", { count: audience.count })
      : `${audience.count} ${t("artist.followers")}`
    : null;

  const canShuffle = Boolean(data && data.tracks.length > 0);
  const handleShufflePlay = useCallback(() => {
    if (!data || data.tracks.length === 0) return;
    playerEngine.clearQueue();
    void playerEngine.playShuffled(data.tracks, data.title, data.coverUrl);
  }, [data]);

  return (
    <div className="flex flex-wrap items-start gap-x-[36px] gap-y-[20px]">
      <div className="flex min-w-0 items-center gap-[22px]">
        <button
          type="button"
          onClick={() => onNavigateArtist(hero)}
          className="relative block h-[148px] w-[148px] shrink-0 cursor-pointer overflow-hidden rounded-full border-none bg-border-alpha-14 p-0"
          aria-label={hero.title}
        >
          {hero.coverUrl ? (
            <CoverImage
              src={hero.coverUrl}
              alt={hero.title}
              fill
              sizes="148px"
              className="object-cover"
            />
          ) : null}
          {data?.verified ? (
            <span className="absolute right-[6px] bottom-[6px] flex h-[30px] w-[30px] items-center justify-center rounded-full bg-bg-canvas">
              <VerifiedMark />
            </span>
          ) : null}
        </button>

        <div className="flex min-w-0 flex-col items-start gap-[12px]">
          <button
            type="button"
            onClick={() => onNavigateArtist(hero)}
            className="cursor-pointer border-none bg-transparent p-0 text-left"
          >
            <span className="block truncate text-[34px] leading-[1.1] font-[600] tracking-tight text-text-primary">
              {hero.title}
            </span>
          </button>
          {audienceLabel ? (
            <span className="text-label font-[500] text-text-secondary">
              {audienceLabel}
            </span>
          ) : null}
          <div className="flex items-center gap-[8px]">
            <button
              type="button"
              onClick={toggleFollow}
              className={`cursor-pointer rounded-full px-[16px] py-[7px] text-label font-[600] transition-colors ${
                following
                  ? "bg-accent-gradient text-white"
                  : "bg-border-alpha-14 text-text-primary hover:bg-border-alpha-20"
              }`}
            >
              {following ? t("search.page.following") : t("search.page.follow")}
            </button>
            <button
              type="button"
              onClick={handleShufflePlay}
              disabled={!canShuffle}
              className="flex cursor-pointer items-center gap-[7px] rounded-full bg-border-alpha-14 px-[16px] py-[7px] text-label font-[500] text-text-primary transition-colors hover:bg-border-alpha-20 disabled:cursor-default disabled:opacity-50"
            >
              <LuShuffle size={15} />
              {t("search.page.shuffle_play")}
            </button>
            <button
              type="button"
              onClick={() => onNavigateArtist(hero)}
              aria-label={t("common.more")}
              className="flex h-[32px] w-[32px] cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-text-tertiary transition-colors hover:text-text-primary"
            >
              <More1Line size={18} />
            </button>
          </div>
        </div>
      </div>

      {related.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-[10px]">
          <span className="text-caption font-[600] tracking-[0.08em] text-text-tertiary uppercase">
            {t("search.page.related_artists")}
          </span>
          <div className="flex flex-wrap gap-x-[18px] gap-y-[14px]">
            {related.map((artist) => (
              <RelatedArtist
                key={artist.id}
                artist={artist}
                onNavigateArtist={onNavigateArtist}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default SearchHeroArtist;
