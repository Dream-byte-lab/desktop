import { afterEach, describe, expect, it, vi } from "vitest";
import { popOutOverlay } from "./popOutOverlay";

// The pop-out helper against fake bridges, in the tree's
// window.linerElectron stubbing idiom: the helper's whole
// contract is which bridge calls a press may make — toggle
// only when the overlay is closed, never a guess on a failed
// read, and silence wherever the bridge is missing or fails.

function setBridge(bridge: unknown) {
  const w = window as { linerElectron?: unknown };
  if (bridge === undefined) {
    delete w.linerElectron;
  } else {
    w.linerElectron = bridge;
  }
}

afterEach(() => {
  setBridge(undefined);
});

describe("popOutOverlay", () => {
  it("does nothing, quietly, where there is no bridge (web build)", async () => {
    setBridge(undefined);
    await expect(popOutOverlay()).resolves.toBe(false);
  });

  it("does nothing when the bridge cannot toggle", async () => {
    setBridge({});
    await expect(popOutOverlay()).resolves.toBe(false);
  });

  it("toggles a closed overlay open and reports the bridge's answer", async () => {
    const toggleOverlay = vi.fn().mockResolvedValue(true);
    const isOverlayOpen = vi.fn().mockResolvedValue(false);
    setBridge({ toggleOverlay, isOverlayOpen });
    await expect(popOutOverlay()).resolves.toBe(true);
    expect(isOverlayOpen).toHaveBeenCalledTimes(1);
    expect(toggleOverlay).toHaveBeenCalledTimes(1);
  });

  it("leaves an already-open overlay alone — a press never hides it", async () => {
    const toggleOverlay = vi.fn().mockResolvedValue(true);
    const isOverlayOpen = vi.fn().mockResolvedValue(true);
    setBridge({ toggleOverlay, isOverlayOpen });
    await expect(popOutOverlay()).resolves.toBe(true);
    expect(toggleOverlay).not.toHaveBeenCalled();
  });

  it("reports false when the bridge refuses (overlay disabled in settings)", async () => {
    const toggleOverlay = vi.fn().mockResolvedValue(false);
    const isOverlayOpen = vi.fn().mockResolvedValue(false);
    setBridge({ toggleOverlay, isOverlayOpen });
    await expect(popOutOverlay()).resolves.toBe(false);
    expect(toggleOverlay).toHaveBeenCalledTimes(1);
  });

  it("never guesses on a failed state read — no toggle, no throw", async () => {
    const toggleOverlay = vi.fn().mockResolvedValue(true);
    const isOverlayOpen = vi.fn().mockRejectedValue(new Error("ipc gone"));
    setBridge({ toggleOverlay, isOverlayOpen });
    await expect(popOutOverlay()).resolves.toBe(false);
    expect(toggleOverlay).not.toHaveBeenCalled();
  });

  it("swallows a failing toggle", async () => {
    const toggleOverlay = vi.fn().mockRejectedValue(new Error("ipc gone"));
    const isOverlayOpen = vi.fn().mockResolvedValue(false);
    setBridge({ toggleOverlay, isOverlayOpen });
    await expect(popOutOverlay()).resolves.toBe(false);
  });
});
