// Smart Shuffle guest admission — the gate, proven: the taste
// gate refuses thin profiles outright (no faked personalisation),
// the brain's own fit test refuses guests that do not earn their
// slot, a guest with no taste pull is refused however well it
// fits, and the ratio cap binds.

import { describe, expect, it } from "vitest";
import type { TrackReadKey } from "@/features/mixer/liverave/facts";
import type { SmartTrackIntel } from "./smartShuffleFacts";
import {
  emptyProfile,
  type TasteProfile,
} from "@/features/mixer/engine/tasteProfile";
import {
  admitGuests,
  hasInsertionTaste,
  type GuestCandidate,
} from "./smartShuffleAdmission";
import { maxGuestsFor } from "./smartShuffle";

const NOW = 1_700_000_000_000;

function key(camelot: string, pitchClass: number): TrackReadKey {
  return { tonic: pitchClass, mode: "major", camelot, confidence: 0.9 };
}

function facts(overrides: Partial<SmartTrackIntel> = {}): SmartTrackIntel {
  return {
    trackId: "t",
    bpm: 120,
    key: key("8B", 0),
    energy: 0.5,
    tempoConfidence: 0.9,
    vocalDensity: null,
    introSuitability: 0.5,
    outroSuitability: 0.5,
    ...overrides,
  };
}

function profile(overrides: Partial<TasteProfile> = {}): TasteProfile {
  return { ...emptyProfile(NOW), ...overrides };
}

function guest(
  id: string,
  artist: string,
  factOverrides: Partial<SmartTrackIntel> = {},
  extra: Partial<GuestCandidate> = {},
): GuestCandidate {
  return {
    trackId: id,
    artist,
    facts: facts({ trackId: id, ...factOverrides }),
    ...extra,
  };
}

/** A guest that fits the playing track hand in glove. */
function perfectGuest(id: string, artist: string): GuestCandidate {
  return guest(id, artist, {}, { playlistGenres: ["Chill"] });
}

const CURRENT = facts({ trackId: "now", playlistGenres: ["Chill"] });
const LOVED = profile({
  artists: { Beloved: 3 },
  tags: { Chill: 2 },
});

describe("hasInsertionTaste — the cold-start gate", () => {
  it("refuses an empty profile", () => {
    expect(hasInsertionTaste(emptyProfile(), NOW)).toBe(false);
  });

  it("refuses a profile below one completion's worth of love", () => {
    expect(hasInsertionTaste(profile({ artists: { A: 0.5 } }), NOW)).toBe(
      false,
    );
  });

  it("accepts one completed listen's worth, and only just", () => {
    expect(hasInsertionTaste(profile({ artists: { A: 1 } }), NOW)).toBe(true);
  });

  it("decays old love below the bar", () => {
    const stale = profile({
      artists: { A: 8 },
      updatedAtMs: NOW - 200 * 24 * 60 * 60 * 1000,
    });
    expect(hasInsertionTaste(stale, NOW)).toBe(false);
  });
});

describe("admitGuests", () => {
  it("admits a guest that fits and is loved", () => {
    const admitted = admitGuests({
      current: CURRENT,
      arcTargetEnergy: 0.5,
      pool: [perfectGuest("g1", "Beloved")],
      profile: LOVED,
      nowMs: NOW,
      maxGuests: 2,
    });
    expect(admitted.map((c) => c.trackId)).toEqual(["g1"]);
  });

  it("admits on the strength of a loved label alone", () => {
    const admitted = admitGuests({
      current: CURRENT,
      arcTargetEnergy: 0.5,
      pool: [perfectGuest("g1", "Never Heard")],
      profile: LOVED,
      nowMs: NOW,
      maxGuests: 2,
    });
    expect(admitted.map((c) => c.trackId)).toEqual(["g1"]);
  });

  it("refuses a guest that does not fit musically", () => {
    const misfit = guest("g1", "Beloved", {
      bpm: 60,
      key: key("2B", 6),
      energy: 0.05,
    });
    const admitted = admitGuests({
      current: CURRENT,
      arcTargetEnergy: 0.9,
      pool: [misfit],
      profile: LOVED,
      nowMs: NOW,
      maxGuests: 2,
    });
    expect(admitted).toEqual([]);
  });

  it("refuses a perfect fit the listener has no pull toward", () => {
    const stranger = guest("g1", "Stranger", {}, { playlistGenres: [] });
    const admitted = admitGuests({
      current: CURRENT,
      arcTargetEnergy: 0.5,
      pool: [stranger],
      profile: LOVED,
      nowMs: NOW,
      maxGuests: 2,
    });
    expect(admitted).toEqual([]);
  });

  it("refuses everyone when the taste gate is shut", () => {
    const admitted = admitGuests({
      current: CURRENT,
      arcTargetEnergy: 0.5,
      pool: [perfectGuest("g1", "Beloved")],
      profile: profile({ artists: { Beloved: 0.5 } }),
      nowMs: NOW,
      maxGuests: 2,
    });
    expect(admitted).toEqual([]);
  });

  it("honours the ratio cap and admits best fit first", () => {
    const pool = [
      perfectGuest("g-fit-less", "Beloved"),
      perfectGuest("g-fit-best", "Beloved"),
      perfectGuest("g-fit-mid", "Beloved"),
    ];
    // Energy exactly on the arc fits best; the others drift.
    pool[0].facts = facts({ trackId: "g-fit-less", energy: 0.72 });
    pool[1].facts = facts({ trackId: "g-fit-best", energy: 0.5 });
    pool[2].facts = facts({ trackId: "g-fit-mid", energy: 0.61 });
    const admitted = admitGuests({
      current: CURRENT,
      arcTargetEnergy: 0.5,
      pool,
      profile: LOVED,
      nowMs: NOW,
      maxGuests: maxGuestsFor(6),
    });
    expect(admitted).toHaveLength(2);
    expect(admitted[0].trackId).toBe("g-fit-best");
  });

  it("admits nobody at a zero cap and works without a current track", () => {
    expect(
      admitGuests({
        current: CURRENT,
        arcTargetEnergy: 0.5,
        pool: [perfectGuest("g1", "Beloved")],
        profile: LOVED,
        nowMs: NOW,
        maxGuests: 0,
      }),
    ).toEqual([]);
    const admitted = admitGuests({
      current: null,
      arcTargetEnergy: 0.5,
      pool: [perfectGuest("g1", "Beloved")],
      profile: LOVED,
      nowMs: NOW,
      maxGuests: 1,
    });
    expect(admitted.map((c) => c.trackId)).toEqual(["g1"]);
  });
});
