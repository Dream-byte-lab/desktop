import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayerStore } from "../store/playerStore";
import { createMediaClock } from "./mediaClock";

// The session-liveness predicate is the mixer's own
// (liveRaveSession.isRunning). It is mocked here so each test
// decides whether a session is live; the clock's session branch
// must consult it on every call.
const sessionMock = vi.hoisted(() => ({ running: false }));

vi.mock("@/features/mixer/liverave/session", () => ({
  liveRaveSession: {
    get isRunning() {
      return sessionMock.running;
    },
  },
}));

let nowMs = 0;
let nowSpy: ReturnType<typeof vi.spyOn> | null = null;
let audio: HTMLAudioElement | null = null;

function setProp(el: object, key: string, value: unknown) {
  Object.defineProperty(el, key, { value, configurable: true, writable: true });
}

function mountElement(props: {
  currentTime: number;
  paused: boolean;
  readyState?: number;
  ended?: boolean;
  playbackRate?: number;
}): HTMLAudioElement {
  const el = document.createElement("audio");
  el.id = "liner-audio";
  setProp(el, "currentTime", props.currentTime);
  setProp(el, "paused", props.paused);
  setProp(el, "readyState", props.readyState ?? 4);
  setProp(el, "ended", props.ended ?? false);
  setProp(el, "playbackRate", props.playbackRate ?? 1);
  document.body.appendChild(el);
  audio = el;
  return el;
}

beforeEach(() => {
  nowMs = 0;
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  sessionMock.running = false;
  usePlayerStore.setState({ positionMs: 0, status: "idle" });
});

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
  audio?.remove();
  audio = null;
  sessionMock.running = false;
  usePlayerStore.setState({ positionMs: 0, status: "idle" });
});

describe("mediaClock with a live DJ session (Note 28)", () => {
  it("timeMs follows the store position, not the element frozen at session start", () => {
    // Session start paused the plain player: the element sits at
    // 12 s for the whole set. The old clock read it on every call
    // and returned 12000 forever — every assertion below fails
    // against that behaviour.
    mountElement({ currentTime: 12, paused: true });
    sessionMock.running = true;
    usePlayerStore.setState({ positionMs: 5000, status: "playing" });
    const clock = createMediaClock();

    nowMs = 1000;
    expect(clock.timeMs()).toBe(5000);
    // Between the session's 250 ms store ticks the position carries
    // forward at rate 1, so the rendered sweep stays smooth.
    nowMs = 1100;
    expect(clock.timeMs()).toBe(5100);
    // The carry never runs ahead of the session: capped at one tick.
    nowMs = 1400;
    expect(clock.timeMs()).toBe(5250);
    // The next tick lands at the carried value — re-anchor, no jump.
    usePlayerStore.setState({ positionMs: 5250 });
    expect(clock.timeMs()).toBe(5250);
    usePlayerStore.setState({ positionMs: 5500 });
    nowMs = 1450;
    expect(clock.timeMs()).toBe(5500);
  });

  it("timeMs does not carry while the session is paused", () => {
    mountElement({ currentTime: 12, paused: true });
    sessionMock.running = true;
    usePlayerStore.setState({ positionMs: 7000, status: "paused" });
    const clock = createMediaClock();

    nowMs = 0;
    expect(clock.timeMs()).toBe(7000);
    nowMs = 5000;
    expect(clock.timeMs()).toBe(7000);
  });

  it("playing() reads the store status while the element sits paused", () => {
    mountElement({ currentTime: 12, paused: true });
    sessionMock.running = true;
    const clock = createMediaClock();

    usePlayerStore.setState({ status: "playing" });
    expect(clock.playing()).toBe(true);
    usePlayerStore.setState({ status: "paused" });
    expect(clock.playing()).toBe(false);
  });

  it("the element path resumes the moment the session ends", () => {
    const el = mountElement({ currentTime: 30, paused: false });
    sessionMock.running = true;
    usePlayerStore.setState({ positionMs: 5000, status: "playing" });
    const clock = createMediaClock();

    nowMs = 0;
    expect(clock.timeMs()).toBe(5000);
    sessionMock.running = false;
    expect(clock.timeMs()).toBe(30000);
    expect(el).toBeTruthy();
  });
});

describe("mediaClock with no session (element path, unchanged)", () => {
  it("reads the element with the plain 100 ms carry cap", () => {
    mountElement({ currentTime: 30, paused: false });
    const clock = createMediaClock();

    nowMs = 0;
    expect(clock.timeMs()).toBe(30000);
    expect(clock.playing()).toBe(true);
    // The plain cap is 100 ms — the session branch's wider cap must
    // not leak into this path.
    nowMs = 250;
    expect(clock.timeMs()).toBe(30100);
  });

  it("a paused element reports its own frozen time", () => {
    mountElement({ currentTime: 8.5, paused: true });
    const clock = createMediaClock();

    nowMs = 0;
    expect(clock.timeMs()).toBe(8500);
    nowMs = 2000;
    expect(clock.timeMs()).toBe(8500);
    expect(clock.playing()).toBe(false);
  });

  it("falls back to the store position when the element is missing", () => {
    usePlayerStore.setState({ positionMs: 4242, status: "playing" });
    const clock = createMediaClock();
    expect(clock.timeMs()).toBe(4242);
  });
});
