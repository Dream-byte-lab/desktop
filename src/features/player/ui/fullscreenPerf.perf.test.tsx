// Perf evidence harness (Wave 3, Item 3) — FullscreenPlayer React
// commit profile.
//
// The REAL FullscreenPlayer is mounted with its heavy children
// stubbed (Kawarp, canvas lyrics, ambient, queue drawer) and the
// REAL player/lyrics stores. React Profiler counts commits while
// the harness drives the two real position/state flows:
//  1. playerStore.setPosition at the timeupdate rate (~4 Hz) —
//     FullscreenPlayer's own playerStore selectors are narrow
//     (currentTrack, next cover), so these should NOT re-render it;
//  2. lyricsStore writes — FullscreenPlayer calls useLyricsStore()
//     with NO selector, so every store change re-renders it; this
//     measures that cost per write.
//
// jsdom / main-thread only — no GPU is measured here. Assertions
// are behavioural (commit counts), durations are logged only.

import React, { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
vi.mock("./KawarpWrapper", () => ({
  default: () => <div data-testid="kawarp" />,
}));
vi.mock("./AmbientLayer", () => ({
  default: () => <div data-testid="ambient" />,
}));
vi.mock("./CanvasLyricsView", () => ({
  CanvasLyricsView: () => <div data-testid="lyrics" />,
}));
vi.mock("./PlayerUiElements", () => ({
  PlayerUiElements: () => <div data-testid="ui-elements" />,
}));
vi.mock("@/languages", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/shared/ui", () => ({
  Notch: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@mingcute/react", () => ({
  DownLine: () => <span />,
}));
vi.mock("./BetaVisualsWarning", () => ({
  BetaVisualsWarning: () => <div data-testid="beta-warning" />,
}));
vi.mock("./FullscreenTopNotch", () => ({
  FullscreenTopNotch: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("./LyricsNotchStatus", () => ({
  LyricsNotchStatus: () => <div data-testid="lyrics-status" />,
}));
vi.mock("@/features/lyrics", async () => {
  const actual =
    await vi.importActual<typeof import("@/features/lyrics")>(
      "@/features/lyrics",
    );
  return {
    ...actual,
    LyricsProviderIsland: () => <div data-testid="provider-island" />,
  };
});

import { FullscreenPlayer } from "./FullscreenPlayer";
import { usePlayerStore } from "../store/playerStore";
import { useLyricsStore } from "@/features/lyrics";

const track = {
  id: "track-perf-1",
  title: "Perf Song",
  artist: "Perf Artist",
  coverUrl: "https://example.test/cover.jpg",
  durationMs: 600_000,
} as never;

describe("FullscreenPlayer commit profile (real stores, stubbed children)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let commits: number;
  let durations: number[];

  beforeEach(() => {
    commits = 0;
    durations = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    usePlayerStore.setState({
      currentTrack: track,
      queue: [track],
      currentIndex: 0,
      positionMs: 0,
      status: "playing",
    });
    useLyricsStore.setState({
      braccatoLyrics: [],
      currentLyricsTrackId: "track-perf-1",
      lyricsLoading: false,
      activeLineIndex: null,
      availableProviders: [],
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function mount() {
    const onRender = (_id: string, _phase: string, actualDuration: number) => {
      commits++;
      durations.push(actualDuration);
    };
    act(() => {
      root.render(
        <Profiler id="fullscreen" onRender={onRender}>
          <FullscreenPlayer onClose={() => {}} effectsReady={false} />
        </Profiler>,
      );
    });
  }

  it("position updates at timeupdate rate do not re-render FullscreenPlayer", () => {
    mount();
    const baseCommits = commits;
    const start = performance.now();
    act(() => {
      // 60 s of playback compressed: 240 position writes at 4 Hz.
      for (let i = 1; i <= 240; i++) {
        usePlayerStore.getState().setPosition(i * 250);
      }
    });
    const wallMs = performance.now() - start;
    console.log(
      `[perf] fullscreen: 240 setPosition writes -> ${commits - baseCommits} extra commits ` +
        `(wall ${wallMs.toFixed(1)}ms for the batch)`,
    );
    expect(commits - baseCommits).toBe(0);
  });

  it("lyrics-store writes re-render it per write (whole-store subscription), cheaply", () => {
    mount();
    // Batched writes collapse into one commit (React batching) —
    // logged as a fact, but production writes arrive as separate
    // tasks (one per line change), so drive them individually.
    const batchBase = commits;
    act(() => {
      for (let i = 0; i < 60; i++) {
        useLyricsStore.getState().setActiveLineIndex(i);
      }
    });
    console.log(
      `[perf] fullscreen: 60 setActiveLineIndex writes in ONE batch -> ${commits - batchBase} commit(s)`,
    );
    act(() => useLyricsStore.getState().setActiveLineIndex(null));

    const baseCommits = commits;
    const baseDurations = durations.length;
    for (let i = 0; i < 60; i++) {
      act(() => useLyricsStore.getState().setActiveLineIndex(i));
    }
    const extra = commits - baseCommits;
    const ds = durations.slice(baseDurations).sort((a, b) => a - b);
    const median = ds[Math.floor(ds.length / 2)] ?? 0;
    const p95 = ds[Math.floor(ds.length * 0.95)] ?? 0;
    console.log(
      `[perf] fullscreen: 60 setActiveLineIndex writes as separate tasks -> ${extra} commits, ` +
        `commit actualDuration median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms`,
    );
    expect(extra).toBe(60);
    // A no-op write (same index) is guarded in the store: no commit.
    const beforeNoop = commits;
    act(() => useLyricsStore.getState().setActiveLineIndex(59));
    expect(commits - beforeNoop).toBe(0);
  });
});
