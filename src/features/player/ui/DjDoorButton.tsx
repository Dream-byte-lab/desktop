import { djSession } from "@/features/mixer/engine/djSession";
import { useDjModeStore } from "@/features/mixer/store/djModeStore";
import { cn } from "@/shared/lib";
import { usePlayerStore } from "../store/playerStore";
import { useGlassBlur } from "../store/visualModeStore";

// The Now Playing card's DJ door (design read, Open Question 3
// RULED): the card's top-right EQ-bars glyph is the DJ/liveRave
// door — the same DJ control the player bar carries, in the card's
// own glass-button language. It shows the user's standing INTENT
// (djModeStore.intent), not whether a session happens to be
// running this second, exactly like the bar's button.
//
// The toggle logic below mirrors DjModeButton.toggle line for line
// in semantics because DjModeButton does not export its internals
// and that file is fenced off from this build: both doors must do
// precisely the same thing — running → clear intent, stop the
// session, leave the player paused; otherwise → set intent if
// unset, bail on an empty queue, hand the current queue to the
// session from the current index. The bar button's module-scope
// wiring (initDjIntentWiring / onBlendChange) is NOT replicated
// here: it is installed once by the bar's button, which is always
// mounted in the shell, and installing it twice would double-wire
// the session.
export function DjDoorButton() {
  const intent = useDjModeStore((state) => state.intent);
  const running = useDjModeStore((state) => state.active);
  const setIntent = useDjModeStore((state) => state.setIntent);
  const glassBlur = useGlassBlur();
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
      onPointerDown={(e) => e.stopPropagation()}
      onClick={toggle}
      className={cn(
        "relative inline-flex h-[40px] w-[40px] shrink-0 cursor-pointer items-center justify-center rounded-[11px] border-none transition-colors duration-200 ease-out hover:bg-white/[0.12] active:scale-[0.92]",
        glassBlur && "backdrop-blur-xl backdrop-brightness-[1.15]",
        intent
          ? "bg-accent-primary/15 text-accent-primary hover:bg-accent-primary/20"
          : "bg-white/[0.06] text-white/80",
        disabled && "opacity-40",
      )}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <rect
          x="1.3"
          y="6"
          width="2.6"
          height="8"
          rx="1.3"
          fill="currentColor"
        />
        <rect
          x="5"
          y="3.5"
          width="2.6"
          height="13"
          rx="1.3"
          fill="currentColor"
        />
        <rect
          x="8.7"
          y="1.5"
          width="2.6"
          height="17"
          rx="1.3"
          fill="currentColor"
        />
        <rect
          x="12.4"
          y="4"
          width="2.6"
          height="12"
          rx="1.3"
          fill="currentColor"
        />
        <rect
          x="16.1"
          y="5.5"
          width="2.6"
          height="9"
          rx="1.3"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}
