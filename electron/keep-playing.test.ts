import { describe, expect, it, vi } from "vitest";
import { createKeepPlayingController } from "./keep-playing";

function mockBlocker() {
  return { start: vi.fn(() => 7), stop: vi.fn() };
}

describe("createKeepPlayingController", () => {
  it("holds a prevent-app-suspension blocker while playing, once", () => {
    const blocker = mockBlocker();
    const keepPlaying = createKeepPlayingController(blocker);

    keepPlaying.update({ status: "playing" });
    keepPlaying.update({ status: "buffering" });
    keepPlaying.update({ status: "playing" });

    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(keepPlaying.isHolding()).toBe(true);
  });

  it("releases when playback pauses or goes idle", () => {
    const blocker = mockBlocker();
    const keepPlaying = createKeepPlayingController(blocker);

    keepPlaying.update({ status: "playing" });
    keepPlaying.update({ status: "paused" });
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(blocker.stop).toHaveBeenCalledWith(7);
    expect(keepPlaying.isHolding()).toBe(false);

    keepPlaying.update({ status: "loading" });
    expect(blocker.start).toHaveBeenCalledTimes(2);
    keepPlaying.update({ status: "idle" });
    expect(blocker.stop).toHaveBeenCalledTimes(2);
    expect(keepPlaying.isHolding()).toBe(false);
  });

  it("never holds for a paused, idle app with no session", () => {
    const blocker = mockBlocker();
    const keepPlaying = createKeepPlayingController(blocker);

    keepPlaying.update({ status: "idle" });
    keepPlaying.update({ status: "paused" });
    keepPlaying.update({ djActive: false });

    expect(blocker.start).not.toHaveBeenCalled();
    expect(blocker.stop).not.toHaveBeenCalled();
  });

  it("is never held while the setting is off, even mid-play", () => {
    const blocker = mockBlocker();
    const keepPlaying = createKeepPlayingController(blocker);

    keepPlaying.update({ keepPlayingEnabled: false, status: "playing" });
    expect(blocker.start).not.toHaveBeenCalled();

    keepPlaying.update({ keepPlayingEnabled: true });
    expect(blocker.start).toHaveBeenCalledTimes(1);

    // Turning the setting off releases a held blocker immediately.
    keepPlaying.update({ keepPlayingEnabled: false });
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(blocker.stop).toHaveBeenCalledWith(7);
    expect(keepPlaying.isHolding()).toBe(false);
  });

  it("holds while a DJ session runs, even if the player reports paused", () => {
    const blocker = mockBlocker();
    const keepPlaying = createKeepPlayingController(blocker);

    // During a set the decks own the audio; the plain player element
    // sits paused. The running session is the playback.
    keepPlaying.update({ status: "paused", djActive: true });
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(keepPlaying.isHolding()).toBe(true);

    // The session ending releases the blocker (player still paused).
    keepPlaying.update({ djActive: false });
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(keepPlaying.isHolding()).toBe(false);
  });

  it("does not hold for a session while the setting is off", () => {
    const blocker = mockBlocker();
    const keepPlaying = createKeepPlayingController(blocker);

    keepPlaying.update({
      keepPlayingEnabled: false,
      status: "paused",
      djActive: true,
    });
    expect(blocker.start).not.toHaveBeenCalled();
  });

  it("release() drops the blocker on quit and is idempotent", () => {
    const blocker = mockBlocker();
    const keepPlaying = createKeepPlayingController(blocker);

    keepPlaying.release();
    expect(blocker.stop).not.toHaveBeenCalled();

    keepPlaying.update({ status: "playing" });
    keepPlaying.release();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(blocker.stop).toHaveBeenCalledWith(7);
    expect(keepPlaying.isHolding()).toBe(false);

    keepPlaying.release();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
  });
});
