import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ resolvePlaybackStream: vi.fn() }));

vi.mock("./streamResolver", () => ({
  resolvePlaybackStream: mocks.resolvePlaybackStream,
}));

import { playerRuntime, PlayerRuntime } from "./playerRuntime";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "@/shared/types";

const urlStream = {
  url: "https://rr1.googlevideo.com/videoplayback?itag=251",
  mimeType: "audio/webm",
  codec: "opus",
  bitrate: 128000,
  expiresAtMs: null,
};

const trackA: Track = {
  id: "ta",
  title: "Track A",
  artists: "Artist",
  durationMs: 100_000,
  coverUrl: "",
  playCount: 0,
};

const trackB: Track = {
  id: "tb",
  title: "Track B",
  artists: "Artist",
  durationMs: 100_000,
  coverUrl: "",
  playCount: 0,
};

type RuntimeInternals = {
  audio: HTMLAudioElement;
  currentTrackId: string | null;
  attachedTrackId: string | null;
  preloadingTrackId: string | null;
  preloadingPromise: Promise<void> | null;
  songFadeTrackId: string | null;
  pendingFadeInMs: number | null;
};

function internals(): RuntimeInternals {
  return playerRuntime as unknown as RuntimeInternals;
}

function setAudioProps(props: Record<string, unknown>) {
  const audio = internals().audio;
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(audio, key, { value, configurable: true });
  }
}

function clearAudioProps(...keys: string[]) {
  const audio = internals().audio;
  for (const key of keys) Reflect.deleteProperty(audio, key);
}

describe("PlayerRuntime continuity — the 'ended' event must advance the queue", () => {
  let dispatchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchSpy = vi.fn();
    usePlayerStore.setState({
      status: "playing",
      currentTrack: trackA,
      queue: [trackA, trackB],
      currentIndex: 0,
      positionMs: 0,
      durationMs: trackA.durationMs,
      volume: 1,
      repeat: "off",
      shuffle: false,
      playbackContext: "playlist",
      error: null,
      dispatch: dispatchSpy as never,
    });
    internals().currentTrackId = trackA.id;
    internals().attachedTrackId = trackA.id;
    internals().audio.src = "blob:mock-stream";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAudioProps("duration", "currentTime", "paused", "readyState");
    internals().currentTrackId = null;
    internals().attachedTrackId = null;
  });

  function fireEnded(duration: number, currentTime: number) {
    setAudioProps({ duration, currentTime });
    internals().audio.dispatchEvent(new Event("ended"));
  }

  it("advances when the delivered audio runs out well before the reported duration (truncated/progressive stream)", () => {
    fireEnded(240, 30);
    expect(dispatchSpy).toHaveBeenCalledWith({
      type: "SKIP_NEXT",
      isAutoEnd: true,
    });
  });

  it("advances when the element reports no usable duration but playback progressed", () => {
    fireEnded(Number.NaN, 42);
    expect(dispatchSpy).toHaveBeenCalledWith({
      type: "SKIP_NEXT",
      isAutoEnd: true,
    });
  });

  it("still advances on a normal end (position at the reported duration)", () => {
    fireEnded(100, 99.6);
    expect(dispatchSpy).toHaveBeenCalledWith({
      type: "SKIP_NEXT",
      isAutoEnd: true,
    });
  });

  it("still ignores an 'ended' with no playback at all (empty-load artefact)", () => {
    fireEnded(240, 0);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe("PlayerRuntime continuity — a stuck preload must not block the next track", () => {
  beforeEach(() => {
    usePlayerStore.setState({
      status: "playing",
      currentTrack: trackA,
      queue: [trackA, trackB],
      currentIndex: 0,
      positionMs: 0,
      durationMs: trackA.durationMs,
      volume: 1,
      repeat: "off",
      shuffle: false,
      playbackContext: "playlist",
      error: null,
    });
    setAudioProps({ readyState: 4, paused: true });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(
      undefined as never,
    );
    mocks.resolvePlaybackStream.mockResolvedValue({ ...urlStream });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.resolvePlaybackStream.mockReset();
    clearAudioProps("readyState", "paused");
    internals().preloadingTrackId = null;
    internals().preloadingPromise = null;
    internals().currentTrackId = null;
    internals().attachedTrackId = null;
  });

  it("proceeds to the progressive stream when the same-track preload never finishes", async () => {
    internals().preloadingTrackId = trackB.id;
    internals().preloadingPromise = new Promise<void>(() => {});

    const load = playerRuntime!.loadAndPlay(trackB);
    const outcome = await Promise.race([
      load.then(() => "loaded" as const),
      new Promise<"stuck">((resolve) =>
        setTimeout(() => resolve("stuck"), 4000),
      ),
    ]);

    expect(outcome).toBe("loaded");
    expect(mocks.resolvePlaybackStream).toHaveBeenCalled();
    expect(usePlayerStore.getState().status).toBe("playing");
    // the runtime's own bookkeeping moved to the new track (the store's
    // currentTrack is the engine's write, not the runtime's)
    expect(internals().currentTrackId).toBe(trackB.id);
  }, 15000);
});

type RuntimeProto = {
  fadeVolume: (targetVolume: number, durationMs?: number) => void;
  cancelFade: () => void;
};

describe("PlayerRuntime song fade — fade out at the end, fade in on the next track", () => {
  let fadeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    usePlayerStore.setState({
      status: "playing",
      currentTrack: trackA,
      queue: [trackA, trackB],
      currentIndex: 0,
      positionMs: 0,
      durationMs: trackA.durationMs,
      volume: 1,
      repeat: "off",
      shuffle: false,
      playbackContext: "playlist",
      error: null,
      // the fade preference under test (seconds; 0 = off)
      songFadeSeconds: 5,
    });
    internals().currentTrackId = trackA.id;
    internals().attachedTrackId = trackA.id;
    internals().songFadeTrackId = null;
    internals().pendingFadeInMs = null;
    internals().audio.src = "blob:mock-stream";
    setAudioProps({ paused: false, duration: 100 });
    fadeSpy = vi
      .spyOn(PlayerRuntime.prototype as unknown as RuntimeProto, "fadeVolume")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearAudioProps("duration", "currentTime", "paused", "readyState");
    internals().currentTrackId = null;
    internals().attachedTrackId = null;
    internals().songFadeTrackId = null;
    internals().pendingFadeInMs = null;
  });

  function fireTimeupdate(currentTime: number) {
    setAudioProps({ currentTime });
    internals().audio.dispatchEvent(new Event("timeupdate"));
  }

  it("fades the outgoing track out over the remaining seconds inside the window", () => {
    fireTimeupdate(96); // 4s left, window is 5s
    expect(fadeSpy).toHaveBeenCalledWith(0, 4000);
  });

  it("does not fade while plenty of the track remains", () => {
    fireTimeupdate(50);
    expect(fadeSpy).not.toHaveBeenCalled();
  });

  it("restores full volume if the listener seeks back out of the fade window", () => {
    fireTimeupdate(96);
    expect(fadeSpy).toHaveBeenCalledWith(0, 4000);
    internals().audio.volume = 0.2;
    const cancelSpy = vi.spyOn(
      PlayerRuntime.prototype as unknown as RuntimeProto,
      "cancelFade",
    );
    fireTimeupdate(10); // seeked back: 90s remain, far outside the window
    expect(cancelSpy).toHaveBeenCalled();
    expect(internals().audio.volume).toBe(1);
  });

  it("the next track's start fade lasts the fade window, not the 180ms default", async () => {
    fireTimeupdate(96);
    expect(internals().pendingFadeInMs).toBe(5000);

    setAudioProps({ readyState: 4, paused: true });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(
      undefined as never,
    );
    mocks.resolvePlaybackStream.mockResolvedValue({ ...urlStream });

    await playerRuntime!.loadAndPlay(trackB);
    expect(fadeSpy).toHaveBeenCalledWith(1, 5000);
    expect(fadeSpy).not.toHaveBeenCalledWith(1, 180);
    mocks.resolvePlaybackStream.mockReset();
  }, 15000);
});
