import { useTranslation } from "@/languages";
import type { Track } from "@/shared/types";
import type { PopularItem } from "../hooks/usePopularTracks";
import type { RecommendationRow } from "../lib/recommendations";
import PopularTracksSection from "./PopularTracksSection";

// The server-recommendation rows on the For You page (user ruling,
// 2026-11-03): catalogue tracks the listener has not heard, aimed
// by their own taste. Rendering is deliberately the page's own row
// component, so a recommended track plays through exactly the same
// plain-player path as every other row on the page — a click plays
// the track; nothing here queues, files or DJ-plays anything.
//
// Every title states the row's true basis (the seed that produced
// it), and the shared subtitle discloses the catalogue source —
// the local rows' "from your own library" subtitle would be false
// here, so these rows carry their own.

function toPopularItems(tracks: readonly Track[]): PopularItem[] {
  return tracks.map((track) => ({
    type: "track" as const,
    item: track,
    playCount: track.playCount ?? 0,
  }));
}

export default function ForYouRecommendations({
  rows,
  margins,
}: {
  rows: RecommendationRow[];
  /** Top margin per row, from the page's margin chain. */
  margins: string[];
}) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((row, index) => (
        <PopularTracksSection
          key={row.id}
          title={
            row.basis.kind === "similarToTrack"
              ? t("forYou.becausePlayed", { title: row.basis.seed.title })
              : row.basis.kind === "moreFromArtist"
                ? t("forYou.becauseArtist", { artist: row.basis.artistName })
                : t("forYou.recoGenreTitle", { label: row.basis.label })
          }
          subtitle={t("forYou.recoSubtitle")}
          items={toPopularItems(row.tracks)}
          headingMarginTop={margins[index] ?? "mt-[22px]"}
        />
      ))}
    </>
  );
}
