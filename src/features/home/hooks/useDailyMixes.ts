import { useEffect, useMemo } from "react";
import { useTranslation, type TFunction } from "@/languages";
import { queryCache } from "@/shared/cache/queryCache";
import type { Track } from "@/shared/types";
import type { CollectionPageData } from "@/features/collection/hooks/useCollection";
import { buildMixes, type ForYouMix } from "../lib/forYouFeed";
import { useDailyMixSnapshot, useForYouCandidates } from "./useForYouFeed";

export interface DailyMix {
  id: string;
  title: string;
  description: string;
  clusterArtists: string[];
  coverUrl?: string;
  trackCount: number;
  tracks: Track[];
}

export function getDailyMixArtists(
  clusterArtists?: string[],
  tracks?: Track[],
  targetCount: number = 4,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  const addName = (raw?: string) => {
    if (!raw) return;
    const name = raw.trim();
    if (
      !name ||
      name.toLowerCase() === "unknown" ||
      seen.has(name.toLowerCase())
    ) {
      return;
    }
    seen.add(name.toLowerCase());
    result.push(name);
  };

  if (Array.isArray(clusterArtists)) {
    for (const name of clusterArtists) {
      addName(name);
      if (result.length >= targetCount) return result;
    }
  }

  if (Array.isArray(tracks)) {
    for (const track of tracks) {
      if (track.artistList && track.artistList.length > 0) {
        for (const a of track.artistList) {
          addName(a.name);
          if (result.length >= targetCount) return result;
        }
      } else if (track.artists) {
        const parts = track.artists
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        for (const part of parts) {
          addName(part);
          if (result.length >= targetCount) return result;
        }
      }
    }
  }

  return result;
}

const EMPTY_MIXES: DailyMix[] = [];

function mixTitle(mix: ForYouMix, t: TFunction): string {
  switch (mix.basis.kind) {
    case "playlistGenre":
      return t("forYou.mixGenreTitle", { label: mix.basis.label });
    case "artistFamily":
      return t("forYou.mixArtistTitle", { artist: mix.basis.label });
    case "era":
      return t("forYou.mixEraTitle", { era: mix.basis.label });
    case "derivedEnergy":
      return mix.basis.label === "high"
        ? t("forYou.mixEnergyHighTitle")
        : t("forYou.mixEnergyLowTitle");
    case "derivedTempo":
      return mix.basis.label === "slow"
        ? t("forYou.mixTempoSlowTitle")
        : t("forYou.mixTempoDrivingTitle");
  }
}

function mixDescription(mix: ForYouMix, t: TFunction): string {
  switch (mix.basis.kind) {
    case "playlistGenre":
      return t("forYou.mixGenreSubtitle");
    case "artistFamily":
      return t("forYou.mixFamilySubtitle");
    case "era":
      return t("forYou.mixEraSubtitle");
    case "derivedEnergy":
      return t("forYou.moodsDerived");
    case "derivedTempo":
      return t("forYou.moodsDerived");
  }
}

function toDailyMix(mix: ForYouMix, t: TFunction): DailyMix {
  return {
    id: mix.id,
    title: mixTitle(mix, t),
    description: mixDescription(mix, t),
    clusterArtists: getDailyMixArtists(undefined, mix.tracks, 4),
    coverUrl: mix.tracks[0]?.coverUrl || undefined,
    trackCount: mix.tracks.length,
    tracks: mix.tracks,
  };
}

function primeMixCollections(mixes: DailyMix[]): void {
  for (const mix of mixes) {
    const collectionData: CollectionPageData = {
      type: "playlist",
      title: mix.title,
      author:
        mix.clusterArtists.length > 0
          ? mix.clusterArtists.join(", ")
          : "Daily Mix",
      description: mix.description,
      coverUrl: mix.coverUrl || "",
      tracks: mix.tracks,
    };
    queryCache.set(`collection:playlist:${mix.id}`, collectionData);
  }
}

export function dailyMixesCacheKey(owner: string): string {
  return `home:daily-mixes:${owner}`;
}

// The Home daily-mix rail runs on the same local engine as the
// For You feed: candidates are assembled from the listener's own
// evidence, mixes are built by the pure builder and frozen through
// the shared daily snapshot, so the rail and the feed page always
// show the same mixes. There is no server daily-mixes call any
// more. Guests assemble an empty universe (history is skipped and
// nothing is liked), so they get no mixes and the rail hides —
// the same outcome the server era produced.
export function useDailyMixes() {
  const { t } = useTranslation();
  const candidatesData = useForYouCandidates();

  const generated = buildMixes(candidatesData.candidates, {
    seedKey: candidatesData.seedKey,
    topArtists: candidatesData.topArtists,
  });
  const mixes = useDailyMixSnapshot(
    generated,
    candidatesData.byId,
    candidatesData.dateKey,
    candidatesData.settled,
  );

  const data = useMemo<DailyMix[]>(
    () => mixes.map((mix) => toDailyMix(mix, t)),
    [mixes, t],
  );

  useEffect(() => {
    if (data) primeMixCollections(data);
  }, [data]);

  return { data: data ?? EMPTY_MIXES, isLoading: candidatesData.isLoading };
}
