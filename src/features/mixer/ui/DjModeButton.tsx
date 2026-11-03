import { usePlayerStore } from "../../player/store/playerStore";
import { djSession } from "../engine/djSession";
import { initDjIntentWiring } from "../store/djIntentWiring";
import { useDjModeStore } from "../store/djModeStore";
import { initPersonalityWiring } from "../store/personalityWiring";

// The DJ mode switch for the player bar. It shows the user's
// standing INTENT (djModeStore.intent), not whether a session
// happens to be running this second: a session that ends on its own
// no longer reads as "DJ turned itself off" (Note 20) — while
// intent is on, the intent wiring resumes the set on the current
// queue. One press on: intent is set and the current queue is handed
// to the DJ session, which plays it with automatic blends. Pressed
// while a session runs: intent is cleared, the session stops and
// the player is left paused on the track that was playing. Pressed
// with intent on but no session running: the set starts on the
// current queue now. There is deliberately nothing else to
// configure — the whole point is that it looks like one button.

// The intent wiring owns the session's running-change notice (it
// mirrors `active` into the store and runs the auto-resume machine).
initDjIntentWiring();
initPersonalityWiring();

djSession.onBlendChange = (blending) => {
  useDjModeStore.getState().setBlending(blending);
};

interface DjModeButtonProps {
  className?: string;
  activeClassName?: string;
}

export function DjModeButton({
  className,
  activeClassName,
}: DjModeButtonProps) {
  const intent = useDjModeStore((state) => state.intent);
  const running = useDjModeStore((state) => state.active);
  const setIntent = useDjModeStore((state) => state.setIntent);
  const hasQueue = usePlayerStore(
    (state) => state.queue.length > 0 && state.currentTrack !== null,
  );

  const toggle = () => {
    if (running) {
      setIntent(false);
      djSession.stop();
      usePlayerStore.getState().setStatus("paused");
      return;
    }
    if (!intent) setIntent(true);
    const { queue, currentIndex } = usePlayerStore.getState();
    if (queue.length === 0) return;
    void djSession.start(queue, Math.max(0, currentIndex));
  };

  const disabled = !intent && !running && !hasQueue;

  return (
    <button
      type="button"
      aria-label="DJ mode"
      aria-pressed={intent}
      title={
        intent
          ? "DJ mode is on — this is your standing setting: songs are blended automatically, and a set that ends on its own resumes while it stays on. Press to switch DJ mode off."
          : "DJ mode — switch on to play this queue with automatic beatmatched blends, and keep playing it while the setting stays on"
      }
      disabled={disabled}
      className={`${className ?? ""} ${intent ? (activeClassName ?? "") : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={toggle}
      style={{
        cursor: "pointer",
        // No width/padding overrides: the player bar passes the shared
        // 30px icon-button class, and this button must live inside the
        // same geometry budget as its siblings (an auto-width text
        // button here is what pushed the bar's queue/expand buttons
        // out of the frame — Step 2, slice C).
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.08em",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      DJ
    </button>
  );
}
