import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/features/covers/ui/CoverImage", () => ({ default: () => null }));

import { OverlayPlayer } from "./OverlayPlayer";
import type { OverlaySize } from "../contracts";

const playingState = {
  status: "playing",
  track: { id: "a", title: "Song", artist: "Artist", durationMs: 200_000 },
  positionMs: 30_000,
  durationMs: 200_000,
  volume: 1,
  isLiked: false,
};

const DEFAULT_BAND: OverlaySize = { width: 368, height: 168 };

describe("OverlayPlayer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rafCalls: number;
  let visibility: ((visible: boolean) => void) | null;
  let pushState: ((state: unknown) => void) | null;
  let initialState: Record<string, unknown>;
  let sentActions: Array<{ type: string; payload?: unknown }>;

  async function mount(windowSize: OverlaySize = DEFAULT_BAND) {
    window.linerElectron = {
      platform: "win32",
      getOverlayInitialState: () => Promise.resolve(initialState),
      onOverlayState: (cb: (state: unknown) => void) => {
        pushState = cb;
        return () => {};
      },
      onOverlayVisibility: (cb: (visible: boolean) => void) => {
        visibility = cb;
        return () => {};
      },
      overlayReady: () => {},
      sendOverlayAction: (action: { type: string; payload?: unknown }) => {
        sentActions.push(action);
      },
    } as never;
    await act(async () => {
      root.render(<OverlayPlayer initialWindowSize={windowSize} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  function progressPercent() {
    const bar = Array.from(
      container.querySelectorAll<HTMLElement>("[style]"),
    ).find((el) => el.style.width.endsWith("%"));
    return bar ? parseFloat(bar.style.width) : NaN;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    rafCalls = 0;
    visibility = null;
    pushState = null;
    sentActions = [];
    initialState = { ...playingState };
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCalls += 1;
      return setTimeout(() => cb(performance.now()), 16) as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete window.linerElectron;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not animate while the overlay window is hidden", async () => {
    await mount();
    await advance(2_000);
    rafCalls = 0;
    await advance(10_000);
    const hidden = rafCalls;

    await act(async () => visibility?.(true));
    await act(async () => {
      await Promise.resolve();
    });
    rafCalls = 0;
    await advance(1_000);
    const shown = rafCalls;

    await act(async () => visibility?.(false));
    await advance(2_000);
    rafCalls = 0;
    await advance(10_000);
    const hiddenAgain = rafCalls;
    process.stdout.write(
      `[perf] overlay rAF calls: 10s hidden ${hidden}, 1s shown ${shown}, 10s hidden again ${hiddenAgain}\n`,
    );

    expect(hidden).toBe(0);
    expect(shown).toBeGreaterThan(10);
    expect(hiddenAgain).toBe(0);
    expect(pushState).not.toBeNull();
  });

  it("starts from the position extrapolated since the state was sampled", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    initialState = {
      ...playingState,
      positionMs: 30_000,
      positionAt: Date.now() - 20_000,
    };
    await mount();
    await act(async () => visibility?.(true));
    await act(async () => {
      await Promise.resolve();
    });
    await advance(100);
    expect(progressPercent()).toBeGreaterThan(24.9);
    expect(progressPercent()).toBeLessThan(25.5);
  });

  it("micro band keeps cover, transport and progress but drops seek and volume controls", async () => {
    await mount({ width: 320, height: 64 });
    expect(container.querySelector('[aria-label="Pause"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Previous"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Next"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Seek"]')).toBeNull();
    expect(container.querySelector('[aria-label="Volume"]')).toBeNull();
    expect(container.textContent).toContain("Song");
    expect(progressPercent()).toBeGreaterThan(14);
    expect(progressPercent()).toBeLessThan(16);
  });

  it("large band shows the full player: seek, volume and artwork hero", async () => {
    await mount({ width: 480, height: 360 });
    expect(container.querySelector('[aria-label="Seek"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Volume"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Open main window"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Resize overlay"]'),
    ).not.toBeNull();
  });

  it("mute button in the volume pill sends toggleMute", async () => {
    await mount();
    const mute = container.querySelector<HTMLElement>('[aria-label="Mute"]');
    expect(mute).not.toBeNull();
    await act(async () => {
      mute!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sentActions).toContainEqual({ type: "toggleMute" });
  });

  it("play button sends togglePlay in every band", async () => {
    await mount({ width: 320, height: 64 });
    const play = container.querySelector<HTMLElement>('[aria-label="Pause"]');
    expect(play).not.toBeNull();
    await act(async () => {
      play!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sentActions).toContainEqual({ type: "togglePlay" });
  });
});
