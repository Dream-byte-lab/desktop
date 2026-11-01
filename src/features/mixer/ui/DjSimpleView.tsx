import { Pause, Play, SkipNext, SkipPrevious } from "@solar-icons/react";
import { usePlayerStore } from "../../player/store/playerStore";
import { useDjModeStore } from "../store/djModeStore";

// The Simple deck view: the same two decks and the same DJ session,
// presented for someone who has never seen DJ decks — and sized for a
// phone-width screen. Nothing here is a separate player: it reads the
// player's own store and sends the player's own commands, which the
// session answers while DJ mode runs (see djCommandRouter). What it
// shows is deliberately little:
//
// - what is playing now, with a plain progress bar;
// - what is coming next;
// - whether a blend is sounding right now;
// - three big buttons: previous, play/pause, next.
//
// It appears only while DJ mode is on. The full player underneath is
// untouched — this is an additional, simpler face on the same machine.

function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

const controlButtonClass =
  "inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/[0.05] dark:bg-white/[0.09] text-text-primary transition-transform active:scale-95 border-none cursor-pointer";

export function DjSimpleView() {
  const active = useDjModeStore((state) => state.active);
  const blending = useDjModeStore((state) => state.blending);
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const nextTrack = usePlayerStore(
    (state) => state.queue[state.currentIndex + 1] ?? null,
  );
  const status = usePlayerStore((state) => state.status);
  const positionMs = usePlayerStore((state) => state.positionMs);
  const durationMs = usePlayerStore((state) => state.durationMs);

  if (!active || !currentTrack) return null;

  const dispatch = usePlayerStore.getState().dispatch;
  const progress =
    durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  const playing = status === "playing";

  return (
    <div className="w-full border-t border-border-tertiary bg-bg-primary px-3 py-2 text-text-primary">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {currentTrack.coverUrl ? (
            <img
              src={currentTrack.coverUrl}
              alt=""
              className="h-10 w-10 shrink-0 rounded-md object-cover"
            />
          ) : null}
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
              Now playing
            </div>
            <div className="truncate text-sm font-semibold">
              {currentTrack.title}
            </div>
            <div className="truncate text-xs text-text-secondary">
              {currentTrack.artists}
            </div>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
            Up next
          </div>
          <div className="truncate text-sm">
            {nextTrack ? nextTrack.title : "—"}
          </div>
          <div className="truncate text-xs text-text-secondary">
            {nextTrack ? nextTrack.artists : "End of the queue"}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              blending
                ? "bg-amber-400/20 text-amber-500"
                : "bg-black/[0.05] dark:bg-white/[0.09] text-text-secondary"
            }`}
          >
            {blending ? "Blending…" : "DJ mode"}
          </span>
          <button
            type="button"
            aria-label="Previous track"
            className={controlButtonClass}
            onClick={() => dispatch({ type: "SKIP_PREVIOUS" })}
          >
            <SkipPrevious size={22} weight="Bold" />
          </button>
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            className={controlButtonClass}
            onClick={() => dispatch({ type: "TOGGLE_PLAY_PAUSE" })}
          >
            {playing ? (
              <Pause size={22} weight="Bold" />
            ) : (
              <Play size={22} weight="Bold" />
            )}
          </button>
          <button
            type="button"
            aria-label="Next track"
            className={controlButtonClass}
            onClick={() => dispatch({ type: "SKIP_NEXT" })}
          >
            <SkipNext size={22} weight="Bold" />
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] tabular-nums text-text-secondary">
          {formatMs(positionMs)}
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.12]">
          <div
            className="h-full rounded-full bg-text-primary transition-[width] duration-300"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <span className="text-[11px] tabular-nums text-text-secondary">
          {formatMs(durationMs)}
        </span>
      </div>
    </div>
  );
}
