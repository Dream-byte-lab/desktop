import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lyric } from "@braccato/parsers";
import { usePlayerStore } from "../store/playerStore";
import { useLyricsDisplayStore } from "../store/lyricsDisplayStore";
import type { Track } from "@/shared/types/track";

// The lyrics store is replaced by a controllable stand-in; the view
// reads it whole (no selectors), so a plain object is enough.
const lyricsState = vi.hoisted(() => ({
  current: {
    braccatoLyrics: [] as Lyric[],
    lyricsLoading: false,
    plainLyrics: null as string | null,
    instrumental: false,
    availableProviders: [] as unknown[],
    currentLyricsTrackId: null as string | null,
  },
}));

vi.mock("@/features/lyrics", () => ({
  useLyricsStore: () => lyricsState.current,
  LyricsProviderIsland: () => null,
}));

vi.mock("@/features/covers", () => ({
  useCoverSrc: (url: string | undefined) => url,
  preloadCoverArt: () => Promise.resolve(),
}));

vi.mock("../engine/playerEngine", () => ({
  playerEngine: { playTrack: vi.fn(() => Promise.resolve()) },
}));

vi.mock("../hooks/useRadioRecommendations", () => ({
  useRadioRecommendations: () => ({
    tracks: [],
    loading: false,
    failed: false,
  }),
}));

vi.mock("./CanvasLyricsView", () => ({
  CanvasLyricsView: () => <div data-testid="canvas-lyrics" />,
}));
vi.mock("./FullscreenTimeline", () => ({
  FullscreenTimeline: () => <div data-testid="timeline" />,
}));
vi.mock("./FullscreenTransportControls", () => ({
  FullscreenTransportControls: () => <div data-testid="transport" />,
}));
vi.mock("./FullscreenFrameGlass", () => ({
  FullscreenFrameGlass: () => null,
}));

import { LyricsFullscreenView } from "./LyricsFullscreenView";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function track(id: string, title: string): Track {
  return {
    id,
    title,
    artists: "Artist A",
    coverUrl: `https://img.example/${id}.jpg`,
    durationMs: 200000,
    playCount: 0,
    releaseDate: "2017-05-04",
  };
}

const track1 = track("t1", "Song One");
const track2 = track("t2", "Song Two");
const track3 = track("t3", "Song Three");

let container: HTMLDivElement;
let root: Root;
let exitCalls: number;
let onExit: () => void;

async function renderView() {
  await act(async () => {
    root.render(<LyricsFullscreenView onExit={onExit} />);
  });
}

function findButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return button as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has no ResizeObserver; the shared Notch measures with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  exitCalls = 0;
  onExit = () => {
    exitCalls += 1;
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  lyricsState.current = {
    braccatoLyrics: [{ startTimeMs: 0 } as Lyric],
    lyricsLoading: false,
    plainLyrics: null,
    instrumental: false,
    availableProviders: [],
    currentLyricsTrackId: "t1",
  };
  usePlayerStore.setState({
    currentTrack: track1,
    queue: [track1, track2, track3],
    currentIndex: 0,
  });
  useLyricsDisplayStore.setState({
    gaussianBlur: true,
    biggerText: false,
    highlightLyrics: true,
    textAlign: "center",
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("LyricsFullscreenView (reference 27)", () => {
  it("renders the record header: title, artist, year, and the tab pill", async () => {
    await renderView();
    expect(container.textContent).toContain("Song One");
    expect(container.textContent).toContain("Artist A");
    expect(container.textContent).toContain("2017");
    expect(findButton("Next")).toBeTruthy();
    expect(findButton("Lyrics")).toBeTruthy();
    expect(findButton("Recommended")).toBeTruthy();
    // The lyrics tab is the surface itself, showing the synced canvas.
    expect(
      container.querySelector('[data-testid="canvas-lyrics"]'),
    ).toBeTruthy();
    // The circular record header is present.
    const round = [...container.querySelectorAll("img")].some((img) =>
      img.className.includes("rounded-full"),
    );
    expect(round).toBe(true);
  });

  it("Next tab shows the actual next track, then the rest of the queue", async () => {
    await renderView();
    await click(findButton("Next"));
    expect(container.textContent).toContain("Song Two");
    expect(container.textContent).toContain("Song Three");
    expect(container.textContent).toContain("Up next");
  });

  it("the accessibility overlay drives the shared display store, live", async () => {
    await renderView();
    // Gaussian blur starts on: the blurred atmosphere layer exists.
    const blurredBackdrop = () =>
      [...container.querySelectorAll("img")].some((img) =>
        (img.getAttribute("style") ?? "").includes("blur(64px)"),
      );
    expect(blurredBackdrop()).toBe(true);

    await click(findButton("Accessibility"));
    await click(findButton("Gaussian blur"));
    expect(useLyricsDisplayStore.getState().gaussianBlur).toBe(false);
    // The design holds with blur off: no blurred backdrop remains.
    expect(blurredBackdrop()).toBe(false);

    await click(findButton("Bigger text"));
    expect(useLyricsDisplayStore.getState().biggerText).toBe(true);

    await click(findButton("Highlight lyrics"));
    expect(useLyricsDisplayStore.getState().highlightLyrics).toBe(false);

    await click(findButton("Left"));
    expect(useLyricsDisplayStore.getState().textAlign).toBe("left");
  });

  it("back leaves the lyrics view", async () => {
    await renderView();
    await click(findButton("Back to player"));
    expect(exitCalls).toBe(1);
  });
});
