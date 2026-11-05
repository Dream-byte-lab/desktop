import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/features/covers/ui/CoverImage", () => ({ default: () => null }));

import { OverlayPlayer } from "./OverlayPlayer";
import type { OverlaySize } from "../contracts";
import { OVERLAY_SIZE_PRESETS } from "../lib/overlaySize";

const playingState = {
  status: "playing",
  track: { id: "a", title: "Song", artist: "Artist", durationMs: 200_000 },
  positionMs: 30_000,
  durationMs: 200_000,
  volume: 1,
  isLiked: false,
  shuffle: false,
  repeat: "off",
  contextLabel: "Playing from Album",
};

const DEFAULT_BAND: OverlaySize = { ...OVERLAY_SIZE_PRESETS.default };

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
    // In the panel bands the cover panel itself carries a percentage
    // width, so look inside the seek slider first; the micro strip's
    // hairline is found by the container-wide fallback.
    const slider = container.querySelector(
      '[role="slider"][aria-label="Seek"]',
    );
    const scope = slider ?? container;
    const bar = Array.from(scope.querySelectorAll<HTMLElement>("[style]")).find(
      (el) => el.style.width.endsWith("%"),
    );
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

  it("panel bands show the reference composition: eyebrow, transport ends, seek, volume, focus and close", async () => {
    await mount({ ...OVERLAY_SIZE_PRESETS.large });
    expect(container.querySelector('[aria-label="Seek"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Volume"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Open main window"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Resize overlay"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Shuffle"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Repeat"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Close overlay"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Like"]')).not.toBeNull();
    expect(container.textContent).toContain("Playing from Album");
  });

  it("the resize grip is visible at rest with its label intact — not hover-only (fix-0119)", async () => {
    await mount({ ...OVERLAY_SIZE_PRESETS.large });
    const grip = container.querySelector<HTMLElement>(
      '[aria-label="Resize overlay"]',
    );
    expect(grip).not.toBeNull();
    // A low but real at-rest opacity; full on hover/focus.
    expect(grip!.className).toContain("opacity-40");
    expect(grip!.className).not.toContain("opacity-0");
    expect(grip!.className).toContain("group-hover:opacity-100");
    expect(grip!.className).toContain("focus-visible:opacity-100");
  });

  it("shuffle and repeat buttons send their actions and reflect state", async () => {
    await mount();
    const shuffle = container.querySelector<HTMLElement>(
      '[aria-label="Shuffle"]',
    );
    const repeat = container.querySelector<HTMLElement>(
      '[aria-label="Repeat"]',
    );
    expect(shuffle).not.toBeNull();
    expect(repeat).not.toBeNull();
    expect(shuffle!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      shuffle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      repeat!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sentActions).toContainEqual({ type: "toggleShuffle" });
    expect(sentActions).toContainEqual({ type: "cycleRepeat" });

    await act(async () => {
      pushState?.({
        ...playingState,
        shuffle: true,
        repeat: "one",
      });
    });
    const shuffleOn = container.querySelector<HTMLElement>(
      '[aria-label="Shuffle"]',
    );
    const repeatOne = container.querySelector<HTMLElement>(
      '[aria-label="Repeat one"]',
    );
    expect(shuffleOn!.getAttribute("aria-pressed")).toBe("true");
    expect(repeatOne).not.toBeNull();
    expect(repeatOne!.getAttribute("aria-pressed")).toBe("true");
  });

  it("close button in the panel sends closeOverlay", async () => {
    await mount();
    const close = container.querySelector<HTMLElement>(
      '[aria-label="Close overlay"]',
    );
    expect(close).not.toBeNull();
    await act(async () => {
      close!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sentActions).toContainEqual({ type: "closeOverlay" });
  });

  it("falls back to a neutral eyebrow when no context is known", async () => {
    initialState = { ...playingState, contextLabel: null };
    await mount();
    expect(container.textContent).toContain("Now playing");
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
