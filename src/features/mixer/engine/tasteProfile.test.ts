import { describe, expect, it } from "vitest";
import {
  applyEvent,
  emptyProfile,
  forYouScore,
  rankForYou,
  topArtists,
  type TasteEvent,
} from "./tasteProfile";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_000_000_000_000;

function event(overrides: Partial<TasteEvent>): TasteEvent {
  return {
    artist: "Sauti Sol",
    trackId: "t1",
    playedRatio: 1,
    completed: true,
    atMs: T0,
    ...overrides,
  };
}

describe("applyEvent", () => {
  it("rewards completions for the artist and the track", () => {
    const profile = applyEvent(emptyProfile(), event({}));
    expect(profile.artists["Sauti Sol"]).toBeCloseTo(1);
    expect(profile.tracks["t1"]).toBeCloseTo(1);
  });

  it("punishes an early skip but barely touches a late one", () => {
    const early = applyEvent(
      emptyProfile(),
      event({ playedRatio: 0.1, completed: false }),
    );
    expect(early.artists["Sauti Sol"]).toBeCloseTo(-0.7);
    const late = applyEvent(
      emptyProfile(),
      event({ playedRatio: 0.7, completed: false }),
    );
    expect(late.artists["Sauti Sol"]).toBeCloseTo(0.25);
  });

  it("accumulates across listens and rewards replays", () => {
    let profile = applyEvent(emptyProfile(), event({}));
    profile = applyEvent(profile, event({ atMs: T0 + 1000, repeated: true }));
    expect(profile.artists["Sauti Sol"]).toBeCloseTo(2.5);
  });

  it("feeds tag weights at a supporting rate", () => {
    const profile = applyEvent(emptyProfile(), event({ tags: ["Afrobeats"] }));
    expect(profile.tags["Afrobeats"]).toBeCloseTo(0.6);
  });
});

describe("decay", () => {
  it("halves weights after one half-life and prunes dust", () => {
    let profile = applyEvent(emptyProfile(), event({}));
    profile = applyEvent(
      profile,
      event({
        artist: "Other",
        trackId: "t2",
        atMs: T0 + 30 * DAY,
      }),
    );
    expect(profile.artists["Sauti Sol"]).toBeCloseTo(0.5);
    expect(profile.artists["Other"]).toBeCloseTo(1);
  });
});

describe("rankForYou", () => {
  it("floats loved artists up and sinks early-skipped ones", () => {
    let profile = applyEvent(emptyProfile(), event({}));
    profile = applyEvent(
      profile,
      event({
        artist: "Skipped Act",
        trackId: "t9",
        playedRatio: 0.05,
        completed: false,
        atMs: T0 + 1,
      }),
    );
    const ranked = rankForYou(
      [
        { trackId: "x1", artist: "Unknown" },
        { trackId: "x2", artist: "Skipped Act" },
        { trackId: "x3", artist: "Sauti Sol" },
      ],
      profile,
      T0 + 2,
    );
    expect(ranked.map((c) => c.trackId)).toEqual(["x3", "x1", "x2"]);
  });

  it("with an empty profile the shelf order survives untouched", () => {
    const shelf = [
      { trackId: "a", artist: "A" },
      { trackId: "b", artist: "B" },
    ];
    expect(rankForYou(shelf, emptyProfile(), T0)).toEqual(shelf);
  });

  it("scores tags as support, not the main signal", () => {
    const profile = applyEvent(emptyProfile(), event({ tags: ["House"] }));
    const tagged = forYouScore(
      { trackId: "n1", artist: "New", tags: ["House"] },
      profile,
    );
    const loved = forYouScore({ trackId: "n2", artist: "Sauti Sol" }, profile);
    expect(tagged).toBeCloseTo(0.3);
    expect(loved).toBeGreaterThan(tagged);
  });
});

describe("topArtists", () => {
  it("lists the strongest artists first", () => {
    let profile = applyEvent(emptyProfile(), event({}));
    profile = applyEvent(
      profile,
      event({ artist: "Bigger", trackId: "t2", atMs: T0 + 1 }),
    );
    profile = applyEvent(
      profile,
      event({ artist: "Bigger", trackId: "t3", atMs: T0 + 2 }),
    );
    expect(topArtists(profile, T0 + 3, 1)).toEqual([
      { artist: "Bigger", weight: 2 },
    ]);
  });
});
