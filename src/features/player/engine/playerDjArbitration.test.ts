import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A controllable stand-in for the DJ session singleton: the router and
// the engine only ever see the DjTransport surface, and stop() flips
// isRunning off exactly like the real session does.
const dj = vi.hoisted(() => {
  const state = { running: false, paused: false };
  return {
    state,
    transport: {
      get isRunning() {
        return state.running;
      },
      get isPaused() {
        return state.paused;
      },
      pause: vi.fn(() => {
        state.paused = true;
      }),
      resume: vi.fn(() => {
        state.paused = false;
      }),
      skipNext: vi.fn(),
      skipPrevious: vi.fn(),
      seekTo: vi.fn(),
      stop: vi.fn(() => {
        state.running = false;
        state.paused = false;
      }),
    },
  };
});
vi.mock("@/features/mixer/engine/djSession", () => ({
  djSession: dj.transport,
}));

import { playerEngine, usePlayerStore } from "./playerEngine";
import { api } from "@/shared/api";
import type { Track } from "@/shared/types";

const track = (id: string): Track => ({
  id,
  title: `Song ${id}`,
  artists: `Artist ${id}`,
  durationMs: 180_000,
  coverUrl: `https://example.com/${id}.jpg`,
  playCount: 0,
});

describe("hand-picked tracks end the DJ session (Note 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dj.state.running = false;
    dj.state.paused = false;
    usePlayerStore.getState().resetPlayback();
    vi.spyOn(api, "recordPlaybackEvent").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dj.state.running = false;
  });

  it("stops the session when a track is picked from another playlist, and only the picked track plays", async () => {
    // The user's exact sequence: DJ mode is on, playlist A is sounding
    // on the session's own decks (the store mirrors the session's
    // current track), then a song from playlist B is tapped.
    const playlistA = [track("a1"), track("a2")];
    const playlistB = [track("b1"), track("b2")];
    usePlayerStore.getState().setQueue(playlistA);
    usePlayerStore.getState().setCurrentTrack(playlistA[0], 0);
    dj.state.running = true;

    await playerEngine.playTrack(playlistB[0], playlistB, "Playlist B");

    expect(dj.transport.stop).toHaveBeenCalledTimes(1);
    expect(dj.state.running).toBe(false);
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("b1");
    expect(state.queue.map((t) => t.id)).toEqual(["b1", "b2"]);
    expect(state.playbackContext).toBe("Playlist B");
    expect(state.status).toBe("loading");
  });

  it("does not touch the session when none is running", async () => {
    await playerEngine.playTrack(track("x"), [track("x")]);

    expect(dj.transport.stop).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("x");
  });

  it("stops the session for a shuffled pick too", async () => {
    dj.state.running = true;
    const tracks = [track("s1"), track("s2"), track("s3")];

    await playerEngine.playShuffled(tracks, "Mix", null, 0);

    expect(dj.transport.stop).toHaveBeenCalledTimes(1);
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("s1");
    expect(state.queue).toHaveLength(3);
  });

  it("stops the session when a radio station is started from a track", async () => {
    dj.state.running = true;
    vi.spyOn(api, "getRadio").mockResolvedValue({ items: [] } as never);

    await playerEngine.startRadioStation(track("r1"));

    expect(dj.transport.stop).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("r1");
  });

  it("a PLAY_REQUESTED through the store channel stops the session exactly once", async () => {
    dj.state.running = true;
    const playlistB = [track("b1"), track("b2")];

    usePlayerStore.getState().dispatch({
      type: "PLAY_REQUESTED",
      track: playlistB[0],
      queue: playlistB,
      context: "Playlist B",
    });
    await Promise.resolve();

    // Once via the channel's router, and not again when playTrack
    // re-offers the pick (by then the session is already stopped).
    expect(dj.transport.stop).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b1");
  });
});

describe("playerEngine.hasActivePlayback (Note 7 guard input)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dj.state.running = false;
    dj.state.paused = false;
    usePlayerStore.getState().resetPlayback();
    vi.spyOn(api, "recordPlaybackEvent").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dj.state.running = false;
  });

  it("is false when the player is idle and no session runs", () => {
    expect(playerEngine.hasActivePlayback()).toBe(false);
  });

  it("is true while a track is playing, loading or paused mid-queue", async () => {
    await playerEngine.playTrack(track("p"), [track("p"), track("q")]);
    expect(playerEngine.hasActivePlayback()).toBe(true); // loading

    usePlayerStore.getState().setStatus("playing");
    expect(playerEngine.hasActivePlayback()).toBe(true);

    usePlayerStore.getState().setStatus("paused");
    expect(playerEngine.hasActivePlayback()).toBe(true);
  });

  it("is true while a DJ session runs, even with the plain player idle", () => {
    dj.state.running = true;
    expect(playerEngine.hasActivePlayback()).toBe(true);
  });

  it("is false again after an explicit stopAndClear", async () => {
    await playerEngine.playTrack(track("p"), [track("p")]);
    await playerEngine.stopAndClear();
    expect(playerEngine.hasActivePlayback()).toBe(false);
  });
});
