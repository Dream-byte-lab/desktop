// The last good statistics aggregate, per listener (interface
// slice S2). Honest states are the reason this exists: when a
// refresh fails or the app is offline, the dashboard renders this
// cache MARKED STALE rather than faking a fresh fetch or showing
// an error over data it already holds. It is a render cache, not
// a data source — the walk always re-runs on mount.

import type { ListeningStats } from "./listeningStats";

const CACHE_KEY_PREFIX = "liner_space_stats_cache_v1:";

export interface CachedStats {
  savedAtMs: number;
  stats: ListeningStats;
}

function keyFor(owner: string): string {
  return `${CACHE_KEY_PREFIX}${owner || "guest"}`;
}

export function readCachedStats(owner: string): CachedStats | null {
  try {
    const raw = localStorage.getItem(keyFor(owner));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedStats;
    if (
      !parsed ||
      typeof parsed.savedAtMs !== "number" ||
      !parsed.stats ||
      typeof parsed.stats.countedPlays !== "number"
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCachedStats(owner: string, stats: ListeningStats): void {
  try {
    const entry: CachedStats = { savedAtMs: Date.now(), stats };
    localStorage.setItem(keyFor(owner), JSON.stringify(entry));
  } catch {
    // A full or unavailable localStorage costs the stale fallback,
    // nothing else.
  }
}
