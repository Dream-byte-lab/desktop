import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("framer-motion", () => {
  const cache: Record<string, any> = {};
  return {
    AnimatePresence: ({ children }: any) => <>{children}</>,
    useReducedMotion: () => false,
    motion: new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (!cache[prop]) {
            cache[prop] = React.forwardRef(
              ({ children, className, style, ...props }: any, ref: any) => {
                const cleanProps = { ...props };
                delete cleanProps.initial;
                delete cleanProps.animate;
                delete cleanProps.exit;
                delete cleanProps.transition;
                return React.createElement(
                  prop,
                  { ref, className, style, ...cleanProps },
                  children,
                );
              },
            );
          }
          return cache[prop];
        },
      },
    ),
  };
});

vi.mock("@/languages", () => ({
  useTranslation: () => ({
    t: () => "",
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("@/features/covers", () => ({
  CoverImage: ({ src, alt }: any) => <img src={src} alt={alt} />,
}));

const { engineSpies, playerState, sessionState } = vi.hoisted(() => {
  // The player store's Track shape: artists pre-joined, coverUrl flat.
  const track = (id: string, title: string, artist: string) => ({
    id,
    title,
    artists: artist,
    durationMs: 200_000,
    coverUrl: `https://covers.example/${id}.jpg`,
  });
  return {
    engineSpies: {
      togglePlayPause: vi.fn(),
      skipNext: vi.fn(),
      skipPrevious: vi.fn(),
    },
    playerState: {
      status: "playing",
      currentTrack: track("t1", "First Song", "Singer One"),
      queue: [] as unknown[],
      currentIndex: 0,
      positionMs: 65_000,
      durationMs: 200_000,
    } as Record<string, any>,
    sessionState: {
      isRunning: false,
      isPaused: false,
      degraded: false,
      plainCutCount: 0,
      liveRaveOpenRequests: [] as unknown[],
      endReason: null as string | null,
    },
  };
});

const track = (id: string, title: string, artist: string) => ({
  id,
  title,
  artists: artist,
  durationMs: 200_000,
  coverUrl: `https://covers.example/${id}.jpg`,
});

vi.mock("@/features/player", () => ({
  usePlayerState: () => playerState,
  playerEngine: engineSpies,
  useGlassBlur: () => true,
}));

vi.mock("@/features/mixer/engine/djSession", () => ({
  djSession: {
    get isRunning() {
      return sessionState.isRunning;
    },
    get isPaused() {
      return sessionState.isPaused;
    },
    get degraded() {
      return sessionState.degraded;
    },
    get plainCutCount() {
      return sessionState.plainCutCount;
    },
    get liveRaveOpenRequests() {
      return sessionState.liveRaveOpenRequests;
    },
    get endReason() {
      return sessionState.endReason;
    },
    stageSnapshot: () => null,
  },
}));

vi.mock("@/features/mixer/engine/trackSource", () => ({
  preparedTrack: () => null,
}));

vi.mock("@/features/mixer/store/djModeStore", () => ({
  useDjModeStore: (selector: any) => selector({ blending: false }),
}));

import { FocusMode } from "./FocusMode";
import { useFocusModeStore } from "../store/focusModeStore";

describe("FocusMode — the annex proposal as a working surface", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    playerState.status = "playing";
    playerState.currentTrack = track("t1", "First Song", "Singer One");
    playerState.queue = [playerState.currentTrack];
    playerState.currentIndex = 0;
    playerState.positionMs = 65_000;
    playerState.durationMs = 200_000;
    sessionState.isRunning = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      useFocusModeStore.setState({ active: false });
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
  });

  function render() {
    act(() => {
      root?.render(<FocusMode />);
    });
  }

  it("renders nothing while inactive (default-state parity)", () => {
    render();
    expect(container?.querySelector('[data-testid="focus-mode"]')).toBeNull();
  });

  it("reduces the app to the music: artwork, title, artists, stated times, transport", () => {
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();

    const surface = container?.querySelector('[data-testid="focus-mode"]');
    expect(surface).not.toBeNull();
    expect(container?.textContent).toContain("First Song");
    expect(container?.textContent).toContain("Singer One");
    // Elapsed / total, stated plainly: 65s of 200s.
    expect(container?.textContent).toContain("1:05");
    expect(container?.textContent).toContain("3:20");

    const next = container?.querySelector(
      'button[aria-label="Next"]',
    ) as HTMLButtonElement;
    act(() => {
      next.click();
    });
    expect(engineSpies.skipNext).toHaveBeenCalledTimes(1);

    const playPause = container?.querySelector(
      'button[aria-label="Pause"]',
    ) as HTMLButtonElement;
    act(() => {
      playPause.click();
    });
    expect(engineSpies.togglePlayPause).toHaveBeenCalledTimes(1);
  });

  it("the exit pill is the doorway in reverse", () => {
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();
    const exitButton = container?.querySelector(
      'button[aria-label="Exit focus"]',
    ) as HTMLButtonElement;
    act(() => {
      exitButton.click();
    });
    expect(useFocusModeStore.getState().active).toBe(false);
  });

  it("in a DJ session it states the incoming track and the session's own lines", () => {
    sessionState.isRunning = true;
    const next = track("t2", "Second Song", "Singer Two");
    playerState.queue = [playerState.currentTrack, next];
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();

    expect(container?.textContent).toContain("Coming up");
    expect(container?.textContent).toContain("Second Song");
    // activityLinesForStage's own narration for this state: the
    // next track exists but is not prepared yet.
    expect(container?.textContent).toContain("Preparing incoming track");
  });

  it("without a DJ session there is no Coming up block", () => {
    const next = track("t2", "Second Song", "Singer Two");
    playerState.queue = [playerState.currentTrack, next];
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();
    expect(container?.textContent).not.toContain("Coming up");
  });

  it("leaves on its own when the music goes away", () => {
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();
    expect(useFocusModeStore.getState().active).toBe(true);

    playerState.currentTrack = null;
    render();
    expect(useFocusModeStore.getState().active).toBe(false);
  });
});
