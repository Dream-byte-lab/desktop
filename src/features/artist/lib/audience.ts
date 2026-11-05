import type { ArtistPageData } from "../hooks/useArtist";

/**
 * The artist page's standing audience rule, shared by the artist
 * page and the search hero so the figure is labelled identically
 * in both places: the source's monthly-audience figure where the
 * source publishes one (YouTube-sourced artists), otherwise the
 * follower count — never both, never invented.
 */
export type ArtistAudience =
  { kind: "monthly"; count: string } | { kind: "followers"; count: string };

export function artistAudience(
  data: Pick<ArtistPageData, "monthlyListeners" | "followers">,
): ArtistAudience | null {
  if (data.monthlyListeners) {
    const match = data.monthlyListeners.match(/^([\d.,]+[KMBkmb]?)/);
    return { kind: "monthly", count: match ? match[1] : data.monthlyListeners };
  }
  if (data.followers) {
    return {
      kind: "followers",
      count: Intl.NumberFormat("en-US", { notation: "compact" }).format(
        data.followers,
      ),
    };
  }
  return null;
}
