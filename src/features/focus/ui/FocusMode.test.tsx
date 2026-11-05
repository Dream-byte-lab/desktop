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
      stageSnapshot: null as unknown,
      nextJoinPreview: null as {
        trackId: string;
        trackTitle: string;
      } | null,
      feedEvents: [] as { at: number; kind: string; text: string }[],
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

// The session seam, faked at exactly the surface Focus consumes:
// isRunning, the stage snapshot (for the current move), the next
// join preview (the drawn next track, when one is drawn) and the
// activity feed (the session's narration, verbatim). Focus reads
// no session counters and no preparation cache — what the session
// is doing reaches this surface only in the session's own words.
vi.mock("@/features/mixer/liverave/session", () => ({
  liveRaveSession: {
    get isRunning() {
      return sessionState.isRunning;
    },
    get nextJoinPreview() {
      return sessionState.nextJoinPreview;
    },
    stageSnapshot: () => sessionState.stageSnapshot,
    activityFeed: {
      events: () => sessionState.feedEvents,
      latest: () =>
        sessionState.feedEvents[sessionState.feedEvents.length - 1] ?? null,
      subscribe: () => () => {},
    },
  },
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
    sessionState.stageSnapshot = null;
    sessionState.nextJoinPreview = null;
    sessionState.feedEvents = [];
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
    sessionState.feedEvents = [
      { at: 1, kind: "preparing", text: "Preparing Second Song" },
      { at: 2, kind: "drawn", text: "Long blend drawn for Second Song" },
    ];
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();

    expect(container?.textContent).toContain("Coming up");
    expect(container?.textContent).toContain("Second Song");
    // The session's narration, verbatim from its activity feed.
    expect(container?.textContent).toContain("Preparing Second Song");
    expect(container?.textContent).toContain(
      "Long blend drawn for Second Song",
    );
  });

  it("prefers the session's drawn next join over the store queue's next", () => {
    sessionState.isRunning = true;
    const storeNext = track("t2", "Second Song", "Singer Two");
    playerState.queue = [playerState.currentTrack, storeNext];
    // A party guest the session scheduled into its own upcoming
    // and has now drawn: it is not in the store queue at all, and
    // the queue's next (Second Song) is NOT what plays next.
    sessionState.nextJoinPreview = {
      trackId: "guest-1",
      trackTitle: "Guest Song",
    };
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();

    expect(container?.textContent).toContain("Coming up");
    expect(container?.textContent).toContain("Guest Song");
    expect(container?.textContent).not.toContain("Second Song");
  });

  it("a drawn preview that is in the queue borrows the queue entry's artists", () => {
    sessionState.isRunning = true;
    const next = track("t2", "Second Song", "Singer Two");
    playerState.queue = [playerState.currentTrack, next];
    sessionState.nextJoinPreview = {
      trackId: "t2",
      trackTitle: "Second Song",
    };
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();

    expect(container?.textContent).toContain("Second Song");
    expect(container?.textContent).toContain("Singer Two");
  });

  it("with no join drawn yet, Coming up falls back to the store queue's next", () => {
    sessionState.isRunning = true;
    const next = track("t2", "Second Song", "Singer Two");
    playerState.queue = [playerState.currentTrack, next];
    sessionState.nextJoinPreview = null;
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();

    expect(container?.textContent).toContain("Coming up");
    expect(container?.textContent).toContain("Second Song");
  });

  it("states the current move's label when the snapshot carries one", () => {
    sessionState.isRunning = true;
    const next = track("t2", "Second Song", "Singer Two");
    playerState.queue = [playerState.currentTrack, next];
    sessionState.stageSnapshot = {
      decks: [
        {
          trackId: "t1",
          positionMs: 0,
          positionSec: 0,
          playing: true,
          rate: 1,
        },
        {
          trackId: null,
          positionMs: 0,
          positionSec: null,
          playing: false,
          rate: 1,
        },
      ],
      currentMove: {
        label: "Flare scratch into Second Song",
        family: "scratch-in",
        technique: "flare",
      },
      controlLevel: "autonomous",
    };
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();
    expect(container?.textContent).toContain("Flare scratch into Second Song");
  });

  it("does not duplicate the move when the feed's latest entry already states it", () => {
    sessionState.isRunning = true;
    const next = track("t2", "Second Song", "Singer Two");
    playerState.queue = [playerState.currentTrack, next];
    sessionState.stageSnapshot = {
      decks: [
        {
          trackId: "t1",
          positionMs: 0,
          positionSec: 0,
          playing: true,
          rate: 1,
        },
        {
          trackId: "t2",
          positionMs: 0,
          positionSec: 0,
          playing: false,
          rate: 1,
        },
      ],
      currentMove: {
        label: "Flare scratch into Second Song",
        family: "scratch-in",
        technique: "flare",
      },
      controlLevel: "autonomous",
    };
    sessionState.feedEvents = [
      { at: 1, kind: "performing", text: "Flare scratch into Second Song" },
    ];
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();
    const occurrences =
      container?.textContent?.split("Flare scratch into Second Song").length ??
      0;
    // One statement of the move in the lines block (the title of
    // the incoming track in "Coming up" is a separate element and
    // does not contain the move's full label).
    expect(occurrences).toBe(2); // split yields one more than the count
  });

  it("shows only the latest three narration lines", () => {
    sessionState.isRunning = true;
    const next = track("t2", "Second Song", "Singer Two");
    playerState.queue = [playerState.currentTrack, next];
    sessionState.feedEvents = [1, 2, 3, 4, 5].map((n) => ({
      at: n,
      kind: "preparing",
      text: `Narration ${n}`,
    }));
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();
    expect(container?.textContent).not.toContain("Narration 1");
    expect(container?.textContent).not.toContain("Narration 2");
    expect(container?.textContent).toContain("Narration 3");
    expect(container?.textContent).toContain("Narration 4");
    expect(container?.textContent).toContain("Narration 5");
  });

  it("carries the session's degradation honesty verbatim, reasons included", () => {
    sessionState.isRunning = true;
    const next = track("t2", "Second Song", "Singer Two");
    playerState.queue = [playerState.currentTrack, next];
    sessionState.feedEvents = [
      {
        at: 1,
        kind: "degraded",
        text: "Plain cut into Second Song — no join was prepared in time",
      },
    ];
    act(() => {
      useFocusModeStore.setState({ active: true });
    });
    render();
    expect(container?.textContent).toContain(
      "Plain cut into Second Song — no join was prepared in time",
    );
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
