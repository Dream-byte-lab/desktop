import { describe, expect, it } from "vitest";
import type { KeyEstimate } from "./detectKey";
import {
  guestStatus,
  scheduleRequests,
  type RaveContext,
  type RaveRequest,
  type RaveTrackInfo,
} from "./liveRave";

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
const A_MINOR = key("8A", 9, "minor");
const F_SHARP_MINOR = key("11A", 6, "minor");

function track(
  trackId: string,
  partial: Partial<RaveTrackInfo> = {},
): RaveTrackInfo {
  return {
    trackId,
    artist: `Artist ${trackId}`,
    bpm: 124,
    key: C_MAJOR,
    energy: 0.5,
    ...partial,
  };
}

function request(
  id: string,
  trackInfo: RaveTrackInfo,
  partial: Partial<RaveRequest> = {},
): RaveRequest {
  return {
    id,
    guestId: `guest-${id}`,
    track: trackInfo,
    requestedAtSec: 0,
    votes: 1,
    ...partial,
  };
}

const NOW = 3600; // one hour into the party

function context(partial: Partial<RaveContext> = {}): RaveContext {
  return {
    nowSec: NOW,
    phaseEnergy: 0.5,
    upcoming: [track("u1"), track("u2", { key: G_MAJOR }), track("u3")],
    doNotPlay: [],
    playedTrackIds: [],
    ...partial,
  };
}

describe("scheduleRequests", () => {
  it("refuses what the host blocked, by track or by artist", () => {
    const decisions = scheduleRequests(
      [
        request("r1", track("bad-track")),
        request("r2", track("fine", { artist: "Banned Act" })),
      ],
      context({ doNotPlay: ["bad-track", "Banned Act"] }),
    );
    expect(decisions.map((d) => d.status)).toEqual([
      "not-tonight",
      "not-tonight",
    ]);
  });

  it("refuses what already played tonight", () => {
    const decisions = scheduleRequests(
      [request("r1", track("heard-it"))],
      context({ playedTrackIds: ["heard-it"] }),
    );
    expect(decisions[0].status).toBe("not-tonight");
  });

  it("holds a peak weapon asked for during warm-up", () => {
    const decisions = scheduleRequests(
      [request("r1", track("banger", { energy: 0.95 }))],
      context({ phaseEnergy: 0.3 }),
    );
    expect(decisions[0].status).toBe("waiting");
    expect(decisions[0].reason).toContain("bigger part of the night");
  });

  it("holds a breather asked for at the peak", () => {
    const decisions = scheduleRequests(
      [request("r1", track("soft", { energy: 0.15 }))],
      context({ phaseEnergy: 0.85 }),
    );
    expect(decisions[0].status).toBe("waiting");
    expect(decisions[0].reason).toContain("calmer moment");
  });

  it("schedules a fitting request at the earliest fitting slot", () => {
    const decisions = scheduleRequests(
      [request("r1", track("fits", { key: A_MINOR }))],
      context(),
    );
    expect(decisions[0].status).toBe("scheduled");
    if (decisions[0].status === "scheduled") {
      expect(decisions[0].slotIndex).toBe(0);
    }
  });

  it("lets a patient guest outrank fresh votes", () => {
    const decisions = scheduleRequests(
      [
        request("fresh", track("fresh-song", { key: G_MAJOR }), {
          requestedAtSec: NOW - 60,
          votes: 5,
        }),
        request("patient", track("patient-song"), {
          requestedAtSec: NOW - 30 * 60,
          votes: 1,
        }),
      ],
      context(),
    );
    const fresh = decisions.find((d) => d.requestId === "fresh")!;
    const patient = decisions.find((d) => d.requestId === "patient")!;
    expect(patient.status).toBe("scheduled");
    expect(fresh.status).toBe("scheduled");
    if (patient.status === "scheduled" && fresh.status === "scheduled") {
      expect(patient.slotIndex).toBeLessThan(fresh.slotIndex);
    }
  });

  it("never schedules two guest tracks back-to-back", () => {
    const decisions = scheduleRequests(
      [
        request("a", track("song-a")),
        request("b", track("song-b", { key: A_MINOR })),
        request("c", track("song-c", { key: G_MAJOR })),
      ],
      context(),
    );
    const slots = decisions
      .filter((d) => d.status === "scheduled")
      .map((d) => (d.status === "scheduled" ? d.slotIndex : -1))
      .sort((x, y) => x - y);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i] - slots[i - 1]).toBeGreaterThanOrEqual(2);
    }
  });

  it("waits when no slot joins musically", () => {
    const decisions = scheduleRequests(
      [request("r1", track("alien", { key: F_SHARP_MINOR, bpm: 100 }))],
      context(),
    );
    expect(decisions[0].status).toBe("waiting");
    expect(decisions[0].reason).toContain("fits musically");
  });
});

describe("guestStatus", () => {
  it("speaks honestly to the guest", () => {
    expect(guestStatus("played", 5000)).toBe("played");
    expect(
      guestStatus(
        { requestId: "x", status: "scheduled", slotIndex: 1, reason: "" },
        10,
      ),
    ).toBe("coming soon");
    expect(
      guestStatus({ requestId: "x", status: "not-tonight", reason: "" }, 10),
    ).toBe("not tonight");
    expect(
      guestStatus({ requestId: "x", status: "waiting", reason: "" }, 30),
    ).toBe("received");
    expect(
      guestStatus({ requestId: "x", status: "waiting", reason: "" }, 600),
    ).toBe("waiting for its moment");
  });
});
