// The Your Space dashboard's data hook (interface slice S2).
//
// Signed-in: the bounded server walk + the device log + the joins
// summary, merged by the pure aggregator. The last good aggregate
// is cached per listener and renders immediately, MARKED STALE,
// while the walk re-runs; if the walk then fails, the cached
// numbers stay on screen with the failure stated — failure never
// masquerades as emptiness, and emptiness never masquerades as
// failure. With no cache, a failed walk is the failure state.
//
// Guest: there is no server history to walk. The hook short-
// circuits to the device-local summary (taste weights + this
// device's own log) and never calls the history endpoint.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/shared/api";
import {
  loadWithRetry,
  useSessionOwner,
} from "@/features/home/hooks/sessionAwareLoad";
import { labelsForTrack } from "@/features/genres/trackGenres";
import { getTasteProfile } from "@/features/mixer/engine/tasteTracker";
import { topArtists } from "@/features/mixer/engine/tasteProfile";
import {
  aggregateListeningStats,
  buildGuestSummary,
  WALK_PAGE_SIZE,
  type GuestSpaceSummary,
  type ListeningStats,
} from "../lib/listeningStats";
import { walkAllHistory, type HistoryPageFetcher } from "../lib/historyWalk";
import { readDevicePlayEvents } from "../lib/playLog";
import { readJoinSummary } from "../lib/joinsReader";
import { readCachedStats, writeCachedStats } from "../lib/statsCache";

export type ListeningStatsState =
  | { status: "loading" }
  | { status: "failed"; retry: () => void }
  | { status: "guest"; summary: GuestSpaceSummary }
  | {
      status: "ready";
      stats: ListeningStats;
      /** Showing the cached aggregate (before or despite a refresh). */
      stale: boolean;
      /** The latest refresh attempt failed over cached numbers. */
      refreshFailed: boolean;
      retry: () => void;
    };

export interface ListeningStatsDeps {
  fetchPage: HistoryPageFetcher;
  readDevice: typeof readDevicePlayEvents;
  readJoins: typeof readJoinSummary;
  nowMs: number;
}

/** The full signed-in read: walk + device log + joins → aggregate. */
export async function loadListeningStats(
  deps: ListeningStatsDeps,
): Promise<ListeningStats> {
  const [walk, deviceRecords, joins] = await Promise.all([
    walkAllHistory(deps.fetchPage, deps.nowMs),
    deps.readDevice(),
    deps.readJoins(),
  ]);
  return aggregateListeningStats({
    serverItems: walk.items,
    deviceRecords,
    labelsFor: labelsForTrack,
    joins,
    walk: { complete: walk.complete, truncatedBy: walk.truncatedBy },
    nowMs: deps.nowMs,
  });
}

const defaultFetchPage: HistoryPageFetcher = (cursor) =>
  loadWithRetry(
    () => api.getHistory(cursor, WALK_PAGE_SIZE),
    () => true,
  );

export function useListeningStats(): ListeningStatsState {
  const owner = useSessionOwner();
  const [state, setState] = useState<ListeningStatsState>({
    status: "loading",
  });
  const attemptRef = useRef(0);

  const run = useCallback(async () => {
    const attempt = ++attemptRef.current;

    if (!owner) {
      // Guest short-circuit: no server call is made at all.
      const deviceRecords = await readDevicePlayEvents();
      if (attemptRef.current !== attempt) return;
      const taste = topArtists(getTasteProfile(), Date.now(), 10);
      setState({
        status: "guest",
        summary: buildGuestSummary(taste, deviceRecords),
      });
      return;
    }

    const cached = readCachedStats(owner);
    if (cached) {
      setState({
        status: "ready",
        stats: cached.stats,
        stale: true,
        refreshFailed: false,
        retry: () => void run(),
      });
    } else {
      setState({ status: "loading" });
    }

    try {
      const stats = await loadListeningStats({
        fetchPage: defaultFetchPage,
        readDevice: readDevicePlayEvents,
        readJoins: readJoinSummary,
        nowMs: Date.now(),
      });
      if (attemptRef.current !== attempt) return;
      writeCachedStats(owner, stats);
      setState({
        status: "ready",
        stats,
        stale: false,
        refreshFailed: false,
        retry: () => void run(),
      });
    } catch {
      if (attemptRef.current !== attempt) return;
      if (cached) {
        setState({
          status: "ready",
          stats: cached.stats,
          stale: true,
          refreshFailed: true,
          retry: () => void run(),
        });
      } else {
        setState({ status: "failed", retry: () => void run() });
      }
    }
  }, [owner]);

  useEffect(() => {
    void run();
  }, [run]);

  return state;
}
