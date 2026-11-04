// The bounded server-history walk (interface slice S2), shared by
// the statistics aggregate (walks to the end) and the history feed
// (walks a page at a time). The bound is stated, not implied: 20
// pages of 100, 2,000 events, 13 months of wall-clock — whichever
// comes first — and `complete` is true ONLY when the walk reached
// the history's actual end. A statistics surface that hides its
// denominator would break the register's spirit even with true
// numerators, so every stop carries its reason.

import type {
  PlaybackHistoryResponse,
  PlaybackHistoryItem,
} from "@/shared/contracts/history";
import {
  WALK_MAX_EVENTS,
  WALK_MAX_MONTHS,
  WALK_MAX_PAGES,
  type WalkTruncation,
} from "./listeningStats";

export interface WalkState {
  /** Accumulated items, newest first, inside the bound. */
  items: PlaybackHistoryItem[];
  pages: number;
  /** True only when the history's end was reached. */
  complete: boolean;
  truncatedBy: WalkTruncation | null;
  /** Cursor for the next page; null when the walk cannot continue. */
  nextCursor: string | null;
}

export function emptyWalk(): WalkState {
  return {
    items: [],
    pages: 0,
    complete: false,
    truncatedBy: null,
    nextCursor: null,
  };
}

/** The walk's oldest reachable instant: 13 calendar months back. */
export function walkCutoffMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setMonth(d.getMonth() - WALK_MAX_MONTHS);
  return d.getTime();
}

function itemMs(item: PlaybackHistoryItem): number {
  return Date.parse(item.listenedAt);
}

/**
 * Folds one fetched page into the walk. Pure: the caller owns the
 * fetching, this owns the bound. Once the walk has stopped
 * (complete or truncated), further pages change nothing.
 */
export function applyWalkPage(
  state: WalkState,
  response: PlaybackHistoryResponse,
  nowMs: number,
): WalkState {
  if (state.complete || state.truncatedBy) return state;

  const cutoff = walkCutoffMs(nowMs);
  const fresh: PlaybackHistoryItem[] = [];
  let crossedMonths = false;
  for (const item of response.items ?? []) {
    const at = itemMs(item);
    if (!Number.isFinite(at)) continue;
    if (at < cutoff) {
      crossedMonths = true;
      continue;
    }
    fresh.push(item);
  }

  let items = [...state.items, ...fresh];
  let truncatedBy: WalkTruncation | null = null;
  if (items.length > WALK_MAX_EVENTS) {
    items = items.slice(0, WALK_MAX_EVENTS);
    truncatedBy = "events";
  }
  if (crossedMonths) truncatedBy = "months";

  const pages = state.pages + 1;
  const reachedEnd = response.nextCursor === null;
  if (!truncatedBy && !reachedEnd && pages >= WALK_MAX_PAGES) {
    truncatedBy = "pages";
  }

  const complete = reachedEnd && !truncatedBy;
  return {
    items,
    pages,
    complete,
    truncatedBy,
    nextCursor: complete || truncatedBy ? null : response.nextCursor,
  };
}

export type HistoryPageFetcher = (
  cursor?: string,
) => Promise<PlaybackHistoryResponse>;

/** Walks to the end of the bound (the statistics aggregate's read). */
export async function walkAllHistory(
  fetchPage: HistoryPageFetcher,
  nowMs: number,
): Promise<WalkState> {
  let state = emptyWalk();
  while (!state.complete && !state.truncatedBy) {
    const response = await fetchPage(state.nextCursor ?? undefined);
    state = applyWalkPage(state, response, nowMs);
  }
  return state;
}
