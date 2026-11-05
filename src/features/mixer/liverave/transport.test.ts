import { describe, expect, it, vi } from "vitest";
import type { PlayerCommand } from "@/features/player/store/playerStore";
import { routeDjCommand, type DjTransport } from "./transport";

function fakeTransport(
  overrides: Partial<{ isRunning: boolean; isPaused: boolean }> = {},
): DjTransport & Record<string, ReturnType<typeof vi.fn>> {
  return {
    isRunning: overrides.isRunning ?? true,
    isPaused: overrides.isPaused ?? false,
    pause: vi.fn(),
    resume: vi.fn(),
    skipNext: vi.fn(),
    skipPrevious: vi.fn(),
    seekTo: vi.fn(),
    stop: vi.fn(),
  } as never;
}

function command(partial: Record<string, unknown>): PlayerCommand {
  return partial as unknown as PlayerCommand;
}

const PLAY = command({ type: "PLAY_REQUESTED", track: { id: "picked" } });

describe("routeDjCommand — while a session runs", () => {
  it("pause / resume are handled by the session", () => {
    const t = fakeTransport();
    expect(routeDjCommand(command({ type: "PAUSE_REQUESTED" }), t)).toBe(true);
    expect(t.pause).toHaveBeenCalledTimes(1);
    expect(routeDjCommand(command({ type: "RESUME_REQUESTED" }), t)).toBe(true);
    expect(t.resume).toHaveBeenCalledTimes(1);
  });

  it("toggle pauses a playing session and resumes a paused one", () => {
    const playing = fakeTransport({ isPaused: false });
    expect(
      routeDjCommand(command({ type: "TOGGLE_PLAY_PAUSE" }), playing),
    ).toBe(true);
    expect(playing.pause).toHaveBeenCalledTimes(1);
    expect(playing.resume).not.toHaveBeenCalled();

    const paused = fakeTransport({ isPaused: true });
    expect(routeDjCommand(command({ type: "TOGGLE_PLAY_PAUSE" }), paused)).toBe(
      true,
    );
    expect(paused.resume).toHaveBeenCalledTimes(1);
    expect(paused.pause).not.toHaveBeenCalled();
  });

  it("next / previous are handled by the session", () => {
    const t = fakeTransport();
    expect(routeDjCommand(command({ type: "SKIP_NEXT" }), t)).toBe(true);
    expect(
      routeDjCommand(command({ type: "SKIP_NEXT", isAutoEnd: true }), t),
    ).toBe(true);
    expect(t.skipNext).toHaveBeenCalledTimes(2);
    expect(routeDjCommand(command({ type: "SKIP_PREVIOUS" }), t)).toBe(true);
    expect(t.skipPrevious).toHaveBeenCalledTimes(1);
  });

  it("seek is handled with the exact position", () => {
    const t = fakeTransport();
    expect(
      routeDjCommand(command({ type: "SEEK_COMMITTED", positionMs: 12345 }), t),
    ).toBe(true);
    expect(t.seekTo).toHaveBeenCalledWith(12345);
  });

  it("choosing a track stops the session and falls through", () => {
    const t = fakeTransport();
    expect(routeDjCommand(PLAY, t)).toBe(false);
    expect(t.stop).toHaveBeenCalledTimes(1);
    expect(t.pause).not.toHaveBeenCalled();
    expect(t.skipNext).not.toHaveBeenCalled();
  });

  it("non-transport commands fall through untouched", () => {
    const t = fakeTransport();
    for (const cmd of [
      command({ type: "SET_VOLUME", volume: 0.5 }),
      command({ type: "SET_PLAYBACK_RATE", rate: 1.2 }),
      command({ type: "SET_PITCH_SEMITONES", semitones: 2 }),
      command({ type: "SET_REVERB_ENABLED", enabled: true }),
      command({ type: "SET_REVERB_LEVEL", level: 0.4 }),
    ]) {
      expect(routeDjCommand(cmd, t)).toBe(false);
    }
    expect(t.pause).not.toHaveBeenCalled();
    expect(t.resume).not.toHaveBeenCalled();
    expect(t.skipNext).not.toHaveBeenCalled();
    expect(t.skipPrevious).not.toHaveBeenCalled();
    expect(t.seekTo).not.toHaveBeenCalled();
    expect(t.stop).not.toHaveBeenCalled();
  });
});

describe("routeDjCommand — no running session", () => {
  it("everything falls through and nothing is called when not running", () => {
    const t = fakeTransport({ isRunning: false });
    for (const cmd of [
      command({ type: "PAUSE_REQUESTED" }),
      command({ type: "RESUME_REQUESTED" }),
      command({ type: "TOGGLE_PLAY_PAUSE" }),
      command({ type: "SKIP_NEXT" }),
      command({ type: "SKIP_PREVIOUS" }),
      command({ type: "SEEK_COMMITTED", positionMs: 10 }),
      PLAY,
    ]) {
      expect(routeDjCommand(cmd, t)).toBe(false);
    }
    expect(t.pause).not.toHaveBeenCalled();
    expect(t.resume).not.toHaveBeenCalled();
    expect(t.skipNext).not.toHaveBeenCalled();
    expect(t.skipPrevious).not.toHaveBeenCalled();
    expect(t.seekTo).not.toHaveBeenCalled();
    // A pick with no session running must not "stop" anything.
    expect(t.stop).not.toHaveBeenCalled();
  });

  it("a null transport handles nothing", () => {
    expect(routeDjCommand(command({ type: "PAUSE_REQUESTED" }), null)).toBe(
      false,
    );
    expect(routeDjCommand(PLAY, null)).toBe(false);
  });
});
