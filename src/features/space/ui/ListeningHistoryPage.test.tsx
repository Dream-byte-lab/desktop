// The history page: day groups with honest row facts, the
// load-more path, and the bound stated when the feed ends there.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DICT: Record<string, string> = {
  "space.loading": "Loading your listening…",
  "space.failed": "Your listening history couldn't be loaded.",
  "space.retry": "Retry",
  "space.history.title": "Listening History",
  "space.history.count_one": "1 listen",
  "space.history.count_plural": "{count} listens",
  "space.history.today": "Today",
  "space.history.yesterday": "Yesterday",
  "space.history.empty": "Nothing here yet — plays will appear as you listen.",
  "space.history.playedFor": "played {duration}",
  "space.history.looped_one": "looped {count} time",
  "space.history.looped_plural": "looped {count} times",
  "space.history.skipped": "skipped",
  "space.history.brief": "brief listen",
  "space.history.loadMore": "Show more",
  "space.history.loadingMore": "Loading…",
  "space.history.moreFailed": "More history couldn't be loaded.",
  "space.history.boundNote":
    "Older plays aren't loaded — this view reaches back about 13 months.",
  "space.history.endNote": "That's the start of your history here.",
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

vi.mock("@/languages", () => ({
  useTranslation: () => ({ t: dictT, locale: "en" }),
}));

vi.mock("../hooks/useListeningHistory", () => ({
  useListeningHistory: () => holder.state,
}));

vi.mock("@/features/covers/ui/CoverImage", () => ({ default: () => null }));

import ListeningHistoryPage from "./ListeningHistoryPage";
import {
  localDayStartMs,
  type HistoryDayGroup,
  type PlayEvent,
} from "../lib/listeningStats";
import type { Track } from "@/shared/types";

function track(id: string, title: string): Track {
  return {
    id,
    title,
    artists: "Ama Artist",
    coverUrl: "",
    durationMs: 200_000,
    playCount: 0,
  };
}

function playEvent(over: Partial<PlayEvent> = {}): PlayEvent {
  return {
    track: track("t1", "A Song"),
    playedDurationMs: 120_000,
    completionRate: 0.6,
    completed: false,
    skipped: false,
    loopCount: 0,
    hasSeekBackward: false,
    listenedAtMs: Date.now() - 3_600_000,
    source: "device",
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
    root.render(React.createElement(ListeningHistoryPage));
  });
}

function readyState(over: Record<string, unknown> = {}) {
  const todayStart = localDayStartMs(Date.now());
  const groups: HistoryDayGroup[] = [
    {
      dayStartMs: todayStart,
      events: [
        playEvent({
          track: track("t1", "Morning Song"),
          listenedAtMs: Date.now() - 3_600_000,
        }),
        playEvent({
          track: track("t2", "Skipped Song"),
          playedDurationMs: 4_000,
          completionRate: 0.02,
          skipped: true,
          listenedAtMs: Date.now() - 7_200_000,
        }),
      ],
    },
  ];
  return {
    status: "ready",
    groups,
    totalEvents: 2,
    hasMore: false,
    boundReached: false,
    loadingMore: false,
    loadMoreFailed: false,
    loadMore: vi.fn(),
    retry: vi.fn(),
    ...over,
  };
}

describe("ListeningHistoryPage", () => {
  it("renders day groups with honest row facts", async () => {
    holder.state = readyState();
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Listening History");
    expect(text).toContain("2 listens");
    expect(text).toContain("Today");
    expect(text).toContain("Morning Song");
    expect(text).toContain("played 2:00");
    expect(text).toContain("Skipped Song");
    expect(text).toContain("skipped");
    expect(text).toContain("That's the start of your history here.");
  });

  it("offers Show more while pages remain, and the click loads them", async () => {
    const loadMore = vi.fn();
    holder.state = readyState({ hasMore: true, loadMore });
    await render();
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Show more",
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("states the bound when the feed ends at it", async () => {
    holder.state = readyState({ boundReached: true });
    await render();
    expect(container.textContent ?? "").toContain(
      "reaches back about 13 months",
    );
  });

  it("keeps an empty history distinct from a failure", async () => {
    holder.state = readyState({ groups: [], totalEvents: 0 });
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Nothing here yet");
    expect(text).not.toContain("couldn't be loaded");
  });

  it("renders failure with a working retry", async () => {
    const retry = vi.fn();
    holder.state = { status: "failed", retry };
    await render();
    expect(container.textContent ?? "").toContain("couldn't be loaded");
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry",
    );
    await act(async () => {
      button?.click();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
