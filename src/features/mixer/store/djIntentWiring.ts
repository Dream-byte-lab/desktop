import type { Track } from "@/shared/types";
import { usePlayerStore } from "../../player/store/playerStore";
import { djSession, type DjSessionEndReason } from "../engine/djSession";
import { useDjModeStore } from "./djModeStore";

// DJ intent auto-resume (Note 20, fix part (a)): a session that ends
// because the queue ran dry ("queue-exhausted") or because nothing
// could be prepared ("start-no-playable") has NOT been switched off
// by the user — so while intent is on, the wiring ARMS itself at
// such an end and starts a fresh session when the player moves to a
// queue state it has not already tried. Intent is a standing
// setting that survives restarts, so the wiring is also created
// armed when intent is already on at launch (Note 27): otherwise a
// cold launch could never start a session on play, and only a
// second press of the DJ button would. A deliberate end
// ("user-stop", "replaced", the button, a deliberate party stop)
// disarms: nothing resumes until the next qualifying end.
//
// The machine is event-driven only — session running-change
// notices, player-store changes, intent changes. No timers, no
// polling: a failed resume re-arms through its own
// "start-no-playable" end carrying the attempted signature, so the
// same signature can never be retried in a hot loop; only a NEW
// queue signature (different queue array, track, or index) is a new
// chance.
//
// The deps are injected behind narrow interfaces (the
// djCommandRouter DjTransport pattern) so the machine is
// unit-testable against a fake session and a fake player state.

/** What a queue state is identified by, for resume purposes. */
export interface DjIntentSignature {
  queueRef: Track[];
  currentTrackId: string | null;
  currentIndex: number;
}

interface DjIntentPlayerState {
  queue: Track[];
  currentTrack: Track | null;
  currentIndex: number;
}

/** The slice of the DJ session the wiring needs. */
export interface DjIntentSession {
  readonly isRunning: boolean;
  readonly endReason: DjSessionEndReason | null;
  onRunningChange: ((running: boolean) => void) | null;
  start: (queue: Track[], startIndex: number) => Promise<void>;
}

export interface DjIntentWiringDeps {
  session: DjIntentSession;
  getIntent: () => boolean;
  subscribeIntent: (listener: () => void) => () => void;
  getPlayerState: () => DjIntentPlayerState;
  subscribePlayer: (listener: () => void) => () => void;
  setActive: (running: boolean) => void;
}

export interface DjIntentWiring {
  /** A deliberate stop (e.g. the host ending a party on purpose). */
  noteDeliberateStop: () => void;
  readonly armed: boolean;
  dispose: () => void;
}

function signatureOf(state: DjIntentPlayerState): DjIntentSignature {
  return {
    queueRef: state.queue,
    currentTrackId: state.currentTrack?.id ?? null,
    currentIndex: state.currentIndex,
  };
}

function sameSignature(
  a: DjIntentSignature | null,
  b: DjIntentSignature | null,
): boolean {
  if (!a || !b) return false;
  return (
    a.queueRef === b.queueRef &&
    a.currentTrackId === b.currentTrackId &&
    a.currentIndex === b.currentIndex
  );
}

export function createDjIntentWiring(deps: DjIntentWiringDeps): DjIntentWiring {
  // Armed from standing intent at creation (Note 27), with both
  // signatures null: the first playback store change after a cold
  // launch is then a signature the machine has never tried, and
  // maybeResume starts the session on play exactly as it does
  // after an in-run arm.
  let armed = deps.getIntent();
  let armedSignature: DjIntentSignature | null = null;
  let lastAttemptSignature: DjIntentSignature | null = null;
  let lastIntent = deps.getIntent();

  // The wiring owns the session's running-change notice: it mirrors
  // `active` into the DJ-mode store exactly as the button once did,
  // and runs the arm/disarm machine on top of the same notice.
  const onRunningChange = (running: boolean): void => {
    deps.setActive(running);
    if (running) return; // a live session needs no resume
    const reason = deps.session.endReason;
    if (
      (reason === "queue-exhausted" || reason === "start-no-playable") &&
      deps.getIntent()
    ) {
      armed = true;
      armedSignature = signatureOf(deps.getPlayerState());
    } else if (reason === "user-stop" || reason === "replaced") {
      armed = false;
    }
  };
  deps.session.onRunningChange = onRunningChange;

  const maybeResume = (): void => {
    if (!armed || deps.session.isRunning) return;
    if (!deps.getIntent()) return;
    const state = deps.getPlayerState();
    if (state.queue.length === 0 || !state.currentTrack) return;
    const signature = signatureOf(state);
    if (sameSignature(signature, armedSignature)) return;
    if (sameSignature(signature, lastAttemptSignature)) return;
    lastAttemptSignature = signature;
    void deps.session.start(state.queue, Math.max(0, state.currentIndex));
  };

  const unsubscribePlayer = deps.subscribePlayer(maybeResume);
  const unsubscribeIntent = deps.subscribeIntent(() => {
    const intent = deps.getIntent();
    if (lastIntent && !intent) armed = false;
    lastIntent = intent;
  });

  return {
    noteDeliberateStop: () => {
      armed = false;
    },
    get armed() {
      return armed;
    },
    dispose: () => {
      unsubscribePlayer();
      unsubscribeIntent();
      if (deps.session.onRunningChange === onRunningChange) {
        deps.session.onRunningChange = null;
      }
    },
  };
}

let singleton: DjIntentWiring | null = null;

/** Creates (once) the app's wiring against the real stores/session. */
export function initDjIntentWiring(): DjIntentWiring {
  if (singleton) return singleton;
  singleton = createDjIntentWiring({
    session: djSession,
    getIntent: () => useDjModeStore.getState().intent,
    subscribeIntent: (listener) => useDjModeStore.subscribe(() => listener()),
    getPlayerState: () => {
      const state = usePlayerStore.getState();
      return {
        queue: state.queue,
        currentTrack: state.currentTrack,
        currentIndex: state.currentIndex,
      };
    },
    subscribePlayer: (listener) => usePlayerStore.subscribe(() => listener()),
    setActive: (running) => useDjModeStore.getState().setActive(running),
  });
  return singleton;
}

/**
 * The disarm export other deliberate stops call (the party host's
 * End party). A no-op before the wiring exists — in the app the DJ
 * button, which initialises it, is always mounted first.
 */
export function noteDeliberateStop(): void {
  singleton?.noteDeliberateStop();
}
