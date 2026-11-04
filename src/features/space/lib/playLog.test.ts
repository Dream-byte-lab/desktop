// The device play log: the linerDb `plays` store round-trip (the
// db scope for this slice), the defensive read, and the writer
// that turns a playback-event report into a stored record.

import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { linerDb, type CachedPlayEventRecord } from "@/shared/storage/linerDb";
import {
  appendDevicePlayEvent,
  deviceLogStartMs,
  readDevicePlayEvents,
} from "./playLog";
import {
  devicePlayEventFromPayload,
  recordDevicePlay,
} from "./devicePlayWriter";
import type { RecordPlaybackEventRequest } from "@/shared/contracts/history";
import type { Track } from "@/shared/types";

function clientTrack(id: string): Track {
  return {
    id,
    title: `Song ${id}`,
    artists: "Ama Artist",
    coverUrl: "",
    durationMs: 200_000,
    playCount: 0,
  };
}

function record(
  over: Partial<CachedPlayEventRecord> = {},
): CachedPlayEventRecord {
  return {
    id: `rec-${Math.random().toString(36).slice(2)}`,
    trackId: "t1",
    track: clientTrack("t1"),
    playedDurationMs: 60_000,
    completionRate: 0.3,
    completed: false,
    skipped: false,
    loopCount: 0,
    hasSeekBackward: false,
    playbackSessionId: "sess-1",
    listenedAtMs: 1_000,
    ...over,
  };
}

beforeEach(async () => {
  await linerDb.clearAll();
});

describe("linerDb plays store", () => {
  it("round-trips records, oldest first", async () => {
    await linerDb.putPlayEvent(record({ id: "b", listenedAtMs: 2_000 }));
    await linerDb.putPlayEvent(record({ id: "a", listenedAtMs: 1_000 }));
    const all = await linerDb.getPlayEvents();
    expect(all.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("clearStore('plays') empties the log and nothing else", async () => {
    await linerDb.putPlayEvent(record({ id: "p1" }));
    await linerDb.putTrack({
      id: "keep",
      title: "Keep",
      artists: "A",
      durationMs: 1,
      coverUrl: "",
      playCount: 0,
    });
    await linerDb.clearStore("plays");
    expect(await linerDb.getPlayEvents()).toEqual([]);
    expect((await linerDb.getTrack("keep"))?.title).toBe("Keep");
  });

  it("clearAll empties the log too", async () => {
    await linerDb.putPlayEvent(record({ id: "p1" }));
    await linerDb.clearAll();
    expect(await linerDb.getPlayEvents()).toEqual([]);
  });

  it("keeps at most 2,000 events in the memory copy, dropping the oldest", async () => {
    for (let i = 0; i < 2005; i++) {
      await linerDb.putPlayEvent(record({ id: `cap-${i}`, listenedAtMs: i }));
    }
    const all = await linerDb.getPlayEvents();
    expect(all).toHaveLength(2000);
    expect(all[0].id).toBe("cap-5");
    expect(all[all.length - 1].id).toBe("cap-2004");
  });
});

describe("playLog access", () => {
  it("skips malformed records instead of trusting the disk", async () => {
    await appendDevicePlayEvent(record({ id: "good" }));
    await linerDb.putPlayEvent({
      id: "bad",
      trackId: "t9",
      // no track snapshot, no numbers — a corrupt or foreign record
    } as unknown as CachedPlayEventRecord);
    const events = await readDevicePlayEvents();
    expect(events.map((r) => r.id)).toEqual(["good"]);
  });

  it("reports the log's start instant", async () => {
    expect(deviceLogStartMs([])).toBeNull();
    const events = [
      record({ listenedAtMs: 5_000 }),
      record({ listenedAtMs: 3_000 }),
    ];
    expect(deviceLogStartMs(events)).toBe(3_000);
  });
});

describe("devicePlayWriter", () => {
  const payload: RecordPlaybackEventRequest = {
    playbackSessionId: "sess-9",
    listeningSessionId: "listen-9",
    trackId: "track-9",
    trackSnapshot: {
      id: "track-9",
      title: "Ninth Song",
      artists: [{ id: "a1", name: "Ama Artist" }],
      durationMs: 210_000,
    },
    playedDurationMs: 45_000,
    trackDurationMs: 210_000,
    completionRate: 0.21,
    skipped: true,
    context: { type: "playlist", id: "pl-1" },
  };

  it("maps a report payload onto a stored record", () => {
    const rec = devicePlayEventFromPayload(payload, 777_000);
    expect(rec).not.toBeNull();
    expect(rec).toMatchObject({
      trackId: "track-9",
      playedDurationMs: 45_000,
      completionRate: 0.21,
      completed: false,
      skipped: true,
      loopCount: 0,
      hasSeekBackward: false,
      contextType: "playlist",
      contextId: "pl-1",
      playbackSessionId: "sess-9",
      listenedAtMs: 777_000,
    });
    expect(rec?.track.title).toBe("Ninth Song");
    expect(rec?.track.artists).toBe("Ama Artist");
  });

  it("records a minimal snapshot when the payload carries none", () => {
    const bare: RecordPlaybackEventRequest = {
      playbackSessionId: "s",
      listeningSessionId: "l",
      trackId: "bare-1",
      playedDurationMs: 1_000,
      trackDurationMs: 99_000,
      completionRate: 0.01,
    };
    const rec = devicePlayEventFromPayload(bare, 5_000);
    expect(rec?.track.id).toBe("bare-1");
    expect(rec?.track.durationMs).toBe(99_000);
  });

  it("refuses a payload with no track id", () => {
    expect(
      devicePlayEventFromPayload({ ...payload, trackId: "" }, 1_000),
    ).toBeNull();
  });

  it("recordDevicePlay lands the record in the log and never throws", async () => {
    recordDevicePlay(payload, 424_242);
    await vi.waitFor(async () => {
      expect(await readDevicePlayEvents()).toHaveLength(1);
    });
    const [stored] = await readDevicePlayEvents();
    expect(stored.listenedAtMs).toBe(424_242);
    expect(() => recordDevicePlay({ ...payload, trackId: "" })).not.toThrow();
  });
});
