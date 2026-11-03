import { usePlayerStore } from "../../player/store/playerStore";
import { djSession } from "../engine/djSession";
import { useDjModeStore } from "../store/djModeStore";

// The DJ mode switch for the player bar. One press: the current queue
// is handed to the DJ session, which plays it with automatic blends.
// Pressed again, the session stops and the player is left paused on
// the track that was playing. There is deliberately nothing else to
// configure — the whole point is that it looks like one button.

djSession.onRunningChange = (running) => {
  useDjModeStore.getState().setActive(running);
};

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
  const active = useDjModeStore((state) => state.active);
  const hasQueue = usePlayerStore(
    (state) => state.queue.length > 0 && state.currentTrack !== null,
  );

  const toggle = () => {
    if (active) {
      djSession.stop();
      usePlayerStore.getState().setStatus("paused");
      return;
    }
    const { queue, currentIndex } = usePlayerStore.getState();
    if (queue.length === 0) return;
    void djSession.start(queue, Math.max(0, currentIndex));
  };

  return (
    <button
      type="button"
      aria-label="DJ mode"
      aria-pressed={active}
      title={
        active
          ? "DJ mode is on — songs are being blended automatically. Press to stop."
          : "DJ mode — play this queue with automatic beatmatched blends"
      }
      disabled={!active && !hasQueue}
      className={`${className ?? ""} ${active ? (activeClassName ?? "") : ""}`}
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
        opacity: !active && !hasQueue ? 0.4 : 1,
      }}
    >
      DJ
    </button>
  );
}
