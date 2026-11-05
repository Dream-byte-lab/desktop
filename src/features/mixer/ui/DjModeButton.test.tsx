import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The button module is the NAMED BOOTSTRAP HOME: importing it must
// start the wiring exactly once per module load. The wiring and
// the session are faked here so the bootstrap is observable.
vi.mock("@/features/mixer/liverave/wiring", () => ({
  startDjWiring: vi.fn(() => ({
    noteDeliberateStop: vi.fn(),
    armed: false,
    dispose: vi.fn(),
  })),
  noteDeliberateStop: vi.fn(),
}));

vi.mock("@/features/mixer/liverave/session", async () => {
  const fake = await import("./fakeSession");
  return { liveRaveSession: fake.makeFakeSession() };
});

import { liveRaveSession } from "@/features/mixer/liverave/session";
import { useDjState } from "@/features/mixer/liverave/state";
import { startDjWiring } from "@/features/mixer/liverave/wiring";
import { usePlayerStore } from "@/features/player/store/playerStore";
import { DjModeButton } from "./DjModeButton";
import { makeTrack } from "./fakeSession";

const startMock = vi.mocked(liveRaveSession.start);
const stopMock = vi.mocked(liveRaveSession.stop);
const wiringMock = vi.mocked(startDjWiring);

function resetStores(active = false, intent = false) {
  const t1 = makeTrack("t1", "Song One") as Track;
  useDjState.setState({
    intent,
    active,
    blending: false,
    proOpen: true,
    controlLevel: "autonomous",
  });
  usePlayerStore.setState({
    queue: [t1, makeTrack("t2", "Song Two") as Track],
    currentIndex: 0,
    currentTrack: t1,
    status: "paused",
  });
}

describe("DjModeButton — the DJ door, the ON AIR pill, and the bootstrap (§10.4)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    startMock.mockClear();
    stopMock.mockClear();
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

  it("bootstraps the DJ wiring at module scope — auto-resume's named home", () => {
    // DjModeButton was imported at the top of this file; its module
    // scope must have fired the wiring bootstrap. If nobody restarts
    // the wiring, intent auto-resume silently dies.
    expect(wiringMock).toHaveBeenCalled();
  });

  it("with DJ off it is a quiet DJ door; pressing it sets intent and starts the set", () => {
    resetStores(false, false);
    act(() => root.render(<DjModeButton />));
    const door = container.querySelector<HTMLButtonElement>(
      'button[aria-label="DJ mode"]',
    );
    expect(door).not.toBeNull();
    expect(door!.disabled).toBe(false);
    act(() => {
      door!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useDjState.getState().intent).toBe(true);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("while a session runs it is an ON AIR pill naming the current technique", () => {
    resetStores(true, true);
    act(() => root.render(<DjModeButton />));
    const pill = container.querySelector("[data-on-air]");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain("ON AIR");
    expect(pill?.querySelector("[data-current-technique]")?.textContent).toBe(
      "FLARE SCRATCH",
    );
  });

  it("tapping the ON AIR pill returns the surface to the Ribbon (proOpen off)", () => {
    resetStores(true, true);
    act(() => root.render(<DjModeButton />));
    const pillButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="ON AIR"]',
    );
    act(() => {
      pillButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useDjState.getState().proOpen).toBe(false);
  });

  it("the DJ switch beside the pill is deliberate: intent off and the session stopped", () => {
    resetStores(true, true);
    act(() => root.render(<DjModeButton />));
    const off = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch DJ off"]',
    );
    act(() => {
      off!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useDjState.getState().intent).toBe(false);
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().status).toBe("paused");
  });

  it("intent on with no session running: the door switches DJ off instead of retrying start (fix-0119)", () => {
    resetStores(false, true);
    usePlayerStore.setState({ status: "playing" });
    act(() => root.render(<DjModeButton />));
    const door = container.querySelector<HTMLButtonElement>(
      'button[aria-label="DJ mode"]',
    );
    expect(door).not.toBeNull();
    expect(door!.disabled).toBe(false);
    act(() => {
      door!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useDjState.getState().intent).toBe(false);
    expect(startMock).not.toHaveBeenCalled();
    expect(stopMock).toHaveBeenCalledTimes(1);
    // Playback was never the session's here: not paused.
    expect(usePlayerStore.getState().status).toBe("playing");
  });

  it("a failed start shows the engine's recorded reason in the bar, beside a working off control (fix-0119)", () => {
    Object.assign(liveRaveSession, {
      startState: "failed",
      startFailure: "audio could not be resolved or decoded",
    });
    try {
      resetStores(false, true);
      act(() => root.render(<DjModeButton />));
      const status = container.querySelector("[data-dj-status='failed']");
      expect(status).not.toBeNull();
      expect(status?.textContent).toContain(
        "audio could not be resolved or decoded",
      );
      // Still turn-off-able from the same render.
      const door = container.querySelector<HTMLButtonElement>(
        'button[aria-label="DJ mode"]',
      );
      expect(door).not.toBeNull();
      act(() => {
        door!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(useDjState.getState().intent).toBe(false);
    } finally {
      Object.assign(liveRaveSession, {
        startState: "ready",
        startFailure: null,
      });
    }
  });

  it("a start in flight shows a starting status (fix-0119)", () => {
    Object.assign(liveRaveSession, { startState: "starting" });
    try {
      resetStores(false, true);
      act(() => root.render(<DjModeButton />));
      expect(
        container.querySelector("[data-dj-status='starting']"),
      ).not.toBeNull();
    } finally {
      Object.assign(liveRaveSession, { startState: "ready" });
    }
  });

  it("the ON AIR pill names the preparing phase while the decks have not taken over (fix-0119)", () => {
    Object.assign(liveRaveSession, { preparing: true });
    try {
      resetStores(true, true);
      act(() => root.render(<DjModeButton />));
      expect(container.querySelector("[data-dj-preparing]")).not.toBeNull();
      expect(container.querySelector("[data-on-air]")).not.toBeNull();
    } finally {
      Object.assign(liveRaveSession, { preparing: false });
    }
  });
});
