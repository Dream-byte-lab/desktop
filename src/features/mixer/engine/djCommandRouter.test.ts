import { describe, expect, it, vi } from "vitest";
import type { PlayerCommand } from "../../player/store/playerStore";
import { routeDjCommand, type DjTransport } from "./djCommandRouter";

function fakeDj(running = true, paused = false): DjTransport {
  return {
    isRunning: running,
    isPaused: paused,
    pause: vi.fn(),
    resume: vi.fn(),
    skipNext: vi.fn(),
    skipPrevious: vi.fn(),
    seekTo: vi.fn(),
    stop: vi.fn(),
  };
}

describe("routeDjCommand", () => {
  it("does nothing when no session is running", () => {
    const dj = fakeDj(false);
    expect(routeDjCommand({ type: "PAUSE_REQUESTED" }, dj)).toBe(false);
    expect(dj.pause).not.toHaveBeenCalled();
  });

  it("routes pause and resume to the session", () => {
    const dj = fakeDj();
    expect(routeDjCommand({ type: "PAUSE_REQUESTED" }, dj)).toBe(true);
    expect(routeDjCommand({ type: "RESUME_REQUESTED" }, dj)).toBe(true);
    expect(dj.pause).toHaveBeenCalledTimes(1);
    expect(dj.resume).toHaveBeenCalledTimes(1);
  });

  it("toggles according to the session's own state", () => {
    const playing = fakeDj(true, false);
    routeDjCommand({ type: "TOGGLE_PLAY_PAUSE" }, playing);
    expect(playing.pause).toHaveBeenCalledTimes(1);
    const paused = fakeDj(true, true);
    routeDjCommand({ type: "TOGGLE_PLAY_PAUSE" }, paused);
    expect(paused.resume).toHaveBeenCalledTimes(1);
  });

  it("routes skips and seeks, carrying the seek position", () => {
    const dj = fakeDj();
    expect(routeDjCommand({ type: "SKIP_NEXT" }, dj)).toBe(true);
    expect(routeDjCommand({ type: "SKIP_PREVIOUS" }, dj)).toBe(true);
    expect(
      routeDjCommand({ type: "SEEK_COMMITTED", positionMs: 42_000 }, dj),
    ).toBe(true);
    expect(dj.skipNext).toHaveBeenCalledTimes(1);
    expect(dj.skipPrevious).toHaveBeenCalledTimes(1);
    expect(dj.seekTo).toHaveBeenCalledWith(42_000);
  });

  it("ends the session when the user picks a track, then lets the command through", () => {
    const dj = fakeDj();
    const command = {
      type: "PLAY_REQUESTED",
      track: { id: "x" },
    } as unknown as PlayerCommand;
    expect(routeDjCommand(command, dj)).toBe(false);
    expect(dj.stop).toHaveBeenCalledTimes(1);
  });

  it("lets volume and other commands fall through untouched", () => {
    const dj = fakeDj();
    expect(routeDjCommand({ type: "SET_VOLUME", volume: 0.5 }, dj)).toBe(false);
    expect(dj.stop).not.toHaveBeenCalled();
  });
});
