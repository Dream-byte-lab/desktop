import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import ForYouMixCard from "./ForYouMixCard";
import { storeLocale } from "@/languages";
import type { ForYouMix } from "../lib/forYouFeed";
import type { Track } from "@/shared/types";

// Note 23 regression: a mix the For You feed renders must OPEN to
// its song list. The card's contract mirrors the Home rail's
// DailyMixCard — single click opens the mix's collection page,
// double click plays it. Before the fix the single click only
// started playback and no open path existed on this surface.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const playTrackSpy = vi.fn((..._args: unknown[]) => Promise.resolve());

vi.mock("@/features/player", () => ({
  playerEngine: {
    playTrack: (...args: unknown[]) => playTrackSpy(...args),
    addToQueue: vi.fn(),
  },
}));

vi.mock("@/features/covers/ui/CoverImage", () => ({
  default: () => null,
}));

function makeTrack(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    artists: "Ama Artist",
    coverUrl: `cover-${id}`,
    durationMs: 180_000,
    playCount: 0,
  } as Track;
}

const IDS = ["t1", "t2", "t3", "t4", "t5", "t6"];
const MIX_ID = "mix:playlistGenre:amapiano";

const mix: ForYouMix = {
  id: MIX_ID,
  basis: { kind: "playlistGenre", label: "Amapiano" },
  tracks: IDS.map((id) => makeTrack(id)),
};

let container: HTMLDivElement;
let root: Root;
const locationHolder: { current: string } = { current: "" };

function LocationProbe() {
  const location = useLocation();
  locationHolder.current = `${location.pathname}${location.search}`;
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  storeLocale("en");
  locationHolder.current = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
});

async function renderCard() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/for-you"]}>
        <LocationProbe />
        <ForYouMixCard
          mix={mix}
          title="Your Amapiano shelf"
          subtitle="From a Playlist Genre you filed"
        />
      </MemoryRouter>,
    );
  });
  const card = container.querySelector("div.cursor-pointer");
  expect(card).not.toBeNull();
  return card as Element;
}

async function clickAndSettle(card: Element, detail: number) {
  await act(async () => {
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
  });
  // The open is debounced by 200 ms (double-click discrimination).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

describe("ForYouMixCard — opening a mix (Note 23)", () => {
  it("single click opens the mix's collection page and does not play", async () => {
    const card = await renderCard();

    await clickAndSettle(card, 1);

    expect(locationHolder.current).toBe(
      `/collection?type=playlist&id=${encodeURIComponent(MIX_ID)}`,
    );
    expect(playTrackSpy).not.toHaveBeenCalled();
  });

  it("double click plays the mix and stays on the feed", async () => {
    const card = await renderCard();

    await clickAndSettle(card, 2);

    expect(playTrackSpy).toHaveBeenCalledTimes(1);
    expect(playTrackSpy.mock.calls[0][0]).toMatchObject({ id: "t1" });
    expect(locationHolder.current).toBe("/for-you");
  });
});
