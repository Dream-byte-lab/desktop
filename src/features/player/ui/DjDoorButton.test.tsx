import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/languages", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The door talks to the new engine only through the session seam;
// the fake is the briefed surface the door consumes (start/stop).
vi.mock("@/features/mixer/liverave/session", () => ({
  liveRaveSession: { start: vi.fn(async () => {}), stop: vi.fn() },
}));

import { liveRaveSession } from "@/features/mixer/liverave/session";
import { useDjState } from "@/features/mixer/liverave/state";
import { usePlayerStore } from "../store/playerStore";
import { DjDoorButton } from "./DjDoorButton";

function makeTrack(id: string): Track {
  return { id, title: id, artists: "Test Artist" } as unknown as Track;
}

const startMock = vi.mocked(liveRaveSession.start);
const stopMock = vi.mocked(liveRaveSession.stop);

function resetStores() {
  useDjState.setState({
    intent: false,
    active: false,
    blending: false,
    proOpen: false,
    controlLevel: "autonomous",
  });
  usePlayerStore.setState({
    queue: [],
    currentIndex: -1,
    currentTrack: null,
    status: "idle",
  });
}

describe("DjDoorButton — the Now Playing DJ door (new seams)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    resetStores();
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
    resetStores();
    vi.restoreAllMocks();
  });

  const doorButton = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="DJ mode"]');

  const clickDoor = () => {
    act(() => {
      doorButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("renders unpressed and disabled with intent off, no session, and an empty queue", () => {
    act(() => root.render(<DjDoorButton />));
    const button = doorButton();
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-pressed")).toBe("false");
    expect(button!.disabled).toBe(true);
  });

  it("switches intent on and starts the session on the current queue when pressed with a queue", () => {
    const queue = [makeTrack("a1"), makeTrack("a2")];
    usePlayerStore.setState({
      queue,
      currentIndex: 1,
      currentTrack: queue[1],
      status: "paused",
    });

    act(() => root.render(<DjDoorButton />));
    expect(doorButton()!.disabled).toBe(false);

    clickDoor();

    expect(useDjState.getState().intent).toBe(true);
    // The intent is persisted by the fresh DJ state store.
    expect(localStorage.getItem("linerave_dj_intent_v2")).toBe("true");
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith(queue, 1);
    expect(stopMock).not.toHaveBeenCalled();
  });

  it("stops the session, clears intent, and leaves the player paused when pressed while a session runs", () => {
    const queue = [makeTrack("a1"), makeTrack("a2")];
    usePlayerStore.setState({
      queue,
      currentIndex: 0,
      currentTrack: queue[0],
      status: "playing",
    });
    useDjState.setState({ intent: true, active: true });

    act(() => root.render(<DjDoorButton />));
    expect(doorButton()!.getAttribute("aria-pressed")).toBe("true");

    clickDoor();

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(useDjState.getState().intent).toBe(false);
    expect(usePlayerStore.getState().status).toBe("paused");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("with intent already on and no session running, pressing switches DJ off — it must not retry start (fix-0119)", () => {
    const queue = [makeTrack("a1"), makeTrack("a2")];
    usePlayerStore.setState({
      queue,
      currentIndex: 0,
      currentTrack: queue[0],
      status: "playing",
    });
    useDjState.setState({ intent: true, active: false });

    act(() => root.render(<DjDoorButton />));
    expect(doorButton()!.disabled).toBe(false);

    clickDoor();

    // The pre-fix door re-fired start here, and with intent
    // persisted the user could never switch DJ off while a
    // session would not start.
    expect(startMock).not.toHaveBeenCalled();
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(useDjState.getState().intent).toBe(false);
    // The session never owned playback in this state: the plain
    // player is not paused by the switch-off.
    expect(usePlayerStore.getState().status).toBe("playing");
  });

  it("clamps a negative current index to 0 when starting", () => {
    const queue = [makeTrack("a1")];
    usePlayerStore.setState({
      queue,
      currentIndex: -1,
      currentTrack: queue[0],
      status: "paused",
    });

    act(() => root.render(<DjDoorButton />));
    clickDoor();

    expect(startMock).toHaveBeenCalledWith(queue, 0);
  });

  it("shows the standing intent, not the momentary session, in its pressed state", () => {
    // Intent on but the session between sets (not active): the
    // door still reads pressed — it is a standing setting.
    useDjState.setState({ intent: true, active: false });
    act(() => root.render(<DjDoorButton />));
    expect(doorButton()!.getAttribute("aria-pressed")).toBe("true");
  });
});
