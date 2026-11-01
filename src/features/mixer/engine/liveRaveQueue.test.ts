import { describe, expect, it } from "vitest";
import type { KeyEstimate } from "./detectKey";
import type { RaveTrackInfo } from "./liveRave";
import {
  LiveRaveQueue,
  type RaveQueueContext,
  type RaveQueueEntry,
} from "./liveRaveQueue";

function key(camelot: string, pitchClass: number, mode: "major" | "minor") {
  const estimate: KeyEstimate = {
    tonic: "C",
    mode,
    pitchClass,
    camelot,
    confidence: 0.9,
  };
  return estimate;
}

const C_MAJOR = key("8B", 0, "major");
const G_MAJOR = key("9B", 7, "major");

function entry(
  trackId: string,
  partial: Partial<RaveTrackInfo> = {},
): RaveQueueEntry<string> {
  return {
    track: trackId,
    info: {
      trackId,
      artist: `Artist ${trackId}`,
      bpm: 124,
      key: C_MAJOR,
      energy: 0.5,
      ...partial,
    },
  };
}

function context(partial: Partial<RaveQueueContext> = {}): RaveQueueContext {
  return {
    nowSec: 3600,
    phaseEnergy: 0.5,
    doNotPlay: [],
    playedTrackIds: [],
    ...partial,
  };
}

function upcoming(): RaveQueueEntry<string>[] {
  return [entry("u1"), entry("u2", { key: G_MAJOR }), entry("u3")];
}

function ids(entries: RaveQueueEntry<string>[]): string[] {
  return entries.map((item) => item.info.trackId);
}

describe("LiveRaveQueue", () => {
  it("turns duplicate requests from different guests into votes", () => {
    const queue = new LiveRaveQueue<string>();
    const first = queue.submit({
      id: "r1",
      guestId: "guest-a",
      entry: entry("song"),
      requestedAtSec: 100,
    });
    const duplicate = queue.submit({
      id: "r2",
      guestId: "guest-b",
      entry: entry("song"),
      requestedAtSec: 200,
    });
    const repeat = queue.submit({
      id: "r3",
      guestId: "guest-b",
      entry: entry("song"),
      requestedAtSec: 300,
    });

    expect(first.id).toBe("r1");
    expect(duplicate.id).toBe("r1");
    expect(duplicate.requestedAtSec).toBe(100);
    expect(duplicate.votes).toBe(2);
    expect(repeat.votes).toBe(2);
    expect(queue.openRequests).toHaveLength(1);
  });

  it("inserts scheduled requests at the scheduler's slots", () => {
    const queue = new LiveRaveQueue<string>();
    queue.submit({
      id: "a",
      guestId: "guest-a",
      entry: entry("song-a"),
      requestedAtSec: 0,
    });
    queue.submit({
      id: "b",
      guestId: "guest-b",
      entry: entry("song-b", { key: G_MAJOR }),
      requestedAtSec: 0,
    });

    const result = queue.evaluate(upcoming(), context());

    expect(result.changed).toBe(true);
    expect(ids(result.upcoming)).toEqual([
      "song-a",
      "u1",
      "u2",
      "song-b",
      "u3",
    ]);
    expect(result.decisions.map((decision) => decision.status)).toEqual([
      "scheduled",
      "scheduled",
    ]);
    expect(queue.openRequests).toHaveLength(0);
  });

  it("keeps a held request open until the night reaches its moment", () => {
    const queue = new LiveRaveQueue<string>();
    queue.submit({
      id: "peak",
      guestId: "guest-a",
      entry: entry("banger", { energy: 0.95 }),
      requestedAtSec: 0,
    });

    const early = queue.evaluate(upcoming(), context({ phaseEnergy: 0.3 }));
    expect(early.changed).toBe(false);
    expect(early.decisions[0].status).toBe("waiting");
    expect(queue.openRequests).toHaveLength(1);

    const later = queue.evaluate(upcoming(), context({ phaseEnergy: 0.8 }));
    expect(later.changed).toBe(true);
    expect(later.decisions[0].status).toBe("scheduled");
    expect(ids(later.upcoming)[0]).toBe("banger");
    expect(queue.openRequests).toHaveLength(0);
  });

  it("closes a request the host has blocked", () => {
    const queue = new LiveRaveQueue<string>();
    queue.submit({
      id: "blocked",
      guestId: "guest-a",
      entry: entry("bad-song"),
      requestedAtSec: 0,
    });

    const result = queue.evaluate(
      upcoming(),
      context({ doNotPlay: ["bad-song"] }),
    );

    expect(result.decisions[0].status).toBe("not-tonight");
    expect(result.changed).toBe(false);
    expect(queue.openRequests).toHaveLength(0);
  });

  it("holds every request without touching the queue when asked", () => {
    const queue = new LiveRaveQueue<string>();
    queue.submit({
      id: "held",
      guestId: "guest-a",
      entry: entry("song"),
      requestedAtSec: 0,
    });
    const before = upcoming();

    const result = queue.evaluate(
      before,
      context(),
      "Waiting — the next blend is already locked",
    );

    expect(result.changed).toBe(false);
    expect(result.upcoming).toBe(before);
    expect(result.decisions).toEqual([
      {
        requestId: "held",
        status: "waiting",
        reason: "Waiting — the next blend is already locked",
      },
    ]);
    expect(queue.openRequests).toHaveLength(1);
  });

  it("recognises a request already lined up without duplicating it", () => {
    const queue = new LiveRaveQueue<string>();
    queue.submit({
      id: "already",
      guestId: "guest-a",
      entry: entry("u2", { key: G_MAJOR }),
      requestedAtSec: 0,
    });
    const before = upcoming();

    const result = queue.evaluate(before, context());

    expect(result.changed).toBe(false);
    expect(ids(result.upcoming)).toEqual(["u1", "u2", "u3"]);
    expect(result.decisions[0]).toEqual({
      requestId: "already",
      status: "scheduled",
      slotIndex: 1,
      reason: "Already lined up in tonight's queue",
    });
    expect(queue.openRequests).toHaveLength(0);
  });
});
