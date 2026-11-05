// Listening statistics — the pure read model (interface slice S2).
//
// Two sources feed it, under the user's HYBRID ruling (2026-11-03):
//
// - the SERVER playback history (api.getHistory): the account's
//   record, walked by cursor under a stated bound;
// - the ON-DEVICE play log (linerDb `plays` store): plays this
//   device observed itself, written from the day the log shipped.
//
// MERGE DISCIPLINE (the ruling's core): a play counts ONCE. The
// device log is authoritative from its start instant — server
// events at or after that instant are dropped, and a server event
// whose playback session the device log also carries is dropped at
// any instant (the same play reported twice is one play). The
// server history is the record BEFORE the device log begins.
//
// COUNTING RULE: a play counts at 30 seconds or half the track,
// whichever comes first — playedDurationMs >= 30_000 OR
// completionRate >= 0.5. Listening TIME sums actual played time
// over every event; the rule governs counts only.
//
// Everything here is pure: sources arrive as arguments, genre
// labels arrive through an injected lookup, and `now` is a
// parameter — the hooks do the fetching and the clocks.

import { toClientTrack } from "@/shared/api";
import { isArtistId } from "@/features/artist/lib/artistResolver";
import type { PlaybackHistoryItem } from "@/shared/contracts/history";
import type { CachedPlayEventRecord } from "@/shared/storage/linerDb";
import type { Track } from "@/shared/types";
import type { TrackLabels } from "@/features/genres/trackGenres";

/** The counting rule's two thresholds (see header). */
export const COUNT_MIN_PLAYED_MS = 30_000;
export const COUNT_MIN_COMPLETION = 0.5;

/** The server-walk bound: pages of 100, events, and wall-clock span. */
export const WALK_PAGE_SIZE = 100;
export const WALK_MAX_PAGES = 20;
export const WALK_MAX_EVENTS = 2_000;
export const WALK_MAX_MONTHS = 13;

/** Below this many counted plays the dashboard is a starting state. */
export const THIN_FLOOR_COUNTED_PLAYS = 10;

/** Movement compares the last 28 days against the 28 before them. */
export const MOVEMENT_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

/** One play, normalized across both sources. */
export interface PlayEvent {
  track: Track;
  playedDurationMs: number;
  completionRate: number;
  completed: boolean;
  skipped: boolean;
  loopCount: number;
  hasSeekBackward: boolean;
  contextType?: string;
  listenedAtMs: number;
  source: "server" | "device";
}

export function countsAsPlay(event: PlayEvent): boolean {
  return (
    event.playedDurationMs >= COUNT_MIN_PLAYED_MS ||
    event.completionRate >= COUNT_MIN_COMPLETION
  );
}

export function serverItemToPlayEvent(item: PlaybackHistoryItem): PlayEvent {
  return {
    track: toClientTrack(item.track),
    playedDurationMs: item.playedDurationMs,
    completionRate: item.completionRate,
    completed: item.completed,
    skipped: item.skipped,
    loopCount: item.loopCount,
    hasSeekBackward: item.hasSeekBackward,
    contextType: item.context?.type,
    listenedAtMs: Date.parse(item.listenedAt),
    source: "server",
  };
}

export function deviceRecordToPlayEvent(
  record: CachedPlayEventRecord,
): PlayEvent {
  return {
    track: record.track,
    playedDurationMs: record.playedDurationMs,
    completionRate: record.completionRate,
    completed: record.completed,
    skipped: record.skipped,
    loopCount: record.loopCount,
    hasSeekBackward: record.hasSeekBackward,
    contextType: record.contextType,
    listenedAtMs: record.listenedAtMs,
    source: "device",
  };
}

export interface MergeResult {
  /** Merged events, newest first. Each play appears exactly once. */
  events: PlayEvent[];
  /** The device log's start instant (its earliest event), or null. */
  deviceStartMs: number | null;
  serverEventsUsed: number;
  deviceEventsUsed: number;
}

/**
 * The count-once merge. Server items arrive newest-first (walk
 * order), device records oldest-first (store order); both are
 * re-sorted defensively so callers cannot break the discipline by
 * handing over an unordered page.
 */
export function mergePlayEvents(
  serverItems: readonly PlaybackHistoryItem[],
  deviceRecords: readonly CachedPlayEventRecord[],
): MergeResult {
  const deviceEvents = deviceRecords
    .map(deviceRecordToPlayEvent)
    .sort((a, b) => a.listenedAtMs - b.listenedAtMs);
  const deviceStartMs =
    deviceEvents.length > 0 ? deviceEvents[0].listenedAtMs : null;
  const deviceSessions = new Set(
    deviceRecords
      .map((r) => r.playbackSessionId)
      .filter((id) => typeof id === "string" && id.length > 0),
  );

  const serverEvents: PlayEvent[] = [];
  for (const item of serverItems) {
    const at = Date.parse(item.listenedAt);
    if (!Number.isFinite(at)) continue;
    // The device log owns its span: a server event inside it is the
    // same listening, already recorded by the device itself.
    if (deviceStartMs !== null && at >= deviceStartMs) continue;
    // The same play under both reports, at any instant.
    if (item.playbackSessionId && deviceSessions.has(item.playbackSessionId))
      continue;
    serverEvents.push(serverItemToPlayEvent(item));
  }

  const events = [...deviceEvents, ...serverEvents].sort(
    (a, b) => b.listenedAtMs - a.listenedAtMs,
  );
  return {
    events,
    deviceStartMs,
    serverEventsUsed: serverEvents.length,
    deviceEventsUsed: deviceEvents.length,
  };
}

// ------------------------------------------------------------------
// Local-day bucketing (dates are local days, stated)
// ------------------------------------------------------------------

export function localDayStartMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The local day start one calendar day before a local day start.
 * Calendar stepping, not 24 h arithmetic — days are 23/25 h across
 * DST transitions and the buckets must agree with localDayStartMs. */
export function previousDayStartMs(dayStartMs: number): number {
  const d = new Date(dayStartMs);
  d.setDate(d.getDate() - 1);
  return localDayStartMs(d.getTime());
}

export interface DayBucket {
  dayStartMs: number;
  events: number;
  countedPlays: number;
  listeningMs: number;
}

// ------------------------------------------------------------------
// The aggregate
// ------------------------------------------------------------------

/**
 * The DJ block's input: what the behaviour record honestly holds,
 * precomputed by the joins reader. Null when no records exist at
 * all. There is no evaluation grade in the record and none is
 * reported here — the summary counts outcomes by their recorded
 * reason: joins the draw performed, joins a person triggered,
 * fallbacks/degradations by kind, and set-end markers.
 */
export interface JoinSummary {
  /** Joins the autonomous draw performed (reason "performed"). */
  performed: number;
  /** Joins a person triggered manually (reason "user-act"). */
  userAct: number;
  /** Plain cuts because the drawn track was unprepared. */
  fallbackUnprepared: number;
  /** Plain cuts because the drawn recipe failed validation. */
  fallbackInvalid: number;
  /** Joins that sounded at rate 1 on untrusted tempo/grid evidence. */
  degradedUntrusted: number;
  /** Records that closed a set without a join (reason "set-end"). */
  setEnd: number;
}

export type WalkTruncation = "pages" | "events" | "months";

export interface ListeningCoverage {
  /** Merged events (counted and not). */
  events: number;
  countedPlays: number;
  /** Earliest / latest merged event instants; null when empty. */
  fromMs: number | null;
  toMs: number | null;
  /** True only when the server walk reached the history's end. */
  complete: boolean;
  truncatedBy: WalkTruncation | null;
  serverEvents: number;
  deviceEvents: number;
  /** Where the device log takes over; null when it has no events. */
  deviceStartMs: number | null;
  /** Earliest server event used; null when none were. */
  serverFromMs: number | null;
}

export interface RankedArtist {
  name: string;
  plays: number;
  /** Cover of this artist's most recent counted play, for the portrait row. */
  coverUrl: string;
  /**
   * The primary artist's id, taken from a counted play of this
   * artist — the portrait's door to the artist page. Absent when no
   * counted play carried a usable id; the surface then renders the
   * portrait without a link rather than guessing a target.
   */
  artistId?: string;
}

export interface RankedTrack {
  track: Track;
  plays: number;
}

export interface RankedLabel {
  label: string;
  plays: number;
}

export interface MovementEntry {
  label: string;
  /**
   * Artist entries only: the primary artist's id, under the same
   * rule as RankedArtist.artistId. Genre entries never carry one.
   */
  artistId?: string;
  currentPlays: number;
  previousPlays: number;
  /** Null when the label fell out of the current window's ranking. */
  currentRank: number | null;
  /** Null when the label was absent from the previous window. */
  previousRank: number | null;
}

export interface ListeningMovement {
  artists: MovementEntry[];
  playlistGenres: MovementEntry[];
}

export interface ListeningStats {
  countedPlays: number;
  totalEvents: number;
  /** Actual played time over ALL merged events, counted or not. */
  totalListeningMs: number;
  skipCount: number;
  /** Skips over all events; null when there are no events. */
  skipRate: number | null;
  /** In-track loops (loopCount summed over all events). */
  loopCount: number;
  /** Counted plays of a track beyond its first counted play. */
  replayCount: number;
  topArtists: RankedArtist[];
  topTracks: RankedTrack[];
  /** Playlist Genre weights over counted plays, in full. */
  playlistGenres: RankedLabel[];
  /** Basic Genre over counted plays — only labels tracks actually carry. */
  basicGenres: RankedLabel[];
  /** Null when either movement window holds no counted plays. */
  movement: ListeningMovement | null;
  currentStreakDays: number;
  activeDays: number;
  /** Per local day, oldest first — the calendar's raw material. */
  days: DayBucket[];
  joins: JoinSummary | null;
  coverage: ListeningCoverage;
}

export interface AggregateInput {
  serverItems: readonly PlaybackHistoryItem[];
  deviceRecords: readonly CachedPlayEventRecord[];
  labelsFor: (trackId: string) => TrackLabels;
  joins: JoinSummary | null;
  walk: { complete: boolean; truncatedBy: WalkTruncation | null };
  nowMs: number;
}

function artistNameOf(track: Track): string {
  const listed = track.artistList?.[0]?.name;
  if (listed && listed.trim().length > 0) return listed;
  return track.artists;
}

/**
 * The id that pairs with artistNameOf(track)'s name, resolved under
 * the same rule that produced the name: when the name came from the
 * track's artist list, the id is that entry's; when it came from the
 * joined artist string, the id is the track's primary artistId. An
 * id counts only under the artist feature's own rule (isArtistId) —
 * anything else means this play cannot resolve the artist's page.
 */
function primaryArtistIdOf(track: Track): string | undefined {
  const listed = track.artistList?.[0];
  if (listed?.name && listed.name.trim().length > 0) {
    return isArtistId(listed.id) ? listed.id : undefined;
  }
  return isArtistId(track.artistId) ? track.artistId : undefined;
}

function rankLabels(counts: Map<string, number>): RankedLabel[] {
  return [...counts.entries()]
    .map(([label, plays]) => ({ label, plays }))
    .sort((a, b) => b.plays - a.plays || a.label.localeCompare(b.label));
}

function movementFor(
  current: Map<string, number>,
  previous: Map<string, number>,
  limit: number,
  ids?: ReadonlyMap<string, string>,
): MovementEntry[] {
  const rankOf = (counts: Map<string, number>) => {
    const order = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    return new Map(order.map(([label], i) => [label, i + 1]));
  };
  const currentRanks = rankOf(current);
  const previousRanks = rankOf(previous);
  const labels = new Set([...current.keys(), ...previous.keys()]);
  const entries: MovementEntry[] = [];
  for (const label of labels) {
    const currentRank = currentRanks.get(label);
    const previousRank = previousRanks.get(label);
    if (currentRank === undefined && previousRank === undefined) continue;
    if (
      (currentRank === undefined || currentRank > limit) &&
      (previousRank === undefined || previousRank > limit)
    )
      continue;
    const artistId = ids?.get(label);
    entries.push({
      label,
      ...(artistId ? { artistId } : {}),
      currentPlays: current.get(label) ?? 0,
      previousPlays: previous.get(label) ?? 0,
      currentRank: currentRank ?? null,
      previousRank: previousRank ?? null,
    });
  }
  return entries
    .sort(
      (a, b) =>
        (a.currentRank ?? Number.POSITIVE_INFINITY) -
          (b.currentRank ?? Number.POSITIVE_INFINITY) ||
        (a.previousRank ?? Number.POSITIVE_INFINITY) -
          (b.previousRank ?? Number.POSITIVE_INFINITY) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, limit);
}

export function aggregateListeningStats(input: AggregateInput): ListeningStats {
  const merged = mergePlayEvents(input.serverItems, input.deviceRecords);
  const events = merged.events;
  const counted = events.filter(countsAsPlay);

  let totalListeningMs = 0;
  let skipCount = 0;
  let loopCount = 0;
  for (const event of events) {
    totalListeningMs += Math.max(0, event.playedDurationMs);
    if (event.skipped) skipCount += 1;
    loopCount += Math.max(0, event.loopCount);
  }

  const artistCounts = new Map<
    string,
    { plays: number; coverUrl: string; artistId?: string }
  >();
  const trackCounts = new Map<
    string,
    { track: Track; plays: number; lastAt: number }
  >();
  const playlistGenreCounts = new Map<string, number>();
  const basicGenreCounts = new Map<string, number>();
  // Movement windows over counted plays: [now-28d, now] vs [now-56d, now-28d).
  const curArtists = new Map<string, number>();
  const prevArtists = new Map<string, number>();
  const curGenres = new Map<string, number>();
  const prevGenres = new Map<string, number>();
  const curStart = input.nowMs - MOVEMENT_WINDOW_MS;
  const prevStart = input.nowMs - 2 * MOVEMENT_WINDOW_MS;

  for (const event of counted) {
    const name = artistNameOf(event.track);
    const artist = artistCounts.get(name);
    if (artist) {
      artist.plays += 1;
      // The first counted play carrying a usable id resolves the
      // artist's page; a play without one never blocks a later one.
      if (!artist.artistId) artist.artistId = primaryArtistIdOf(event.track);
    } else {
      artistCounts.set(name, {
        plays: 1,
        coverUrl: event.track.coverUrl,
        artistId: primaryArtistIdOf(event.track),
      });
    }

    const seen = trackCounts.get(event.track.id);
    if (seen) {
      seen.plays += 1;
      if (event.listenedAtMs > seen.lastAt) {
        seen.lastAt = event.listenedAtMs;
        seen.track = event.track;
      }
    } else {
      trackCounts.set(event.track.id, {
        track: event.track,
        plays: 1,
        lastAt: event.listenedAtMs,
      });
    }

    const labels = input.labelsFor(event.track.id);
    for (const label of labels.playlistGenres) {
      playlistGenreCounts.set(label, (playlistGenreCounts.get(label) ?? 0) + 1);
    }
    for (const label of labels.genres) {
      basicGenreCounts.set(label, (basicGenreCounts.get(label) ?? 0) + 1);
    }

    const inCurrent = event.listenedAtMs >= curStart;
    const inPrevious =
      event.listenedAtMs >= prevStart && event.listenedAtMs < curStart;
    if (inCurrent || inPrevious) {
      const artistWindow = inCurrent ? curArtists : prevArtists;
      artistWindow.set(name, (artistWindow.get(name) ?? 0) + 1);
      const genreWindow = inCurrent ? curGenres : prevGenres;
      for (const label of labels.playlistGenres) {
        genreWindow.set(label, (genreWindow.get(label) ?? 0) + 1);
      }
    }
  }

  let replayCount = 0;
  for (const entry of trackCounts.values()) {
    if (entry.plays > 1) replayCount += entry.plays - 1;
  }

  const topArtists: RankedArtist[] = [...artistCounts.entries()]
    .map(([name, v]) => ({
      name,
      plays: v.plays,
      coverUrl: v.coverUrl,
      ...(v.artistId ? { artistId: v.artistId } : {}),
    }))
    .sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name))
    .slice(0, 10);

  const topTracks: RankedTrack[] = [...trackCounts.values()]
    .sort(
      (a, b) =>
        b.plays - a.plays ||
        b.lastAt - a.lastAt ||
        a.track.id.localeCompare(b.track.id),
    )
    .slice(0, 10)
    .map(({ track, plays }) => ({ track, plays }));

  // Day buckets over ALL merged events (the calendar counts days the
  // listener showed up; counted plays ride along per day).
  const dayMap = new Map<number, DayBucket>();
  for (const event of events) {
    const start = localDayStartMs(event.listenedAtMs);
    let bucket = dayMap.get(start);
    if (!bucket) {
      bucket = {
        dayStartMs: start,
        events: 0,
        countedPlays: 0,
        listeningMs: 0,
      };
      dayMap.set(start, bucket);
    }
    bucket.events += 1;
    bucket.listeningMs += Math.max(0, event.playedDurationMs);
    if (countsAsPlay(event)) bucket.countedPlays += 1;
  }
  const days = [...dayMap.values()].sort((a, b) => a.dayStartMs - b.dayStartMs);

  const countedDays = new Set(
    counted.map((e) => localDayStartMs(e.listenedAtMs)),
  );
  const todayStart = localDayStartMs(input.nowMs);
  const yesterdayStart = previousDayStartMs(todayStart);
  let streakEnd: number | null = null;
  if (countedDays.has(todayStart)) streakEnd = todayStart;
  else if (countedDays.has(yesterdayStart)) streakEnd = yesterdayStart;
  let currentStreakDays = 0;
  if (streakEnd !== null) {
    let cursor = streakEnd;
    while (countedDays.has(cursor)) {
      currentStreakDays += 1;
      cursor = previousDayStartMs(cursor);
    }
  }

  const artistIds = new Map<string, string>();
  for (const [name, v] of artistCounts) {
    if (v.artistId) artistIds.set(name, v.artistId);
  }
  const hasCurrent = [...curArtists.values()].some((n) => n > 0);
  const hasPrevious = [...prevArtists.values()].some((n) => n > 0);
  const movement: ListeningMovement | null =
    hasCurrent && hasPrevious
      ? {
          artists: movementFor(curArtists, prevArtists, 5, artistIds),
          playlistGenres: movementFor(curGenres, prevGenres, 5),
        }
      : null;

  const serverFromMs =
    merged.serverEventsUsed > 0
      ? Math.min(
          ...events
            .filter((e) => e.source === "server")
            .map((e) => e.listenedAtMs),
        )
      : null;

  return {
    countedPlays: counted.length,
    totalEvents: events.length,
    totalListeningMs,
    skipCount,
    skipRate: events.length > 0 ? skipCount / events.length : null,
    loopCount,
    replayCount,
    topArtists,
    topTracks,
    playlistGenres: rankLabels(playlistGenreCounts),
    basicGenres: rankLabels(basicGenreCounts),
    movement,
    currentStreakDays,
    activeDays: countedDays.size,
    days,
    joins: input.joins,
    coverage: {
      events: events.length,
      countedPlays: counted.length,
      fromMs: events.length > 0 ? events[events.length - 1].listenedAtMs : null,
      toMs: events.length > 0 ? events[0].listenedAtMs : null,
      complete: input.walk.complete,
      truncatedBy: input.walk.truncatedBy,
      serverEvents: merged.serverEventsUsed,
      deviceEvents: merged.deviceEventsUsed,
      deviceStartMs: merged.deviceStartMs,
      serverFromMs,
    },
  };
}

// ------------------------------------------------------------------
// Guest / device summary
// ------------------------------------------------------------------

export interface GuestSpaceSummary {
  /** Taste-profile weights (ranks, not counts), strongest first. */
  tasteTopArtists: { artist: string; weight: number }[];
  /** This device's own log, when it holds anything; null — never zeroes. */
  device: { countedPlays: number; listeningMs: number; sinceMs: number } | null;
}

export function buildGuestSummary(
  tasteTopArtists: readonly { artist: string; weight: number }[],
  deviceRecords: readonly CachedPlayEventRecord[],
): GuestSpaceSummary {
  const events = deviceRecords
    .map(deviceRecordToPlayEvent)
    .sort((a, b) => a.listenedAtMs - b.listenedAtMs);
  return {
    tasteTopArtists: tasteTopArtists.filter((a) => a.weight > 0).slice(0, 10),
    device:
      events.length > 0
        ? {
            countedPlays: events.filter(countsAsPlay).length,
            listeningMs: events.reduce(
              (sum, e) => sum + Math.max(0, e.playedDurationMs),
              0,
            ),
            sinceMs: events[0].listenedAtMs,
          }
        : null,
  };
}

// ------------------------------------------------------------------
// History presentation
// ------------------------------------------------------------------

export interface HistoryDayGroup {
  dayStartMs: number;
  /** Events within the day, newest first. */
  events: PlayEvent[];
}

/** Groups a newest-first event stream into local days, newest day first. */
export function groupHistoryByDay(
  events: readonly PlayEvent[],
): HistoryDayGroup[] {
  const groups = new Map<number, PlayEvent[]>();
  for (const event of events) {
    const start = localDayStartMs(event.listenedAtMs);
    const group = groups.get(start);
    if (group) group.push(event);
    else groups.set(start, [event]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([dayStartMs, dayEvents]) => ({
      dayStartMs,
      events: [...dayEvents].sort((a, b) => b.listenedAtMs - a.listenedAtMs),
    }));
}
