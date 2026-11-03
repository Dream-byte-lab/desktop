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

interface CrossfadeShape {
  outgoingTrackId: string;
  incomingTrack: Track;
  windowMs: number;
  phase: "loading" | "overlapping";
}

type RuntimeInternals = {
  audio: HTMLAudioElement;
  standbyAudio: HTMLAudioElement | null;
  currentTrackId: string | null;
  attachedTrackId: string | null;
  standbyAttachedTrackId: string | null;
  songFadeTrackId: string | null;
  pendingFadeInMs: number | null;
  crossfade: CrossfadeShape | null;
  cancelCrossfade: (restore: boolean) => void;
};

function internals(): RuntimeInternals {
  return playerRuntime as unknown as RuntimeInternals;
}

function setProps(el: HTMLAudioElement, props: Record<string, unknown>) {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(el, key, { value, configurable: true });
  }
}

function clearProps(el: HTMLAudioElement, ...keys: string[]) {
  for (const key of keys) Reflect.deleteProperty(el, key);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the standby element to exist with a source attached, then
 * unblocks the runtime's canplay wait. jsdom has no real media stack,
 * so readiness is driven by hand — the assertions in this suite are
 * about state, roles and gain values, never about audible output.
 */
async function standbyReady(): Promise<HTMLAudioElement> {
  for (let i = 0; i < 200; i++) {
    const el = internals().standbyAudio;
    if (el && el.getAttribute("src")) {
      // the mocked play() cannot flip jsdom's paused flag, so the
      // harness states it — the same idiom the other runtime suites
      // use for the primary element
      setProps(el, { readyState: 4, paused: false });
      el.dispatchEvent(new Event("canplay"));
      return el;
    }
    await sleep(10);
  }
  throw new Error("standby element never got a source");
}

async function untilOverlapping(): Promise<HTMLAudioElement> {
  const el = await standbyReady();
  for (let i = 0; i < 200; i++) {
    if (internals().crossfade?.phase === "overlapping") return el;
    await sleep(10);
  }
  throw new Error("crossfade never reached the overlapping phase");
}

describe("PlayerRuntime crossfade — two elements, one overlap", () => {
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
      songFadeSeconds: 0,
      crossfadeSeconds: 5,
      dispatch: dispatchSpy as never,
    });
    internals().currentTrackId = trackA.id;
    internals().attachedTrackId = trackA.id;
    internals().audio.src = "blob:mock-stream";
    setProps(internals().audio, {
      duration: 100,
      currentTime: 50,
      paused: false,
      readyState: 4,
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(
      undefined as never,
    );
    mocks.resolvePlaybackStream.mockResolvedValue({ ...urlStream });
  });

  afterEach(() => {
    internals().cancelCrossfade(false);
    vi.restoreAllMocks();
    mocks.resolvePlaybackStream.mockReset();
    clearProps(
      internals().audio,
      "duration",
      "currentTime",
      "paused",
      "readyState",
    );
    const standby = internals().standbyAudio;
    if (standby) {
      clearProps(standby, "duration", "currentTime", "paused", "readyState");
    }
    internals().currentTrackId = null;
    internals().attachedTrackId = null;
    usePlayerStore.setState({ crossfadeSeconds: 0, songFadeSeconds: 0 });
  });

  function fireTimeupdate(currentTime: number) {
    setProps(internals().audio, { currentTime });
    internals().audio.dispatchEvent(new Event("timeupdate"));
  }

  it("arms inside the window, loads the next track on the standby, and ramps both legs equal-power", async () => {
    fireTimeupdate(96); // 4s remain of 100 — inside the 5s window
    expect(internals().crossfade?.incomingTrack.id).toBe(trackB.id);

    const standby = await untilOverlapping();
    expect(standby).not.toBe(internals().audio);
    expect(standby.getAttribute("src")).toBe(urlStream.url);
    expect(internals().standbyAttachedTrackId).toBe(trackB.id);
    // the store still belongs to the outgoing track mid-overlap
    expect(usePlayerStore.getState().currentTrack?.id).toBe(trackA.id);

    // mid-overlap: 2.5s remain -> progress 0.5 -> both legs at ~0.707
    fireTimeupdate(97.5);
    await sleep(80);
    expect(internals().audio.volume).toBeCloseTo(Math.SQRT1_2, 1);
    expect(standby.volume).toBeCloseTo(Math.SQRT1_2, 1);

    // near the end the incoming leg owns the sound
    fireTimeupdate(99.5);
    await sleep(80);
    expect(standby.volume).toBeGreaterThan(0.95);
    expect(internals().audio.volume).toBeLessThan(0.35);
  }, 15000);

  it("promotes the standby at the boundary: roles, ids and store follow the incoming element", async () => {
    fireTimeupdate(96);
    const standby = await untilOverlapping();
    const oldPrimary = internals().audio;
    setProps(standby, { currentTime: 4, duration: 100 });

    // the engine's side of the boundary: optimistic store update, then
    // loadAndPlay for the next track
    usePlayerStore.setState({ currentTrack: trackB, currentIndex: 1 });
    await playerRuntime!.loadAndPlay(trackB);

    expect(internals().audio).toBe(standby);
    expect(internals().standbyAudio).toBe(oldPrimary);
    expect(standby.id).toBe("liner-audio");
    expect(oldPrimary.id).toBe("liner-audio-b");
    expect(oldPrimary.getAttribute("src")).toBeNull();
    expect(internals().currentTrackId).toBe(trackB.id);
    expect(internals().attachedTrackId).toBe(trackB.id);
    expect(internals().crossfade).toBeNull();
    const state = usePlayerStore.getState();
    expect(state.status).toBe("playing");
    expect(state.positionMs).toBe(4000);
    expect(state.durationMs).toBe(100_000);
    expect(standby.volume).toBe(1);
  }, 15000);

  it("an incoming failure mid-overlap restores the outgoing and leaves the boundary machinery intact", async () => {
    fireTimeupdate(96);
    const standby = await untilOverlapping();

    fireTimeupdate(97.5);
    await sleep(80);
    expect(internals().audio.volume).toBeLessThan(0.9); // the ramp had it

    standby.dispatchEvent(new Event("error"));
    expect(internals().crossfade).toBeNull();
    expect(internals().audio.volume).toBe(1); // restored, not sacrificed
    expect(standby.getAttribute("src")).toBeNull(); // released

    // the outgoing still ends through the ordinary advance
    setProps(internals().audio, { currentTime: 100 });
    internals().audio.dispatchEvent(new Event("ended"));
    expect(dispatchSpy).toHaveBeenCalledWith({
      type: "SKIP_NEXT",
      isAutoEnd: true,
    });
  }, 15000);

  it("an incoming load failure abandons the overlap before it starts; the outgoing never dips", async () => {
    mocks.resolvePlaybackStream.mockRejectedValue(new Error("no stream"));
    fireTimeupdate(96);
    expect(internals().crossfade).not.toBeNull();

    for (let i = 0; i < 100 && internals().crossfade; i++) {
      await sleep(10);
    }
    expect(internals().crossfade).toBeNull();
    expect(internals().audio.volume).toBe(1);
    expect(usePlayerStore.getState().status).toBe("playing");
  }, 15000);

  it("an outgoing error mid-overlap completes the hand-off early instead of recovering the broken source", async () => {
    fireTimeupdate(96);
    const standby = await untilOverlapping();

    internals().audio.dispatchEvent(new Event("error"));
    // routed through the same advance a natural end uses — no reload
    expect(dispatchSpy).toHaveBeenCalledWith({
      type: "SKIP_NEXT",
      isAutoEnd: true,
    });
    expect(mocks.resolvePlaybackStream).toHaveBeenCalledTimes(1);

    usePlayerStore.setState({ currentTrack: trackB, currentIndex: 1 });
    await playerRuntime!.loadAndPlay(trackB);
    expect(internals().audio).toBe(standby);
    expect(internals().currentTrackId).toBe(trackB.id);
  }, 15000);

  it("a seek during the window cancels the crossfade and restores the outgoing's level", async () => {
    fireTimeupdate(96);
    const standby = await untilOverlapping();
    fireTimeupdate(97.5);
    await sleep(80);
    expect(internals().audio.volume).toBeLessThan(0.9);

    playerRuntime!.seek(10_000);
    expect(internals().crossfade).toBeNull();
    expect(internals().audio.volume).toBe(1);
    expect(standby.getAttribute("src")).toBeNull();
  }, 15000);

  it("a pause during the overlap silences and releases the standby with the crossfade", async () => {
    fireTimeupdate(96);
    const standby = await untilOverlapping();
    const pauseSpy = vi.spyOn(standby, "pause");

    playerRuntime!.pause();
    expect(internals().crossfade).toBeNull();
    expect(pauseSpy).toHaveBeenCalled();
    expect(standby.getAttribute("src")).toBeNull();
  }, 15000);

  it("arriving at the boundary before the incoming is sounding falls back to the ordinary load", async () => {
    let resolveStream: (value: unknown) => void = () => {};
    mocks.resolvePlaybackStream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStream = resolve;
        }),
    );
    fireTimeupdate(96);
    expect(internals().crossfade?.phase).toBe("loading");
    // wait until the STANDBY load has consumed the pending promise —
    // only then is the boundary's own load guaranteed the next call
    for (
      let i = 0;
      i < 200 && mocks.resolvePlaybackStream.mock.calls.length === 0;
      i++
    ) {
      await sleep(10);
    }
    expect(mocks.resolvePlaybackStream).toHaveBeenCalledTimes(1);
    const primaryBefore = internals().audio;

    await playerRuntime!.loadAndPlay(trackB);
    expect(internals().audio).toBe(primaryBefore); // no swap happened
    expect(internals().currentTrackId).toBe(trackB.id);
    expect(internals().crossfade).toBeNull();
    expect(usePlayerStore.getState().status).toBe("playing");

    // the abandoned standby load resolves late and cleans up after itself
    const release = vi.fn();
    resolveStream({ ...urlStream, release });
    await sleep(30);
    expect(release).toHaveBeenCalled();
  }, 15000);

  it("never arms for repeat-one, radio, a paused player, or with the preference off", async () => {
    usePlayerStore.setState({ repeat: "one" });
    fireTimeupdate(96);
    expect(internals().crossfade).toBeNull();

    usePlayerStore.setState({
      repeat: "off",
      playbackContext: "radio:ta",
    });
    fireTimeupdate(96);
    expect(internals().crossfade).toBeNull();

    usePlayerStore.setState({ playbackContext: "playlist", status: "paused" });
    fireTimeupdate(96);
    expect(internals().crossfade).toBeNull();

    usePlayerStore.setState({ status: "playing", crossfadeSeconds: 0 });
    fireTimeupdate(96);
    expect(internals().crossfade).toBeNull();
    expect(mocks.resolvePlaybackStream).not.toHaveBeenCalled();
  }, 15000);

  it("the song fade never stacks on a crossfade boundary", async () => {
    usePlayerStore.setState({ songFadeSeconds: 5 });
    const fadeSpy = vi
      .spyOn(
        PlayerRuntime.prototype as unknown as {
          fadeVolume: (...args: unknown[]) => void;
        },
        "fadeVolume",
      )
      .mockImplementation(() => {});

    fireTimeupdate(96);
    expect(internals().crossfade?.incomingTrack.id).toBe(trackB.id);
    expect(internals().songFadeTrackId).toBeNull();
    expect(fadeSpy).not.toHaveBeenCalled();
    await untilOverlapping();
  }, 15000);
});
