// The merge discipline lives or dies here: pin the counting rule,
// the count-once merge (window + session dedupe), and every
// derivation the dashboard renders. TZ is set before anything
// computes a Date so the DST pins mean something.
process.env.TZ = "America/New_York";

import { describe, it, expect, vi } from "vitest";

vi.mock("@/shared/api", () => ({
  toClientTrack: (source: any) => ({
    id: source.id,
    title: source.title,
    artists: Array.isArray(source.artists)
      ? source.artists.map((a: any) => a.name).join(", ")
      : source.artists,
    artistList: Array.isArray(source.artists) ? source.artists : undefined,
    coverUrl: source.cover?.url ?? source.coverUrl ?? "",
    durationMs: source.durationMs ?? 0,
    playCount: 0,
    album: source.album,
  }),
}));

import {
  aggregateListeningStats,
  buildGuestSummary,
  countsAsPlay,
  groupHistoryByDay,
  localDayStartMs,
  mergePlayEvents,
  previousDayStartMs,
  type AggregateInput,
  type PlayEvent,
} from "./listeningStats";
import type { PlaybackHistoryItem } from "@/shared/contracts/history";
import type { CachedPlayEventRecord } from "@/shared/storage/linerDb";
import type { Track } from "@/shared/types";
import type { TrackLabels } from "@/features/genres/trackGenres";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A fixed "now": 2026-06-15 18:00 local.
const NOW = new Date(2026, 5, 15, 18, 0, 0).getTime();

function contractTrack(id: string, artist = "Ama Artist") {
  return {
    id,
    title: `Song ${id}`,
    artists: [{ id: `a-${artist}`, name: artist }],
    durationMs: 200_000,
    cover: { url: `cover-${id}`, width: 512, height: 512 },
  };
}

let serverSeq = 0;
function serverItem(
  over: Partial<PlaybackHistoryItem> = {},
): PlaybackHistoryItem {
  serverSeq += 1;
  return {
    id: `srv-${serverSeq}`,
    playbackSessionId: `sess-${serverSeq}`,
    listeningSessionId: "listen-1",
    track: contractTrack(`t${serverSeq}`) as PlaybackHistoryItem["track"],
    playedDurationMs: 120_000,
    completionRate: 0.6,
    completed: false,
    skipped: false,
    loopCount: 0,
    hasSeekBackward: false,
    listenedAt: new Date(NOW - HOUR).toISOString(),
    ...over,
  };
}

function clientTrack(id: string, artist = "Ama Artist"): Track {
  return {
    id,
    title: `Song ${id}`,
    artists: artist,
    artistList: [{ id: `a-${artist}`, name: artist }],
    coverUrl: `cover-${id}`,
    durationMs: 200_000,
    playCount: 0,
  };
}

let deviceSeq = 0;
function deviceRecord(
  over: Partial<CachedPlayEventRecord> = {},
): CachedPlayEventRecord {
  deviceSeq += 1;
  return {
    id: `dev-${deviceSeq}`,
    trackId: `dt${deviceSeq}`,
    track: clientTrack(`dt${deviceSeq}`),
    playedDurationMs: 120_000,
    completionRate: 0.6,
    completed: false,
    skipped: false,
    loopCount: 0,
    hasSeekBackward: false,
    playbackSessionId: `dev-sess-${deviceSeq}`,
    listenedAtMs: NOW - HOUR,
    ...over,
  };
}

const noLabels = (): TrackLabels => ({ playlistGenres: [], genres: [] });

function aggregate(
  over: Partial<AggregateInput> = {},
): ReturnType<typeof aggregateListeningStats> {
  return aggregateListeningStats({
    serverItems: [],
    deviceRecords: [],
    labelsFor: noLabels,
    joins: null,
    walk: { complete: true, truncatedBy: null },
    nowMs: NOW,
    ...over,
  });
}

function event(over: Partial<PlayEvent> = {}): PlayEvent {
  return {
    track: clientTrack("x"),
    playedDurationMs: 60_000,
    completionRate: 0.3,
    completed: false,
    skipped: false,
    loopCount: 0,
    hasSeekBackward: false,
    listenedAtMs: NOW,
    source: "server",
    ...over,
  };
}

describe("the counting rule", () => {
  it("does not count 29 seconds", () => {
    expect(
      countsAsPlay(event({ playedDurationMs: 29_000, completionRate: 0.1 })),
    ).toBe(false);
    const stats = aggregate({
      serverItems: [
        serverItem({ playedDurationMs: 29_000, completionRate: 0.1 }),
      ],
    });
    expect(stats.countedPlays).toBe(0);
    expect(stats.totalEvents).toBe(1);
  });

  it("counts at exactly 30 seconds", () => {
    expect(
      countsAsPlay(event({ playedDurationMs: 30_000, completionRate: 0.1 })),
    ).toBe(true);
  });

  it("counts at half the track, whichever comes first", () => {
    expect(
      countsAsPlay(event({ playedDurationMs: 5_000, completionRate: 0.5 })),
    ).toBe(true);
    expect(
      countsAsPlay(event({ playedDurationMs: 5_000, completionRate: 0.49 })),
    ).toBe(false);
  });
});

describe("the count-once merge", () => {
  const start = NOW - 7 * DAY;

  it("drops server events inside the device log's span", () => {
    const merged = mergePlayEvents(
      [
        serverItem({ listenedAt: new Date(start + HOUR).toISOString() }),
        serverItem({ listenedAt: new Date(start - DAY).toISOString() }),
      ],
      [
        deviceRecord({ listenedAtMs: start }),
        deviceRecord({ listenedAtMs: start + 2 * HOUR }),
      ],
    );
    expect(merged.deviceStartMs).toBe(start);
    expect(merged.deviceEventsUsed).toBe(2);
    expect(merged.serverEventsUsed).toBe(1);
    expect(merged.events).toHaveLength(3);
    expect(merged.events[0].listenedAtMs).toBe(start + 2 * HOUR);
  });

  it("drops a server event whose session the device log carries, at any instant", () => {
    const shared = deviceRecord({ listenedAtMs: start });
    const merged = mergePlayEvents(
      [
        serverItem({
          playbackSessionId: shared.playbackSessionId,
          listenedAt: new Date(start - 30 * DAY).toISOString(),
        }),
      ],
      [shared],
    );
    expect(merged.serverEventsUsed).toBe(0);
    expect(merged.events).toHaveLength(1);
    expect(merged.events[0].source).toBe("device");
  });

  it("never sums an overlapped play's time", () => {
    const stats = aggregate({
      serverItems: [
        serverItem({
          playedDurationMs: 90_000,
          listenedAt: new Date(start + 30 * 60_000).toISOString(),
        }),
      ],
      deviceRecords: [
        deviceRecord({ playedDurationMs: 90_000, listenedAtMs: start }),
      ],
    });
    // The server copy sits inside the device span: one play, 90 s.
    expect(stats.totalEvents).toBe(1);
    expect(stats.totalListeningMs).toBe(90_000);
    expect(stats.coverage.deviceStartMs).toBe(start);
    expect(stats.coverage.serverEvents).toBe(0);
    expect(stats.coverage.deviceEvents).toBe(1);
  });

  it("keeps both spans when they are disjoint", () => {
    const stats = aggregate({
      serverItems: [
        serverItem({ listenedAt: new Date(start - DAY).toISOString() }),
        serverItem({ listenedAt: new Date(start - 2 * DAY).toISOString() }),
      ],
      deviceRecords: [deviceRecord({ listenedAtMs: start })],
    });
    expect(stats.totalEvents).toBe(3);
    expect(stats.coverage.serverEvents).toBe(2);
    expect(stats.coverage.serverFromMs).toBe(start - 2 * DAY);
    expect(stats.coverage.deviceStartMs).toBe(start);
  });

  it("uses the server history alone when the device log is empty", () => {
    const stats = aggregate({
      serverItems: [serverItem(), serverItem()],
    });
    expect(stats.totalEvents).toBe(2);
    expect(stats.coverage.deviceStartMs).toBeNull();
    expect(stats.coverage.complete).toBe(true);
  });
});

describe("derivations", () => {
  it("sums listening time over ALL events, counted or not", () => {
    const stats = aggregate({
      serverItems: [
        serverItem({ playedDurationMs: 120_000, completionRate: 0.6 }),
        serverItem({
          playedDurationMs: 5_000,
          completionRate: 0.02,
          skipped: true,
        }),
      ],
    });
    expect(stats.totalListeningMs).toBe(125_000);
    expect(stats.countedPlays).toBe(1);
    expect(stats.skipCount).toBe(1);
    expect(stats.skipRate).toBe(0.5);
  });

  it("derives repeats from loop counts and replays", () => {
    const track = contractTrack("same") as PlaybackHistoryItem["track"];
    const stats = aggregate({
      serverItems: [
        serverItem({ track, loopCount: 2 }),
        serverItem({ track }),
        serverItem({ track }),
      ],
    });
    expect(stats.loopCount).toBe(2);
    expect(stats.replayCount).toBe(2);
  });

  it("ranks artists and tracks by counted plays only", () => {
    const ama = contractTrack("a1", "Ama") as PlaybackHistoryItem["track"];
    const ben = contractTrack("b1", "Ben") as PlaybackHistoryItem["track"];
    const stats = aggregate({
      serverItems: [
        serverItem({ track: ama }),
        serverItem({ track: ama }),
        serverItem({ track: ben }),
        // Ben's long-but-uncounted play must not rank him.
        serverItem({
          track: ben,
          playedDurationMs: 4_000,
          completionRate: 0.02,
        }),
      ],
    });
    expect(stats.topArtists.map((a) => [a.name, a.plays])).toEqual([
      ["Ama", 2],
      ["Ben", 1],
    ]);
    expect(stats.topTracks[0].track.id).toBe("a1");
    expect(stats.topTracks[0].plays).toBe(2);
  });

  it("weights Playlist Genres in full and basic Genre only where carried", () => {
    const labels: Record<string, TrackLabels> = {
      g1: { playlistGenres: ["Amapiano", "Chill"], genres: [] },
      g2: { playlistGenres: ["Amapiano"], genres: ["Jazz"] },
    };
    const stats = aggregate({
      serverItems: [
        serverItem({
          track: contractTrack("g1") as PlaybackHistoryItem["track"],
        }),
        serverItem({
          track: contractTrack("g2") as PlaybackHistoryItem["track"],
        }),
      ],
      labelsFor: (id) => labels[id] ?? noLabels(),
    });
    expect(stats.playlistGenres).toEqual([
      { label: "Amapiano", plays: 2 },
      { label: "Chill", plays: 1 },
    ]);
    expect(stats.basicGenres).toEqual([{ label: "Jazz", plays: 1 }]);
  });

  it("computes window movement with new and dropped labels", () => {
    const mk = (artist: string, at: number) =>
      serverItem({
        track: contractTrack(
          `m-${artist}-${at}`,
          artist,
        ) as PlaybackHistoryItem["track"],
        listenedAt: new Date(at).toISOString(),
      });
    const stats = aggregate({
      serverItems: [
        // Current window (last 28 days): Ama x3, Ben x1.
        mk("Ama", NOW - DAY),
        mk("Ama", NOW - 2 * DAY),
        mk("Ama", NOW - 3 * DAY),
        mk("Ben", NOW - DAY),
        // Previous window: Ben x2, Cid x1.
        mk("Ben", NOW - 30 * DAY),
        mk("Ben", NOW - 31 * DAY),
        mk("Cid", NOW - 32 * DAY),
      ],
    });
    expect(stats.movement).not.toBeNull();
    const byLabel = new Map(stats.movement!.artists.map((e) => [e.label, e]));
    expect(byLabel.get("Ama")).toMatchObject({
      currentPlays: 3,
      previousPlays: 0,
      currentRank: 1,
      previousRank: null,
    });
    expect(byLabel.get("Ben")).toMatchObject({
      currentPlays: 1,
      previousPlays: 2,
      currentRank: 2,
      previousRank: 1,
    });
    expect(byLabel.get("Cid")).toMatchObject({
      currentPlays: 0,
      previousRank: 2,
      currentRank: null,
    });
  });

  it("has no movement when a window is empty", () => {
    const stats = aggregate({ serverItems: [serverItem()] });
    expect(stats.movement).toBeNull();
  });
});

describe("artist ids — the space surfaces' doors", () => {
  it("carries the top artist's id from a counted play's artist list", () => {
    const stats = aggregate({ serverItems: [serverItem()] });
    // contractTrack's artist is "Ama Artist" with id "a-Ama Artist".
    expect(stats.topArtists[0]).toMatchObject({
      name: "Ama Artist",
      artistId: "a-Ama Artist",
    });
  });

  it("pairs a joined-string name with the track's primary artistId", () => {
    const stats = aggregate({
      deviceRecords: [
        deviceRecord({
          track: {
            ...clientTrack("solo-1", "Solo Name"),
            artistList: undefined,
            artistId: "a-solo",
          },
        }),
      ],
    });
    expect(stats.topArtists[0]).toMatchObject({
      name: "Solo Name",
      artistId: "a-solo",
    });
  });

  it("leaves the artist unresolved when no counted play carries a usable id", () => {
    const stats = aggregate({
      deviceRecords: [
        deviceRecord({
          track: {
            ...clientTrack("myst-1", "Mystery"),
            artistList: [{ id: "unknown", name: "Mystery" }],
            artistId: undefined,
          },
        }),
      ],
    });
    expect(stats.topArtists[0].name).toBe("Mystery");
    expect(stats.topArtists[0].artistId).toBeUndefined();
  });

  it("resolves from an older counted play when the newest carries no id", () => {
    const stats = aggregate({
      deviceRecords: [
        deviceRecord({
          track: {
            ...clientTrack("noid-1", "Ama Artist"),
            artistList: [{ id: "", name: "Ama Artist" }],
            artistId: undefined,
          },
          listenedAtMs: NOW - HOUR,
        }),
        deviceRecord({
          track: clientTrack("withid-1", "Ama Artist"),
          listenedAtMs: NOW - 2 * HOUR,
        }),
      ],
    });
    expect(stats.topArtists[0]).toMatchObject({
      name: "Ama Artist",
      plays: 2,
      artistId: "a-Ama Artist",
    });
  });

  it("carries ids on artist movement entries, never on genre entries", () => {
    const stats = aggregate({
      serverItems: [
        serverItem({
          track: contractTrack("mv-1") as PlaybackHistoryItem["track"],
          listenedAt: new Date(NOW - DAY).toISOString(),
        }),
        serverItem({
          track: contractTrack("mv-2") as PlaybackHistoryItem["track"],
          listenedAt: new Date(NOW - 30 * DAY).toISOString(),
        }),
      ],
      labelsFor: () => ({ playlistGenres: ["Amapiano"], genres: [] }),
    });
    expect(stats.movement).not.toBeNull();
    expect(stats.movement!.artists[0]).toMatchObject({
      label: "Ama Artist",
      artistId: "a-Ama Artist",
    });
    expect(stats.movement!.playlistGenres[0].label).toBe("Amapiano");
    expect(stats.movement!.playlistGenres[0].artistId).toBeUndefined();
  });
});

describe("days, streaks and the calendar across DST", () => {
  // America/New_York sprang forward on 2026-03-08: that local day
  // is 23 hours long. Buckets are local days, stated.
  const mar7 = new Date(2026, 2, 7, 12, 0).getTime();
  const mar8 = new Date(2026, 2, 8, 12, 0).getTime();
  const mar9 = new Date(2026, 2, 9, 12, 0).getTime();
  const nowMar9 = new Date(2026, 2, 9, 18, 0).getTime();

  it("steps day starts by calendar day, not 24 hours", () => {
    const start8 = localDayStartMs(mar8);
    const start9 = localDayStartMs(mar9);
    expect((start9 - start8) / HOUR).toBe(23);
    expect(previousDayStartMs(start9)).toBe(start8);
  });

  it("keeps a three-day streak unbroken across the jump", () => {
    const stats = aggregate({
      nowMs: nowMar9,
      serverItems: [mar7, mar8, mar9].map((at) =>
        serverItem({ listenedAt: new Date(at).toISOString() }),
      ),
    });
    expect(stats.activeDays).toBe(3);
    expect(stats.currentStreakDays).toBe(3);
    expect(stats.days.map((d) => d.countedPlays)).toEqual([1, 1, 1]);
  });

  it("buckets a post-jump instant into its own local day", () => {
    const afterJump = new Date(2026, 2, 8, 3, 30).getTime(); // EDT
    const stats = aggregate({
      nowMs: nowMar9,
      serverItems: [
        serverItem({ listenedAt: new Date(afterJump).toISOString() }),
      ],
    });
    expect(stats.days).toHaveLength(1);
    expect(stats.days[0].dayStartMs).toBe(localDayStartMs(mar8));
  });

  it("ends the streak yesterday when today has no counted play yet", () => {
    const stats = aggregate({
      nowMs: nowMar9,
      serverItems: [mar7, mar8].map((at) =>
        serverItem({ listenedAt: new Date(at).toISOString() }),
      ),
    });
    expect(stats.currentStreakDays).toBe(2);
  });
});

describe("the guest summary", () => {
  it("carries no numbers at all when the device log is empty", () => {
    const summary = buildGuestSummary(
      [
        { artist: "Ama", weight: 2 },
        { artist: "Ben", weight: 0 },
      ],
      [],
    );
    expect(summary.tasteTopArtists).toEqual([{ artist: "Ama", weight: 2 }]);
    expect(summary.device).toBeNull();
  });

  it("summarizes the device log when it holds plays", () => {
    const summary = buildGuestSummary(
      [],
      [
        deviceRecord({ playedDurationMs: 60_000, listenedAtMs: NOW - DAY }),
        deviceRecord({
          playedDurationMs: 5_000,
          completionRate: 0.02,
          listenedAtMs: NOW - HOUR,
        }),
      ],
    );
    expect(summary.device).toEqual({
      countedPlays: 1,
      listeningMs: 65_000,
      sinceMs: NOW - DAY,
    });
  });
});

describe("history grouping", () => {
  it("groups newest day first, newest event first within a day", () => {
    const merged = mergePlayEvents(
      [
        serverItem({ listenedAt: new Date(NOW - DAY - HOUR).toISOString() }),
        serverItem({ listenedAt: new Date(NOW - 2 * HOUR).toISOString() }),
        serverItem({ listenedAt: new Date(NOW - HOUR).toISOString() }),
      ],
      [],
    );
    const groups = groupHistoryByDay(merged.events);
    expect(groups).toHaveLength(2);
    expect(groups[0].events.map((e) => e.listenedAtMs)).toEqual([
      NOW - HOUR,
      NOW - 2 * HOUR,
    ]);
    expect(groups[1].events).toHaveLength(1);
  });
});
