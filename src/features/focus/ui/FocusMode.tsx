import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  CloseLine,
  PauseFill,
  PlayFill,
  SkipPreviousFill,
  SkipForwardFill,
} from "@mingcute/react";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib";
import { PANEL_GLASS_CLASS } from "@/shared/ui/Panel";
import { CoverImage } from "@/features/covers";
import { playerEngine, useGlassBlur, usePlayerState } from "@/features/player";
import { djSession } from "@/features/mixer/engine/djSession";
import { preparedTrack } from "@/features/mixer/engine/trackSource";
import { useDjModeStore } from "@/features/mixer/store/djModeStore";
import {
  activityLinesForStage,
  type ActivitySnapshot,
} from "@/features/mixer/ui/stage/stageData";
import { useFocusModeStore } from "../store/focusModeStore";

// Focus mode (Interface Build 6) — the DESIGN-READ annex proposal
// implemented as written:
//
// "a deliberate, single-purpose listening state. Entered from Now
// Playing (or by shortcut), it reduces the app to the music: the
// current track's artwork and title, the transport, and — in a DJ
// session — the incoming track and the join's progress, stated
// plainly. All navigation, chrome, and panels are hidden; the
// workspace, sidebar, and header are gone, not minimised. One
// gesture (Esc, or the doorway in reverse) returns everything
// exactly as it was… its backdrop is the Now Playing atmosphere at
// its calmest, its typography is the system's, and it inherits
// reduced-motion and blur-off behaviour without exception."
//
// Readings chosen where the text leaves room (flagged in the build
// report): "the transport" is previous / play-pause / next — the
// annex names no scrubber, so the progress line and the times are
// stated, not operable; "the incoming track" is the queue's next
// track, the same provenance the DJ stage's standby panel uses;
// the join's progress is stated through the stage's own narration
// lines (activityLinesForStage), which carry the session's
// degradation honesty as well.

function formatClock(ms: number): string {
  if (!ms || ms < 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function artworkOf(track: { coverUrl?: string }): string {
  return track.coverUrl ?? "";
}

export function FocusMode() {
  const { t } = useTranslation();
  const active = useFocusModeStore((state) => state.active);
  const exit = useFocusModeStore((state) => state.exit);
  const player = usePlayerState();
  const glassBlur = useGlassBlur();
  const reduceMotion = useReducedMotion();
  const blending = useDjModeStore((state) => state.blending);

  const track = player.currentTrack;
  const queueNext =
    player.currentIndex >= 0
      ? (player.queue[player.currentIndex + 1] ?? null)
      : null;

  // The session's plain getters are not reactive; sample them on a
  // slow tick while Focus is up (the DJ stage's own cadence).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [active]);

  // "Returns everything exactly as it was" — if the music itself
  // goes away there is nothing left to focus on; leave the state.
  useEffect(() => {
    if (active && !track) exit();
  }, [active, track, exit]);

  const djRunning = djSession.isRunning;
  const djLines: string[] = [];
  if (active && djRunning && track) {
    const snapshot: ActivitySnapshot = {
      running: true,
      paused: djSession.isPaused,
      blending,
      degraded: djSession.degraded,
      plainCutCount: djSession.plainCutCount,
      currentTitle: track.title,
      nextTitle: queueNext?.title ?? null,
      nextPrepared: queueNext ? preparedTrack(queueNext.id) != null : false,
      openRequestCount: djSession.liveRaveOpenRequests.length,
      endReason: djSession.endReason,
    };
    for (const line of activityLinesForStage(
      snapshot,
      djSession.stageSnapshot()?.currentMove ?? null,
    )) {
      djLines.push(line.text);
    }
  }

  const playing = player.status === "playing";
  const progress =
    player.durationMs > 0
      ? Math.min(1, Math.max(0, player.positionMs / player.durationMs))
      : 0;

  return (
    <AnimatePresence>
      {active && track && (
        <motion.div
          key="focus-mode"
          data-testid="focus-mode"
          className="fixed inset-0 z-[90] overflow-hidden bg-bg-canvas"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{
            duration: reduceMotion ? 0.18 : 0.32,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          {/* The backdrop: the Now Playing atmosphere at its
              calmest — the current artwork, heavily softened and
              dimmed. Blur-off (the visual mode's "off" register)
              renders it unblurred and dimmer instead, so the
              surface still holds: reduced treatment is inherited,
              never an exception. */}
          {artworkOf(track) && (
            <div className="absolute inset-0" aria-hidden>
              <CoverImage
                src={artworkOf(track)}
                alt=""
                fill
                sizes="100vw"
                className={cn(
                  "h-full w-full object-cover",
                  glassBlur
                    ? "scale-110 blur-3xl opacity-45"
                    : "scale-105 opacity-25",
                )}
              />
              <div className="absolute inset-0 bg-bg-canvas/40" />
            </div>
          )}

          <div className="relative flex h-full flex-col items-center justify-center px-6">
            {artworkOf(track) ? (
              <CoverImage
                src={artworkOf(track)}
                alt={track.title}
                width={288}
                height={288}
                className="h-72 w-72 rounded-hero object-cover shadow-2xl"
              />
            ) : (
              <div className="h-72 w-72 rounded-hero bg-panel shadow-2xl" />
            )}

            <div className="mt-8 max-w-xl text-center">
              <div className="truncate text-2xl font-semibold text-text-primary">
                {track.title}
              </div>
              <div className="mt-1 truncate text-base text-text-secondary">
                {track.artists}
              </div>
            </div>

            {/* Stated progress: a line and two times, tabular. The
                annex names the transport, not a scrubber — this is
                read-only on purpose. */}
            <div className="mt-8 flex w-full max-w-md items-center gap-3">
              <span className="w-10 text-right text-xs text-text-secondary tabular-nums">
                {formatClock(player.positionMs)}
              </span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-fill">
                <div
                  className="h-full rounded-full bg-accent-primary"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <span className="w-10 text-xs text-text-secondary tabular-nums">
                {formatClock(player.durationMs)}
              </span>
            </div>

            <div className="mt-5 flex items-center gap-6">
              <button
                type="button"
                aria-label={t("player.previous") || "Previous"}
                onClick={() => playerEngine.skipPrevious()}
                className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-fill hover:text-text-primary active:scale-95 motion-reduce:transition-none"
              >
                <SkipPreviousFill size={26} />
              </button>
              <button
                type="button"
                aria-label={
                  playing
                    ? t("player.pause") || "Pause"
                    : t("player.play") || "Play"
                }
                onClick={() => playerEngine.togglePlayPause()}
                className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-btn-primary-bg text-btn-primary-text shadow-lg transition-transform hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100"
              >
                {playing ? <PauseFill size={28} /> : <PlayFill size={28} />}
              </button>
              <button
                type="button"
                aria-label={t("player.next") || "Next"}
                onClick={() => playerEngine.skipNext()}
                className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-fill hover:text-text-primary active:scale-95 motion-reduce:transition-none"
              >
                <SkipForwardFill size={26} />
              </button>
            </div>

            {/* In a DJ session: the incoming track and the join's
                progress, stated plainly — the stage's own words. */}
            {djRunning && (
              <div className="mt-8 max-w-md text-center">
                {queueNext && (
                  <div className="text-sm text-text-secondary">
                    <span className="font-medium text-text-primary">
                      {t("focus.coming_up") || "Coming up"}
                    </span>
                    {" — "}
                    {queueNext.title}
                    {queueNext.artists && ` · ${queueNext.artists}`}
                  </div>
                )}
                {djLines.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {djLines.map((line, i) => (
                      <div key={i} className="text-xs text-text-tertiary">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* The doorway in reverse: the exit sits where the door
              was (Now Playing's top-left), as a quiet glass pill —
              a floating control, inside the glass budget. */}
          <button
            type="button"
            onClick={exit}
            aria-label={t("focus.exit") || "Exit focus"}
            className={cn(
              PANEL_GLASS_CLASS,
              "absolute left-4 top-4 z-10 flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium text-text-secondary shadow-lg transition-colors hover:text-text-primary active:scale-95 motion-reduce:transition-none",
            )}
          >
            <CloseLine size={15} />
            {t("focus.exit") || "Exit focus"}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
