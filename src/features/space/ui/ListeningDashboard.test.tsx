// The dashboard's honest states, pinned: coverage is stated in
// words, sections render only from data, the thin state replaces
// (never pads) the sections, and the guest surface carries no
// zero-filled numbers.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The exact English the parent lands under these keys at
// integration (the slice report's SEAMS OWED list).
const DICT: Record<string, string> = {
  "space.title": "Your Space",
  "space.loading": "Loading your listening…",
  "space.failed": "Your listening history couldn't be loaded.",
  "space.retry": "Retry",
  "space.coverage.plays_one": "1 play",
  "space.coverage.plays_plural": "{count} plays",
  "space.coverage.accountSince": "account history since {date}",
  "space.coverage.accountTo": "account history to {date}",
  "space.coverage.deviceSince": "this device since {date}",
  "space.coverage.monthsLimit": "counting the last {months} months",
  "space.coverage.recentLimit": "counting your most recent {count} plays",
  "space.coverage.stale": "Showing saved numbers while this updates",
  "space.coverage.refreshFailed": "Couldn't refresh — showing saved numbers.",
  "space.topArtists": "Most listened-to artists",
  "space.topTracks": "Most played songs",
  "space.listeningTime": "Listening time",
  "space.totalTime.minutes": "{minutes} min",
  "space.totalTime.hoursMinutes": "{hours} h {minutes} min",
  "space.stat.activeDays_one": "{count} active day",
  "space.stat.activeDays_plural": "{count} active days",
  "space.stat.streak_one": "{count}-day streak",
  "space.stat.streak_plural": "{count}-day streak",
  "space.stat.skips_one": "{count} skip",
  "space.stat.skips_plural": "{count} skips",
  "space.stat.repeats_one": "{count} repeat",
  "space.stat.repeats_plural": "{count} repeats",
  "space.genres.title": "Favorite genres",
  "space.genres.playlistGenres": "From your playlists",
  "space.genres.basicGenres": "Genres",
  "space.genres.basicUnavailable":
    "Basic genre isn't recorded for these tracks yet.",
  "space.movement.title": "Changes in your listening",
  "space.movement.subtitle": "The last 28 days against the 28 before",
  "space.movement.new": "New",
  "space.movement.gone": "Dropped out",
  "space.dj.title": "Your DJ sets",
  "space.dj.joins_one": "{count} join",
  "space.dj.joins_plural": "{count} joins",
  "space.dj.byHand_one": "{count} by hand",
  "space.dj.byHand_plural": "{count} by hand",
  "space.dj.fallbacks_one": "{count} fallback",
  "space.dj.fallbacks_plural": "{count} fallbacks",
  "space.dj.degraded_one": "{count} join on untrusted evidence",
  "space.dj.degraded_plural": "{count} joins on untrusted evidence",
  "space.guest.body":
    "You're listening as a guest, so there's no account history to show. Play counts and listening time begin with sign-in.",
  "space.guest.topArtists": "Strongest on this device",
  "space.guest.deviceTitle": "On this device",
  "space.thin.title": "This space fills as you listen",
  "space.thin.body":
    "Once you've played a few songs all the way through, your artists, songs and habits will appear here.",
  "space.thin.home": "Home",
  "space.thin.forYou": "For You",
};

function dictT(key: string, vars?: Record<string, string | number>): string {
  let template: string | undefined;
  if (vars && typeof vars.count === "number") {
    template =
      DICT[`${key}_${vars.count === 1 ? "one" : "plural"}`] ??
      DICT[`${key}_plural`];
  }
  template ??= DICT[key];
  if (template === undefined) return key;
  let out = template;
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

const holder: { state: unknown } = { state: { status: "loading" } };
const navigateSpy = vi.fn();

vi.mock("@/languages", () => ({
  useTranslation: () => ({ t: dictT, locale: "en" }),
}));

vi.mock("../hooks/useListeningStats", () => ({
  useListeningStats: () => holder.state,
}));

vi.mock("@/features/covers/ui/CoverImage", () => ({ default: () => null }));

vi.mock("@/shared/hooks/useStableNavigate", () => ({
  useStableNavigate: () => navigateSpy,
}));

import ListeningDashboard from "./ListeningDashboard";
import type { ListeningStats } from "../lib/listeningStats";
import type { Track } from "@/shared/types";

function track(id: string, title: string, artists: string): Track {
  return {
    id,
    title,
    artists,
    coverUrl: "",
    durationMs: 200_000,
    playCount: 0,
  };
}

const DEVICE_START = new Date(2026, 10, 3, 9, 0).getTime();

function makeStats(over: Partial<ListeningStats> = {}): ListeningStats {
  return {
    countedPlays: 42,
    totalEvents: 50,
    totalListeningMs: 7_500_000,
    skipCount: 5,
    skipRate: 0.1,
    loopCount: 3,
    replayCount: 4,
    topArtists: [
      { name: "Ama Artist", plays: 20, coverUrl: "" },
      { name: "Ben Band", plays: 9, coverUrl: "" },
    ],
    topTracks: [{ track: track("t1", "First Song", "Ama Artist"), plays: 7 }],
    playlistGenres: [{ label: "Amapiano", plays: 12 }],
    basicGenres: [],
    movement: {
      artists: [
        {
          label: "Ama Artist",
          currentPlays: 10,
          previousPlays: 4,
          currentRank: 1,
          previousRank: 2,
        },
      ],
      playlistGenres: [],
    },
    currentStreakDays: 3,
    activeDays: 21,
    days: [],
    joins: {
      performed: 20,
      userAct: 4,
      fallbackUnprepared: 2,
      fallbackInvalid: 1,
      degradedUntrusted: 3,
      setEnd: 1,
    },
    coverage: {
      events: 50,
      countedPlays: 42,
      fromMs: DEVICE_START - 40 * 86_400_000,
      toMs: DEVICE_START + 3_600_000,
      complete: false,
      truncatedBy: "events",
      serverEvents: 30,
      deviceEvents: 20,
      deviceStartMs: DEVICE_START,
      serverFromMs: DEVICE_START - 40 * 86_400_000,
    },
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  navigateSpy.mockReset();
  holder.state = { status: "loading" };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(ListeningDashboard),
      ),
    );
  });
}

describe("ListeningDashboard", () => {
  it("states its coverage in words and renders every section from data", async () => {
    holder.state = {
      status: "ready",
      stats: makeStats(),
      stale: false,
      refreshFailed: false,
      retry: vi.fn(),
    };
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Your Space");
    // The denominator, both spans, and the bound — in plain words.
    expect(text).toContain("42 plays");
    expect(text).toContain("account history to");
    expect(text).toContain("this device since");
    expect(text).toContain("counting your most recent 2000 plays");
    // Sections from data.
    expect(text).toContain("Most listened-to artists");
    expect(text).toContain("Ama Artist");
    expect(text).toContain("20 plays");
    expect(text).toContain("First Song");
    expect(text).toContain("2 h 5 min");
    expect(text).toContain("21 active days");
    expect(text).toContain("3-day streak");
    expect(text).toContain("5 skips");
    expect(text).toContain("7 repeats");
    expect(text).toContain("Amapiano");
    expect(text).toContain("Basic genre isn't recorded");
    expect(text).toContain("↑ 1");
    // The DJ block: sounded joins (drawn + by hand), then the
    // fallbacks and degraded joins under their own names — and
    // no grade-shaped figure anywhere.
    expect(text).toContain("24 joins");
    expect(text).toContain("4 by hand");
    expect(text).toContain("3 fallbacks");
    expect(text).toContain("3 joins on untrusted evidence");
    expect(text).not.toContain("grade");
  });

  it("links artists and songs to their pages when ids resolve", async () => {
    holder.state = {
      status: "ready",
      stats: makeStats({
        topArtists: [
          { name: "Ama Artist", plays: 20, coverUrl: "", artistId: "a-ama" },
          { name: "Ben Band", plays: 9, coverUrl: "" },
        ],
        topTracks: [
          {
            track: {
              ...track("t1", "First Song", "Ama Artist"),
              album: { id: "alb-1", title: "First Album" },
            },
            plays: 7,
          },
        ],
        movement: {
          artists: [
            {
              label: "Ama Artist",
              artistId: "a-ama",
              currentPlays: 10,
              previousPlays: 4,
              currentRank: 1,
              previousRank: 2,
            },
          ],
          playlistGenres: [],
        },
      }),
      stale: false,
      refreshFailed: false,
      retry: vi.fn(),
    };
    await render();
    const hrefs = [...container.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    // The portrait tile and the movement row both open Ama's page.
    expect(hrefs.filter((h) => h === "/artist?id=a-ama")).toHaveLength(2);
    // The song opens on its album's collection page.
    expect(hrefs).toContain("/collection?type=album&id=alb-1");
    // Ben Band carries no id and the album-less entries guess
    // nothing: exactly those three links exist.
    expect(hrefs).toHaveLength(3);
  });

  it("renders no links when no entry carries a resolvable target", async () => {
    holder.state = {
      status: "ready",
      stats: makeStats(),
      stale: false,
      refreshFailed: false,
      retry: vi.fn(),
    };
    await render();
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent ?? "").toContain("Ama Artist");
    expect(container.textContent ?? "").toContain("First Song");
  });

  it("omits the DJ block when no joins exist", async () => {
    holder.state = {
      status: "ready",
      stats: makeStats({ joins: null }),
      stale: false,
      refreshFailed: false,
      retry: vi.fn(),
    };
    await render();
    expect(container.textContent ?? "").not.toContain("Your DJ sets");
  });

  it("shows the thin starting state below the floor, with doors", async () => {
    holder.state = {
      status: "ready",
      stats: makeStats({ countedPlays: 3 }),
      stale: false,
      refreshFailed: false,
      retry: vi.fn(),
    };
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("This space fills as you listen");
    expect(text).not.toContain("Most played songs");
    const buttons = [...container.querySelectorAll("button")];
    await act(async () => {
      buttons.find((b) => b.textContent === "For You")?.click();
    });
    expect(navigateSpy).toHaveBeenCalledWith("/for-you");
  });

  it("gives guests the device summary with no zero-filled numbers", async () => {
    holder.state = {
      status: "guest",
      summary: {
        tasteTopArtists: [{ artist: "Ama Artist", weight: 2 }],
        device: null,
      },
    };
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("no account history to show");
    expect(text).toContain("Strongest on this device");
    expect(text).toContain("Ama Artist");
    expect(text).not.toContain("On this device");
    expect(text).not.toContain("0 plays");
    expect(text).not.toContain("0 min");
  });

  it("shows a guest's real device numbers when the log holds plays", async () => {
    holder.state = {
      status: "guest",
      summary: {
        tasteTopArtists: [],
        device: {
          countedPlays: 6,
          listeningMs: 1_860_000,
          sinceMs: DEVICE_START,
        },
      },
    };
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("On this device");
    expect(text).toContain("6 plays");
    expect(text).toContain("31 min");
  });

  it("renders failure as its own state with a working retry", async () => {
    const retry = vi.fn();
    holder.state = { status: "failed", retry };
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("couldn't be loaded");
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry",
    );
    await act(async () => {
      button?.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
