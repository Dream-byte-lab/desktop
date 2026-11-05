// DjModeButton.tsx — the player bar's DJ door and ON AIR pill
// (§10.4), written fresh against the new engine's seams.
//
// THIS MODULE IS THE NAMED BOOTSTRAP HOME for the DJ wiring: the
// startDjWiring() call at module scope below is what starts the
// intent wiring (auto-resume, shaping pushes, active/blending
// mirrors). If nothing imports this module, auto-resume silently
// dies — the deletion map's trap, kept visible on purpose.
//
// Behaviour:
// - DJ off: a quiet "DJ" door in the bar's own geometry. Pressing
//   it sets the standing intent and hands the current queue to the
//   session. The bar is otherwise the plain player's own.
// - Intent on, no session running (fix-0119): pressing the door
//   turns intent OFF. The pre-fix door only ever retried start
//   in this state, and every switch-off lived in the running
//   render — with intent persisted, a session that could not
//   start trapped the user with DJ "on" forever. Beside the
//   door, the bar shows the start attempt's real state from the
//   session's own seam: starting while a start is in flight,
//   and on failure the engine's recorded reason verbatim
//   (session.startFailure) — never silence, never invented text.
// - Session running: a living ON AIR pill — equaliser glyph plus
//   the CURRENT TECHNIQUE in text, from stageSnapshot().currentMove
//   (never invented); while the session is in its preparing
//   phase the pill says so. One tap on the pill returns the surface to
//   the Performance Ribbon (the default face); the DJ switch beside
//   it is distinct and deliberate: intent off, wiring disarmed, the
//   session stopped, the player left paused on the playing track.
// - The button shows INTENT (useDjState.intent), not whether a
//   session happens to be running this second: a set that ends on
//   its own does not read as "DJ turned itself off" — while intent
//   stays on, the wiring resumes the set on a queue change.

import { liveRaveSession } from "@/features/mixer/liverave/session";
import { useDjState } from "@/features/mixer/liverave/state";
import {
  noteDeliberateStop,
  startDjWiring,
} from "@/features/mixer/liverave/wiring";
import { usePlayerStore } from "@/features/player/store/playerStore";
import { moveLabel, useSessionView } from "./sessionView";

// The bootstrap. Idempotent in wiring.ts; module scope here is the
// contract — this import side effect is the point of the module.
startDjWiring();

interface DjModeButtonProps {
  className?: string;
  activeClassName?: string;
}

export function DjModeButton({
  className,
  activeClassName,
}: DjModeButtonProps) {
  const intent = useDjState((state) => state.intent);
  const running = useDjState((state) => state.active);
  const setIntent = useDjState((state) => state.setIntent);
  const setProOpen = useDjState((state) => state.setProOpen);
  const hasQueue = usePlayerStore(
    (state) => state.queue.length > 0 && state.currentTrack !== null,
  );

  // The view is live whenever intent is on, not only while a
  // session runs: the start attempt's state (fix-0119) is exactly
  // what the bar must show in the not-running moments.
  const view = useSessionView(liveRaveSession, running || intent);
  const move = view.snapshot?.currentMove ?? null;

  const startFromBar = () => {
    if (!intent) setIntent(true);
    const { queue, currentIndex } = usePlayerStore.getState();
    if (queue.length === 0) return;
    void liveRaveSession.start(queue, Math.max(0, currentIndex));
  };

  const switchOff = () => {
    setIntent(false);
    noteDeliberateStop();
    liveRaveSession.stop();
    usePlayerStore.getState().setStatus("paused");
  };

  // Intent on, nothing running (fix-0119): the press turns DJ
  // off. The session never owned playback in this state, so the
  // plain player is left exactly as it is — no pause is
  // published; the stop() call only settles the session's own
  // start state (a failed start's recorded reason clears).
  const switchOffIdle = () => {
    setIntent(false);
    noteDeliberateStop();
    liveRaveSession.stop();
  };

  if (running) {
    return (
      <span className="inline-flex items-center gap-1" data-on-air>
        <button
          type="button"
          aria-label="ON AIR — open the performance ribbon"
          title="ON AIR — the DJ session is running. Tap to return to the performance ribbon."
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setProOpen(false)}
          className="inline-flex max-w-[170px] cursor-pointer items-center gap-1.5 rounded-full bg-[#ff3d81]/15 px-2 py-1 text-[#ff8fb8]"
          style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em" }}
        >
          <span className="flex items-end gap-[2px]" aria-hidden="true">
            {[5, 9, 7].map((height, i) => (
              <span
                key={i}
                className="w-[2.5px] animate-pulse rounded-full bg-current"
                style={{ height, animationDelay: `${i * 160}ms` }}
              />
            ))}
          </span>
          ON AIR
          {view.preparing && (
            <span
              className="truncate font-bold text-white/85 normal-case"
              data-dj-preparing
            >
              Preparing — the decks take over when the track is ready
            </span>
          )}
          {move && (
            <span
              className="truncate font-bold text-white/85 normal-case"
              data-current-technique
            >
              {moveLabel(move.family, move.technique) || move.label}
            </span>
          )}
        </button>
        <button
          type="button"
          aria-label="Switch DJ off"
          aria-pressed={intent}
          title="Switch DJ mode off — the session stops and the player is left paused on this track"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={switchOff}
          className={`${className ?? ""} ${intent ? (activeClassName ?? "") : ""}`}
          style={{
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
          }}
        >
          DJ
        </button>
      </span>
    );
  }

  const disabled = !intent && !hasQueue;

  // The start attempt's real state, from the session's own seam
  // (fix-0119): shown only while intent is on and nothing is
  // running — the moments that used to be silent.
  const startStatus =
    intent && view.startState === "failed" ? (
      <span
        data-dj-status="failed"
        role="status"
        title={view.startFailure ?? undefined}
        className="max-w-[220px] truncate text-[#ff8fb8]"
        style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.04em" }}
      >
        DJ could not start — {view.startFailure ?? "no reason was recorded"}
      </span>
    ) : intent && view.startState === "starting" ? (
      <span
        data-dj-status="starting"
        role="status"
        className="max-w-[220px] truncate text-white/70"
        style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.04em" }}
      >
        DJ starting — preparing the set…
      </span>
    ) : null;

  return (
    <span className="inline-flex items-center gap-1.5">
      {startStatus}
      <button
        type="button"
        aria-label="DJ mode"
        aria-pressed={intent}
        title={
          intent
            ? "DJ mode is on — this is your standing setting: songs are blended automatically, and a set that ends on its own resumes while it stays on. No session is running right now. Press to switch DJ mode off."
            : "DJ mode — switch on to play this queue with automatic beatmatched blends, and keep playing it while the setting stays on"
        }
        disabled={disabled}
        className={`${className ?? ""} ${intent ? (activeClassName ?? "") : ""}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={intent ? switchOffIdle : startFromBar}
        style={{
          cursor: "pointer",
          // No width/padding overrides: the player bar passes the shared
          // 30px icon-button class, and this button must live inside the
          // same geometry budget as its siblings.
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        DJ
      </button>
    </span>
  );
}
