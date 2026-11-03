import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { playerEngine, usePlayerStore } from "./playerEngine";
import { playerRuntime } from "./playerRuntime";
import type { Track } from "@/shared/types";

const mockTrack = (id: string, title: string, durationMs = 180000): Track => ({
  id,
  title,
  artists: "Artist " + id,
  durationMs,
  coverUrl: "",
  playCount: 0,
});

async function flushMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe("PlayerEngine continuity — failed tracks skip forward", () => {
  beforeEach(() => {
    // The real runtime flips the store to "loading" inside loadAndPlay;
    // the mock mirrors that so the engine's error counter sees the same
    // status sequence it sees in production.
    vi.spyOn(playerRuntime!, "loadAndPlay").mockImplementation(() => {
      usePlayerStore.getState().setStatus("loading");
      return Promise.resolve(undefined as never);
    });
    vi.spyOn(playerRuntime!, "preloadTrack").mockResolvedValue(
      undefined as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failCurrentTrack() {
    const state = usePlayerStore.getState();
    const id = state.currentTrack?.id;
    if (!id) throw new Error("no current track to fail");
    // a load failure surfaces while the track is still loading (it never
    // reached "playing") — the production sequence for a broken stream
    usePlayerStore.setState({ status: "loading" });
    playerRuntime!.onError?.({ trackId: id, message: "stream unavailable" });
  }

  it("keeps skipping forward past four consecutive failures when the queue still holds untried tracks", async () => {
    const tracks = Array.from({ length: 6 }, (_, i) =>
      mockTrack(`t${i + 1}`, `Track ${i + 1}`),
    );
    usePlayerStore.setState({
      status: "playing",
      queue: tracks,
      currentIndex: 0,
      currentTrack: tracks[0],
      positionMs: 0,
      durationMs: tracks[0].durationMs,
      repeat: "off",
      shuffle: false,
      error: null,
      autoplaySimilar: false,
      playbackContext: "playlist",
    });

    for (let i = 0; i < 4; i += 1) {
      failCurrentTrack();
      await flushMicrotasks();
    }

    // four failures in a six-track queue: the fifth track must be current,
    // not a dead stop with playable tracks remaining
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("t5");
    expect(state.currentIndex).toBe(4);
  });

  it("still stops after a full queue cycle of consecutive failures (repeat-all loop protection)", async () => {
    const tracks = Array.from({ length: 3 }, (_, i) =>
      mockTrack(`t${i + 1}`, `Track ${i + 1}`),
    );
    usePlayerStore.setState({
      status: "playing",
      queue: tracks,
      currentIndex: 0,
      currentTrack: tracks[0],
      positionMs: 0,
      durationMs: tracks[0].durationMs,
      repeat: "all",
      shuffle: false,
      error: null,
      autoplaySimilar: false,
      playbackContext: "playlist",
    });

    for (let i = 0; i < 4; i += 1) {
      failCurrentTrack();
      await flushMicrotasks();
    }

    const state = usePlayerStore.getState();
    expect(state.currentTrack).toBeNull();
    expect(state.status).toBe("idle");
  });

  it("preloads the track added to an empty 'up next' while the last track plays", async () => {
    const current = mockTrack("cur", "Current");
    const added = mockTrack("local:added", "Added");
    usePlayerStore.setState({
      status: "playing",
      queue: [current],
      currentIndex: 0,
      currentTrack: current,
      positionMs: 0,
      durationMs: current.durationMs,
      repeat: "off",
      shuffle: false,
      error: null,
      autoplaySimilar: false,
      playbackContext: "playlist",
    });
    (playerRuntime!.preloadTrack as ReturnType<typeof vi.fn>).mockClear();

    playerEngine.addToQueue(added);
    await flushMicrotasks();

    expect(playerRuntime!.preloadTrack).toHaveBeenCalledWith(added);
  });
});
