// The Listening History feed (interface slice S2): the one
// chronological history, shared by the /space/history page and
// (later) the queue page's History tab. It is the same merged
// stream the statistics aggregate reads — device log authoritative
// from its start, server history before it, a play appearing once —
// walked a page at a time within the same stated bound, loading
// more on demand. Guests get the device log alone; the server is
// never called for them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/shared/api";
import {
  loadWithRetry,
  useSessionOwner,
} from "@/features/home/hooks/sessionAwareLoad";
import {
  groupHistoryByDay,
  mergePlayEvents,
  WALK_PAGE_SIZE,
  type HistoryDayGroup,
} from "../lib/listeningStats";
import {
  applyWalkPage,
  emptyWalk,
  type HistoryPageFetcher,
  type WalkState,
} from "../lib/historyWalk";
import { readDevicePlayEvents } from "../lib/playLog";
import type { CachedPlayEventRecord } from "@/shared/storage/linerDb";
import type { PlaybackHistoryItem } from "@/shared/contracts/history";

export type ListeningHistoryState =
  | { status: "loading" }
  | { status: "failed"; retry: () => void }
  | {
      status: "ready";
      groups: HistoryDayGroup[];
      totalEvents: number;
      /** More pages exist inside the bound. */
      hasMore: boolean;
      /** The walk stopped at a bound (pages / events / months). */
      boundReached: boolean;
      loadingMore: boolean;
      /** A load-more attempt failed; the rows on screen stand. */
      loadMoreFailed: boolean;
      loadMore: () => void;
      retry: () => void;
    };

const defaultFetchPage: HistoryPageFetcher = (cursor) =>
  loadWithRetry(
    () => api.getHistory(cursor, WALK_PAGE_SIZE),
    () => true,
  );

interface Feed {
  walk: WalkState;
  deviceRecords: CachedPlayEventRecord[];
}

export function useListeningHistory(): ListeningHistoryState {
  const owner = useSessionOwner();
  const [status, setStatus] = useState<"loading" | "failed" | "ready">(
    "loading",
  );
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const attemptRef = useRef(0);
  const feedRef = useRef<Feed | null>(null);

  const start = useCallback(async () => {
    const attempt = ++attemptRef.current;
    setStatus("loading");
    setLoadMoreFailed(false);
    try {
      const deviceRecords = await readDevicePlayEvents();
      if (attemptRef.current !== attempt) return;
      if (!owner) {
        const guestFeed: Feed = {
          walk: { ...emptyWalk(), complete: true },
          deviceRecords,
        };
        feedRef.current = guestFeed;
        setFeed(guestFeed);
        setStatus("ready");
        return;
      }
      const first = await defaultFetchPage(undefined);
      if (attemptRef.current !== attempt) return;
      const next: Feed = {
        walk: applyWalkPage(emptyWalk(), first, Date.now()),
        deviceRecords,
      };
      feedRef.current = next;
      setFeed(next);
      setStatus("ready");
    } catch {
      if (attemptRef.current !== attempt) return;
      setStatus("failed");
    }
  }, [owner]);

  useEffect(() => {
    void start();
  }, [start]);

  const loadMore = useCallback(() => {
    const current = feedRef.current;
    if (!current || loadingMore) return;
    const { walk } = current;
    if (walk.complete || walk.truncatedBy || !walk.nextCursor) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    void (async () => {
      const attempt = attemptRef.current;
      try {
        const response = await defaultFetchPage(walk.nextCursor ?? undefined);
        if (attemptRef.current !== attempt) return;
        const next: Feed = {
          walk: applyWalkPage(current.walk, response, Date.now()),
          deviceRecords: current.deviceRecords,
        };
        feedRef.current = next;
        setFeed(next);
      } catch {
        if (attemptRef.current !== attempt) return;
        setLoadMoreFailed(true);
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [loadingMore]);

  const merged = useMemo(() => {
    if (!feed) return null;
    const serverItems: PlaybackHistoryItem[] = feed.walk.items;
    return mergePlayEvents(serverItems, feed.deviceRecords);
  }, [feed]);

  if (status === "loading") return { status: "loading" };
  if (status === "failed" || !feed || !merged) {
    return { status: "failed", retry: () => void start() };
  }

  return {
    status: "ready",
    groups: groupHistoryByDay(merged.events),
    totalEvents: merged.events.length,
    hasMore: !feed.walk.complete && !feed.walk.truncatedBy,
    boundReached: feed.walk.truncatedBy !== null,
    loadingMore,
    loadMoreFailed,
    loadMore,
    retry: () => void start(),
  };
}
