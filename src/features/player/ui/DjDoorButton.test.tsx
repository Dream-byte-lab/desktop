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
vi.mock("@/features/mixer/engine/djSession", () => ({
  djSession: { start: vi.fn(), stop: vi.fn() },
}));

import { djSession } from "@/features/mixer/engine/djSession";
import { useDjModeStore } from "@/features/mixer/store/djModeStore";
import { usePlayerStore } from "../store/playerStore";
import { DjDoorButton } from "./DjDoorButton";

function makeTrack(id: string): Track {
  return { id, title: id, artists: "Test Artist" } as unknown as Track;
}

const startMock = vi.mocked(djSession.start);
const stopMock = vi.mocked(djSession.stop);

describe("DjDoorButton — the Now Playing DJ door", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useDjModeStore.setState({
      intent: false,
      active: false,
      blending: false,
      proOpen: false,
    });
    usePlayerStore.setState({
      queue: [],
      currentIndex: -1,
      currentTrack: null,
      status: "idle",
    });
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
    useDjModeStore.setState({
      intent: false,
      active: false,
      blending: false,
      proOpen: false,
    });
    usePlayerStore.setState({
      queue: [],
      currentIndex: -1,
      currentTrack: null,
      status: "idle",
    });
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

    expect(useDjModeStore.getState().intent).toBe(true);
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
    useDjModeStore.setState({ intent: true, active: true });

    act(() => root.render(<DjDoorButton />));
    expect(doorButton()!.getAttribute("aria-pressed")).toBe("true");

    clickDoor();

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(useDjModeStore.getState().intent).toBe(false);
    expect(usePlayerStore.getState().status).toBe("paused");
    expect(startMock).not.toHaveBeenCalled();
  });
});
