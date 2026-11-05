// wiring.ts — the fresh intent wiring (Wave 2D, design §3.8/§3.9).
//
// Connects the three standing stores to the session:
// - settings.ts's resolved Shaping is pushed into the session on
//   subscribe and on every later change (subscribeShaping);
// - the session's running/blending state is mirrored into
//   useDjState (setActive / setBlending) via its notices;
// - state.ts's DJ intent drives AUTO-RESUME, with the semantics
//   re-derived from the requirements (deletion map §3.2/§3.3, the
//   Note 20/27 behaviours):
//     · a session end is NOT intent off — intent is the user's
//       standing wish and survives the night ending;
//     · an end with reason "queue-exhausted" or "start-no-playable"
//       ARMS auto-resume (while intent is on): the current player
//       signature is recorded, and when the queue signature later
//       CHANGES while intent is on and the player is playing, a
//       fresh session starts by itself;
//     · a deliberate end — reason "user-stop" or "replaced", or an
//       explicit noteDeliberateStop() — DISARMS: the night does not
//       restart itself behind the user's back;
//     · the wiring is created armed when intent is already on at
//       launch (armed against the launch signature, so only a real
//       queue change fires the first auto-resume).
//
// startDjWiring() is the idempotent singleton bootstrap (the fresh
// DjModeButton module or the app bootstrap calls it — deletion map
// §3.1: something named must, or auto-resume silently dies).

import type { Track } from "@/shared/types";
import { liveRaveSession, type LiveRaveSession } from "./session";
import {
  resolveCurrentShaping,
  subscribeShaping,
  useDjSettings,
} from "./settings";
import type { Shaping } from "./shaping";
import { useDjState } from "./state";
import { usePlayerStore } from "@/features/player/store/playerStore";

export interface DjWiringDeps {
  session: LiveRaveSession;
  getIntent(): boolean;
  subscribeIntent(listener: () => void): () => void;
  getPlayerState(): {
    queue: Track[];
    currentIndex: number;
    currentTrack: Track | null;
    status: string;
  };
  subscribePlayer(listener: () => void): () => void;
  setActive(active: boolean): void;
  setBlending(blending: boolean): void;
  /** Pushes resolved shaping; default wires settings.subscribeShaping. */
  subscribeShapingPush?: (push: (shaping: Shaping) => void) => () => void;
  initialShaping?: Shaping;
}

export interface DjWiring {
  /** A deliberate stop disarms auto-resume (deletion map §3.2). */
  noteDeliberateStop(): void;
  /** Whether auto-resume is currently armed. */
  readonly armed: boolean;
  dispose(): void;
}

/** The queue signature auto-resume watches for changes against. */
export function playerSignature(state: {
  queue: Track[];
  currentTrack: Track | null;
}): string {
  const ids = state.queue.map((t) => t.id).join(",");
  return `${ids}|${state.currentTrack?.id ?? ""}`;
}

export function createDjWiring(deps: DjWiringDeps): DjWiring {
  const session = deps.session;
  let armed = deps.getIntent();
  let armedSignature = playerSignature(deps.getPlayerState());
  let disposed = false;

  // Shaping: applied immediately (the session must never run a
  // beat on a stale personality), then on every resolved change.
  if (deps.initialShaping) {
    session.setShaping(deps.initialShaping);
  }
  const subscribeShapingPush =
    deps.subscribeShapingPush ??
    ((push: (shaping: Shaping) => void) => subscribeShaping(push));
  const unsubscribeShaping = subscribeShapingPush((shaping) => {
    session.setShaping(shaping);
  });

  // Running/blending mirrors. Chain any handler the session
  // already carries — the wiring is a consumer, not an owner.
  const previousRunning = session.onRunningChange;
  session.onRunningChange = (running: boolean) => {
    previousRunning?.(running);
    deps.setActive(running);
    if (disposed) return;
    if (!running) {
      const reason = session.endReason;
      if (
        deps.getIntent() &&
        (reason === "queue-exhausted" || reason === "start-no-playable")
      ) {
        armed = true;
        armedSignature = playerSignature(deps.getPlayerState());
      } else if (reason === "user-stop" || reason === "replaced") {
        armed = false;
      }
    }
  };
  const previousBlending = session.onBlendingChange;
  session.onBlendingChange = (blending: boolean) => {
    previousBlending?.(blending);
    deps.setBlending(blending);
  };
  // Mirror the state the session is already in at wiring time.
  deps.setActive(session.isRunning);

  const maybeAutoResume = (): void => {
    if (disposed || !armed) return;
    if (!deps.getIntent()) return;
    if (session.isRunning) return;
    const state = deps.getPlayerState();
    if (state.status !== "playing") return;
    if (state.queue.length === 0) return;
    const signature = playerSignature(state);
    if (signature === armedSignature) return;
    // A real queue change while armed + intent on + playing:
    // start fresh. The signature is consumed so one change fires
    // exactly one start.
    armedSignature = signature;
    void session.start(state.queue, Math.max(0, state.currentIndex), {
      autoResume: true,
    });
  };

  const unsubscribePlayer = deps.subscribePlayer(maybeAutoResume);
  const unsubscribeIntent = deps.subscribeIntent(() => {
    // Intent arriving while armed and playing is a resume signal
    // too — the same check decides (it no-ops unless every
    // condition holds).
    maybeAutoResume();
  });

  return {
    noteDeliberateStop(): void {
      armed = false;
    },
    get armed(): boolean {
      return armed;
    },
    dispose(): void {
      disposed = true;
      unsubscribeShaping();
      unsubscribePlayer();
      unsubscribeIntent();
      if (session.onRunningChange) {
        session.onRunningChange = previousRunning ?? null;
      }
      if (session.onBlendingChange) {
        session.onBlendingChange = previousBlending ?? null;
      }
    },
  };
}

// ---------------------------------------------------------------------
// The singleton bootstrap
// ---------------------------------------------------------------------

let singleton: DjWiring | null = null;

/** Idempotent: the first call builds the wiring; later calls return it. */
export function startDjWiring(): DjWiring {
  if (singleton) return singleton;
  singleton = createDjWiring({
    session: liveRaveSession,
    getIntent: () => useDjState.getState().intent,
    subscribeIntent: (listener) => useDjState.subscribe(() => listener()),
    getPlayerState: () => {
      const state = usePlayerStore.getState();
      return {
        queue: state.queue,
        currentIndex: state.currentIndex,
        currentTrack: state.currentTrack,
        status: state.status,
      };
    },
    subscribePlayer: (listener) => usePlayerStore.subscribe(() => listener()),
    setActive: (active) => useDjState.getState().setActive(active),
    setBlending: (blending) => useDjState.getState().setBlending(blending),
    initialShaping: resolveCurrentShaping(useDjSettings.getState()),
  });
  return singleton;
}

/**
 * Records a deliberate stop against the singleton wiring: the
 * night must not restart itself. A no-op before the wiring exists
 * (deletion map §3.2 — the same contract as the old export).
 */
export function noteDeliberateStop(): void {
  singleton?.noteDeliberateStop();
}
