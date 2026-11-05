// Lyrics consolidation (2026-11-05): the split Now Playing view's
// lyrics column — the old lyrics screen — is deleted. The dedicated
// full-screen Lyrics view is the only lyrics surface left, and every
// lyrics entry point must land on it:
//
//  1. with synced lyrics loaded, the split view renders the player
//     elements and NO lyrics renderer at all;
//  2. the split view's own "Open lyrics" button swaps the surface
//     to the Lyrics view (and its exit returns);
//  3. the playback bar's one-shot intent (lyricsOpenIntent) makes
//     the surface open straight into the Lyrics view.
//
// Heavy children are stubbed; the player store is real, the lyrics
// store is a controllable stand-in (the surface reads it whole).

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lyric } from "@braccato/parsers";
import { usePlayerStore } from "../store/playerStore";
import { requestLyricsViewOpen } from "./lyricsOpenIntent";
import type { Track } from "@/shared/types/track";

const lyricsState = vi.hoisted(() => ({
  current: {
    braccatoLyrics: [] as Lyric[],
    lyricsLoading: false,
    lyricsError: null as string | null,
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

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("framer-motion", () => {
  const cache: Record<string, unknown> = {};
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    useReducedMotion: () => false,
    motion: new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (!cache[prop]) {
            cache[prop] = React.forwardRef(
              (
                {
                  children,
                  className,
                  style,
                }: {
                  children?: React.ReactNode;
                  className?: string;
                  style?: React.CSSProperties;
                },
                ref: React.Ref<HTMLElement>,
              ) =>
                React.createElement(prop, { ref, className, style }, children),
            );
          }
          return cache[prop];
        },
      },
    ),
  };
});
vi.mock("@/features/covers", () => ({
  preloadCoverArt: async () => {},
  useCoverSrc: (url?: string) => url,
}));
vi.mock("@/languages", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/shared/ui", () => ({
  Notch: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@mingcute/react", () => ({
  DownLine: () => <span />,
  Text2Line: () => <span />,
}));
vi.mock("./KawarpWrapper", () => ({
  default: () => <div data-testid="kawarp" />,
}));
vi.mock("./AmbientLayer", () => ({
  default: () => <div data-testid="ambient" />,
}));
vi.mock("./CanvasLyricsView", () => ({
  CanvasLyricsView: () => <div data-testid="canvas-lyrics" />,
}));
vi.mock("./PlayerUiElements", () => ({
  PlayerUiElements: (props: { layout?: string }) => (
    <div data-testid="ui-elements" data-layout={props.layout} />
  ),
}));
vi.mock("./LyricsFullscreenView", () => ({
  LyricsFullscreenView: ({ onExit }: { onExit: () => void }) => (
    <div data-testid="lyrics-fullscreen-view">
      <button type="button" data-testid="lyrics-exit" onClick={onExit}>
        exit
      </button>
    </div>
  ),
}));
vi.mock("./BetaVisualsWarning", () => ({
  BetaVisualsWarning: () => null,
}));
vi.mock("./FullscreenFrameGlass", () => ({
  FullscreenFrameGlass: () => null,
}));
vi.mock("./FullscreenTopNotch", () => ({
  FullscreenTopNotch: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("./LyricsNotchStatus", () => ({
  LyricsNotchStatus: () => <div data-testid="lyrics-status" />,
}));

import { FullscreenPlayer } from "./FullscreenPlayer";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const track1: Track = {
  id: "t1",
  title: "Song One",
  artists: "Artist A",
  coverUrl: "https://img.example/t1.jpg",
  durationMs: 200000,
  playCount: 0,
  releaseDate: "2017-05-04",
};

let container: HTMLDivElement;
let root: Root;

async function renderPlayer() {
  await act(async () => {
    root.render(<FullscreenPlayer onClose={() => {}} effectsReady={false} />);
  });
}

function findButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  lyricsState.current = {
    braccatoLyrics: [{ startTimeMs: 0 } as Lyric],
    lyricsLoading: false,
    lyricsError: null,
    plainLyrics: null,
    instrumental: false,
    availableProviders: [],
    currentLyricsTrackId: "t1",
  };
  usePlayerStore.setState({
    currentTrack: track1,
    queue: [track1],
    currentIndex: 0,
    status: "playing",
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("FullscreenPlayer after the lyrics consolidation", () => {
  it("the split view carries no lyrics surface, even with synced lyrics loaded", async () => {
    await renderPlayer();
    expect(container.querySelector('[data-testid="ui-elements"]')).toBeTruthy();
    // The old screen is gone: no canvas lyrics anywhere in the split
    // view, and the dedicated view is not open yet either.
    expect(container.querySelector('[data-testid="canvas-lyrics"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="lyrics-fullscreen-view"]'),
    ).toBeNull();
    // With no lyrics column to sit beside, the player elements take
    // the full-width (horizontal) arrangement for every track.
    expect(
      container
        .querySelector('[data-testid="ui-elements"]')
        ?.getAttribute("data-layout"),
    ).toBe("horizontal");
  });

  it("the Open lyrics button routes to the new lyrics screen, and back", async () => {
    await renderPlayer();
    await click(findButton("Open lyrics"));
    expect(
      container.querySelector('[data-testid="lyrics-fullscreen-view"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="ui-elements"]')).toBeNull();

    await click(container.querySelector('[data-testid="lyrics-exit"]')!);
    expect(container.querySelector('[data-testid="ui-elements"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="lyrics-fullscreen-view"]'),
    ).toBeNull();
  });

  it("the playback bar's lyrics intent opens straight into the new lyrics screen", async () => {
    requestLyricsViewOpen();
    await renderPlayer();
    expect(
      container.querySelector('[data-testid="lyrics-fullscreen-view"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="ui-elements"]')).toBeNull();
  });
});
