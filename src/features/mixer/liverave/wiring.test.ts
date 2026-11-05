// wiring.test.ts — the intent wiring against fake stores and a
// fake session: arming, disarming, auto-resume, and the mirrors.

import { describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import type { LiveRaveSession, SessionEndReason } from "./session";
import { NEUTRAL_SHAPING, type Shaping } from "./shaping";
import { createDjWiring, playerSignature, type DjWiring } from "./wiring";

function makeTrack(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    artists: "Artist",
    coverUrl: "",
    durationMs: 180_000,
    playCount: 0,
  };
}

class FakeSession {
  isRunning = false;
  endReason: SessionEndReason | null = null;
  onRunningChange: ((running: boolean) => void) | null = null;
  onBlendingChange: ((blending: boolean) => void) | null = null;
  start = vi.fn(async () => {
    this.isRunning = true;
    this.onRunningChange?.(true);
  });
  setShaping = vi.fn((_shaping: Shaping) => {});
  /** Test helper: end the session the way the real one notifies. */
  end(reason: SessionEndReason): void {
    this.isRunning = false;
    this.endReason = reason;
    this.onRunningChange?.(false);
  }
  blend(value: boolean): void {
    this.onBlendingChange?.(value);
  }
}

interface FakeStores {
  intent: boolean;
  queue: Track[];
  currentIndex: number;
  status: string;
  intentListeners: Set<() => void>;
  playerListeners: Set<() => void>;
}

function buildWiring(opts: { intent?: boolean } = {}): {
  wiring: DjWiring;
  session: FakeSession;
  stores: FakeStores;
  setActive: ReturnType<typeof vi.fn>;
  setBlending: ReturnType<typeof vi.fn>;
  shapingPush: (shaping: Shaping) => void;
} {
  const session = new FakeSession();
  const queue = [makeTrack("a"), makeTrack("b")];
  const stores: FakeStores = {
    intent: opts.intent ?? true,
    queue,
    currentIndex: 0,
    status: "playing",
    intentListeners: new Set(),
    playerListeners: new Set(),
  };
  const setActive = vi.fn();
  const setBlending = vi.fn();
  let push: (shaping: Shaping) => void = () => {};
  const wiring = createDjWiring({
    session: session as unknown as LiveRaveSession,
    getIntent: () => stores.intent,
    subscribeIntent: (listener) => {
      stores.intentListeners.add(listener);
      return () => stores.intentListeners.delete(listener);
    },
    getPlayerState: () => ({
      queue: stores.queue,
      currentIndex: stores.currentIndex,
      currentTrack: stores.queue[stores.currentIndex] ?? null,
      status: stores.status,
    }),
    subscribePlayer: (listener) => {
      stores.playerListeners.add(listener);
      return () => stores.playerListeners.delete(listener);
    },
    setActive,
    setBlending,
    subscribeShapingPush: (p) => {
      push = p;
      return () => {};
    },
    initialShaping: NEUTRAL_SHAPING,
  });
  const emitPlayer = (): void => {
    for (const listener of Array.from(stores.playerListeners)) listener();
  };
  return {
    wiring,
    session,
    stores,
    setActive,
    setBlending,
    shapingPush: (shaping) => {
      push(shaping);
      void emitPlayer;
    },
  };
}

describe("createDjWiring — shaping and mirrors", () => {
  it("applies the initial shaping immediately and pushes later changes", () => {
    const { session, shapingPush } = buildWiring();
    expect(session.setShaping).toHaveBeenCalledWith(NEUTRAL_SHAPING);
    const other = { ...NEUTRAL_SHAPING, personalityId: "club" as const };
    shapingPush(other);
    expect(session.setShaping).toHaveBeenCalledWith(other);
  });

  it("mirrors running and blending into the DJ state setters", () => {
    const { session, setActive, setBlending } = buildWiring();
    session.onRunningChange?.(true);
    expect(setActive).toHaveBeenCalledWith(true);
    session.blend(true);
    expect(setBlending).toHaveBeenCalledWith(true);
    session.end("user-stop");
    expect(setActive).toHaveBeenCalledWith(false);
  });
});

describe("createDjWiring — auto-resume semantics", () => {
  it("is created armed when intent is already on at launch", () => {
    const { wiring } = buildWiring({ intent: true });
    expect(wiring.armed).toBe(true);
    const off = buildWiring({ intent: false });
    expect(off.wiring.armed).toBe(false);
  });

  it("a queue-exhausted end arms; a queue change while playing starts fresh", async () => {
    const { session, stores } = buildWiring({ intent: true });
    session.end("queue-exhausted");
    // Same signature: no restart.
    for (const l of Array.from(stores.playerListeners)) l();
    expect(session.start).not.toHaveBeenCalled();
    // A new queue arrives and the player is playing: auto-resume.
    stores.queue = [makeTrack("x"), makeTrack("y")];
    stores.currentIndex = 0;
    for (const l of Array.from(stores.playerListeners)) l();
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(session.start).toHaveBeenCalledWith(stores.queue, 0, {
      autoResume: true,
    });
  });

  it("start-no-playable arms the same way", () => {
    const { session, stores } = buildWiring({ intent: true });
    session.end("start-no-playable");
    stores.queue = [makeTrack("z")];
    for (const l of Array.from(stores.playerListeners)) l();
    expect(session.start).toHaveBeenCalledTimes(1);
  });

  it("a failed start is not terminal for the queue: a plain-player track change (same queue) retries the start (fix-0119)", () => {
    const { session, stores } = buildWiring({ intent: true });
    session.end("start-no-playable");
    // The queue is untouched; the plain player simply advances
    // to its next track. The pre-fix arming waited for a queue
    // change, so the DJ stayed dead for the rest of the queue.
    stores.currentIndex = 1;
    for (const l of Array.from(stores.playerListeners)) l();
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(session.start).toHaveBeenCalledWith(stores.queue, 1, {
      autoResume: true,
    });
  });

  it("deliberate ends disarm: user-stop and replaced never auto-resume", () => {
    for (const reason of ["user-stop", "replaced"] as const) {
      const { wiring, session, stores } = buildWiring({ intent: true });
      session.end(reason);
      expect(wiring.armed).toBe(false);
      stores.queue = [makeTrack("x")];
      for (const l of Array.from(stores.playerListeners)) l();
      expect(session.start).not.toHaveBeenCalled();
    }
  });

  it("noteDeliberateStop disarms an armed wiring", () => {
    const { wiring, session, stores } = buildWiring({ intent: true });
    session.end("queue-exhausted");
    expect(wiring.armed).toBe(true);
    wiring.noteDeliberateStop();
    expect(wiring.armed).toBe(false);
    stores.queue = [makeTrack("x")];
    for (const l of Array.from(stores.playerListeners)) l();
    expect(session.start).not.toHaveBeenCalled();
  });

  it("no auto-resume while the player is not playing, or intent is off", () => {
    const paused = buildWiring({ intent: true });
    paused.session.end("queue-exhausted");
    paused.stores.status = "paused";
    paused.stores.queue = [makeTrack("x")];
    for (const l of Array.from(paused.stores.playerListeners)) l();
    expect(paused.session.start).not.toHaveBeenCalled();

    const off = buildWiring({ intent: true });
    off.session.end("queue-exhausted");
    off.stores.intent = false;
    off.stores.queue = [makeTrack("x")];
    for (const l of Array.from(off.stores.playerListeners)) l();
    expect(off.session.start).not.toHaveBeenCalled();
  });

  it("one queue change fires exactly one start", () => {
    const { session, stores } = buildWiring({ intent: true });
    session.end("queue-exhausted");
    stores.queue = [makeTrack("x"), makeTrack("y")];
    for (const l of Array.from(stores.playerListeners)) l();
    for (const l of Array.from(stores.playerListeners)) l();
    expect(session.start).toHaveBeenCalledTimes(1);
  });

  it("dispose detaches the mirrors and stops auto-resume", () => {
    const { wiring, session, stores, setActive } = buildWiring({
      intent: true,
    });
    // Creation itself mirrors the session's current (not-running)
    // state once; only post-dispose notices are under test here.
    setActive.mockClear();
    wiring.dispose();
    session.end("queue-exhausted");
    stores.queue = [makeTrack("x")];
    for (const l of Array.from(stores.playerListeners)) l();
    expect(session.start).not.toHaveBeenCalled();
    expect(setActive).not.toHaveBeenCalledWith(false);
  });
});

describe("playerSignature", () => {
  it("changes with the queue or the current track, and only then", () => {
    const a = makeTrack("a");
    const b = makeTrack("b");
    const base = playerSignature({ queue: [a, b], currentTrack: a });
    expect(playerSignature({ queue: [a, b], currentTrack: a })).toBe(base);
    expect(playerSignature({ queue: [b, a], currentTrack: a })).not.toBe(base);
    expect(playerSignature({ queue: [a, b], currentTrack: b })).not.toBe(base);
  });
});
