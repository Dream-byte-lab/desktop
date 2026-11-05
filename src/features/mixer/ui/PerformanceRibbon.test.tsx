import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The ribbon reads the wiring only for its deliberate-stop notice.
vi.mock("@/features/mixer/liverave/wiring", () => ({
  startDjWiring: vi.fn(() => ({
    noteDeliberateStop: vi.fn(),
    armed: false,
    dispose: vi.fn(),
  })),
  noteDeliberateStop: vi.fn(),
}));

import { noteDeliberateStop } from "@/features/mixer/liverave/wiring";
import { useDjState } from "@/features/mixer/liverave/state";
import { usePlayerStore } from "@/features/player/store/playerStore";
import { PerformanceRibbon } from "./PerformanceRibbon";
import { makeFakeSession, makeTrack } from "./fakeSession";

const deliberateStopMock = vi.mocked(noteDeliberateStop);

function resetStores(active: boolean, blending: boolean) {
  const t1 = makeTrack("t1", "Song One");
  useDjState.setState({
    intent: true,
    active,
    blending,
    proOpen: false,
    controlLevel: "autonomous",
  });
  usePlayerStore.setState({
    queue: [t1, makeTrack("t2", "Song Two"), makeTrack("t3", "Song Three")],
    currentIndex: 0,
    currentTrack: t1,
    status: "playing",
  });
}

describe("PerformanceRibbon — the automatic DJ's default face (§10.2)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    deliberateStopMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders nothing with DJ off — the plain player stands alone", () => {
    resetStores(false, false);
    act(() => root.render(<PerformanceRibbon session={makeFakeSession()} />));
    expect(
      container.querySelector("[data-testid='performance-ribbon']"),
    ).toBeNull();
  });

  it("NOW: names the sounding technique in large type and draws the recipe's gain ribbons", () => {
    resetStores(true, true);
    act(() => root.render(<PerformanceRibbon session={makeFakeSession()} />));
    const now = container.querySelector("[data-ribbon-zone='now']");
    expect(now?.querySelector("[data-now-move]")?.textContent).toBe(
      "FLARE SCRATCH",
    );
    // The ribbons are the drawn recipe's real gain curves, not decoration.
    const ribbons = now?.querySelector("[data-now-ribbons]");
    expect(ribbons).not.toBeNull();
    expect(ribbons?.querySelectorAll("polyline")).toHaveLength(2);
  });

  it("NOW mid-track: shows the playing track and its position instead of a fake join", () => {
    resetStores(true, false);
    act(() =>
      root.render(
        <PerformanceRibbon
          session={makeFakeSession({ blending: false, currentMove: null })}
        />,
      ),
    );
    const now = container.querySelector("[data-ribbon-zone='now']");
    expect(now?.querySelector("[data-now-track]")?.textContent).toBe(
      "Song One",
    );
    expect(now?.querySelector("[data-now-progress]")).not.toBeNull();
    expect(now?.textContent).toContain("0:30");
  });

  it("NEXT: the authored join card with honest WHY chips from the recipe evidence", () => {
    resetStores(true, true);
    act(() => root.render(<PerformanceRibbon session={makeFakeSession()} />));
    const next = container.querySelector("[data-ribbon-zone='next']");
    expect(next?.querySelector("[data-next-join]")?.textContent).toContain(
      "into Song Two",
    );
    expect(next?.textContent).toContain("Suitability 82%");
    expect(next?.textContent).toContain("pool of 2");
    const chips = next?.querySelector("[data-next-why]")?.textContent ?? "";
    expect(chips).toContain("Tempo fit 90%");
    expect(chips).toContain("Vocal safety 95%");
  });

  it("NEXT: an honest preparing state when no join has been drawn", () => {
    resetStores(true, false);
    act(() =>
      root.render(
        <PerformanceRibbon session={makeFakeSession({ preview: null })} />,
      ),
    );
    const next = container.querySelector("[data-ribbon-zone='next']");
    expect(next?.querySelector("[data-next-empty]")).not.toBeNull();
  });

  it("THE NIGHT SO FAR: performed glyphs, fallbacks labelled with their reason, energy skyline", () => {
    resetStores(true, true);
    act(() => root.render(<PerformanceRibbon session={makeFakeSession()} />));
    const night = container.querySelector("[data-ribbon-zone='night']");
    const glyphs = night?.querySelectorAll("[data-timeline-glyph]");
    expect(glyphs?.length).toBe(2);
    const fallback = night?.querySelector("[data-timeline-glyph='fallback']");
    expect(fallback?.textContent).toContain("FALLBACK");
    expect(fallback?.textContent).toContain("fallback-unprepared");
    expect(
      night?.querySelector("[data-energy-skyline]")?.childElementCount,
    ).toBe(4);
  });

  it("transport rides the session seam and the DJ switch disarms the wiring", () => {
    resetStores(true, true);
    const session = makeFakeSession();
    act(() => root.render(<PerformanceRibbon session={session} />));

    const nextButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Next track"]',
    );
    act(() => {
      nextButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(session.skipNext).toHaveBeenCalledTimes(1);

    const offButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch DJ off"]',
    );
    act(() => {
      offButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(deliberateStopMock).toHaveBeenCalledTimes(1);
    expect(useDjState.getState().intent).toBe(false);
  });
});
