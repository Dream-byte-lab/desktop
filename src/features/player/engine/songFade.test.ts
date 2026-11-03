import { describe, expect, it } from "vitest";
import {
  nextTrackForSongFade,
  songFadeWindowMs,
  MIN_SONG_FADE_MS,
} from "./songFade";
import type { PlayerState } from "../store/playerStore";
import type { Track } from "@/shared/types";

const track = (id: string, durationMs = 180000): Track => ({
  id,
  title: `Track ${id}`,
  artists: "Artist",
  durationMs,
  coverUrl: "",
  playCount: 0,
});

function stateWith(partial: Partial<PlayerState>): PlayerState {
  return {
    queue: [],
    currentIndex: -1,
    currentTrack: null,
    repeat: "off",
    shuffle: false,
    playbackContext: "playlist",
    ...partial,
  } as PlayerState;
}

describe("nextTrackForSongFade", () => {
  const queue = [track("a"), track("b"), track("c")];

  it("returns the following track mid-queue", () => {
    const next = nextTrackForSongFade(
      stateWith({ queue, currentIndex: 0, currentTrack: queue[0] }),
    );
    expect(next?.id).toBe("b");
  });

  it("returns null at the end of the queue with repeat off", () => {
    const next = nextTrackForSongFade(
      stateWith({ queue, currentIndex: 2, currentTrack: queue[2] }),
    );
    expect(next).toBeNull();
  });

  it("wraps to the first track with repeat all", () => {
    const next = nextTrackForSongFade(
      stateWith({
        queue,
        currentIndex: 2,
        currentTrack: queue[2],
        repeat: "all",
      }),
    );
    expect(next?.id).toBe("a");
  });

  it("returns null for repeat one (the same track is not a fade target)", () => {
    const next = nextTrackForSongFade(
      stateWith({
        queue,
        currentIndex: 0,
        currentTrack: queue[0],
        repeat: "one",
      }),
    );
    expect(next).toBeNull();
  });

  it("returns null in a radio context (the queue refills underneath)", () => {
    const next = nextTrackForSongFade(
      stateWith({
        queue,
        currentIndex: 0,
        currentTrack: queue[0],
        playbackContext: "radio:station-1",
      }),
    );
    expect(next).toBeNull();
  });

  it("returns null with nothing current", () => {
    expect(nextTrackForSongFade(stateWith({ queue }))).toBeNull();
  });
});

describe("songFadeWindowMs", () => {
  it("is 0 when the preference is off", () => {
    expect(songFadeWindowMs(0, 180, 180)).toBe(0);
  });

  it("uses the preference when both tracks are long", () => {
    expect(songFadeWindowMs(6, 180, 200)).toBe(6000);
  });

  it("is bounded by half the outgoing track", () => {
    expect(songFadeWindowMs(6, 8, 200)).toBe(4000);
  });

  it("is bounded by half the incoming track", () => {
    expect(songFadeWindowMs(6, 180, 4)).toBe(2000);
  });

  it("ignores an unknown incoming duration", () => {
    expect(songFadeWindowMs(6, 180, null)).toBe(6000);
    expect(songFadeWindowMs(6, 180, 0)).toBe(6000);
  });

  it("refuses windows too short to hear", () => {
    expect(songFadeWindowMs(6, 0.4, 180)).toBe(0);
    expect(MIN_SONG_FADE_MS).toBeGreaterThan(0);
  });

  it("is 0 when the outgoing duration is unknown", () => {
    expect(songFadeWindowMs(6, Number.NaN, 180)).toBe(0);
    expect(songFadeWindowMs(6, 0, 180)).toBe(0);
  });
});
