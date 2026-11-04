import type { LyricsClock } from "@/features/lyrics";
import { djSession } from "@/features/mixer/engine/djSession";
import { usePlayerStore } from "../store/playerStore";

const MAX_CARRY_MS = 100;

// A live DJ session publishes its musical position into the player
// store on its own 250 ms tick (djSession's TICK_MS). Between ticks
// the session branch below carries from the last store write at
// rate 1, capped at one tick, so the rendered position stays smooth
// without ever running ahead of the session.
const SESSION_TICK_MS = 250;

interface ClockAnchor {
  mediaMs: number;
  frameMs: number;
  rate: number;
}

export function audioElement(): HTMLAudioElement | null {
  return document.getElementById("liner-audio") as HTMLAudioElement | null;
}

function isRunning(audio: HTMLAudioElement): boolean {
  return !audio.paused && !audio.ended && audio.readyState > 2;
}

export function createMediaClock(): LyricsClock {
  let anchor: ClockAnchor | null = null;
  let sessionAnchor: ClockAnchor | null = null;
  return {
    timeMs: () => {
      // While a DJ session is live, the decks are Web Audio buffer
      // sources and #liner-audio sits paused at whatever position
      // plain playback last left it — reading the element would
      // freeze the lyrics at that stale position for the whole set
      // (Note 28). The session's own clock is the player-store
      // position it publishes every tick, so read that instead.
      // Liveness is the mixer's own predicate, the same one the
      // player engine arbitrates against (djSession.isRunning).
      if (djSession.isRunning) {
        anchor = null;
        const { positionMs, status } = usePlayerStore.getState();
        const frameMs = performance.now();
        if (
          status !== "playing" ||
          !sessionAnchor ||
          sessionAnchor.mediaMs !== positionMs
        ) {
          sessionAnchor = { mediaMs: positionMs, frameMs, rate: 1 };
          return positionMs;
        }
        const carried = Math.min(
          Math.max(frameMs - sessionAnchor.frameMs, 0),
          SESSION_TICK_MS,
        );
        return sessionAnchor.mediaMs + carried * sessionAnchor.rate;
      }
      sessionAnchor = null;
      const audio = audioElement();
      if (!audio || Number.isNaN(audio.currentTime)) {
        anchor = null;
        return usePlayerStore.getState().positionMs;
      }
      const mediaMs = audio.currentTime * 1000;
      const frameMs = performance.now();
      if (!isRunning(audio) || !anchor || anchor.mediaMs !== mediaMs) {
        anchor = { mediaMs, frameMs, rate: audio.playbackRate };
        return mediaMs;
      }
      const carried = Math.min(
        Math.max(frameMs - anchor.frameMs, 0),
        MAX_CARRY_MS,
      );
      return anchor.mediaMs + carried * anchor.rate;
    },
    playing: () => {
      if (djSession.isRunning) {
        return usePlayerStore.getState().status === "playing";
      }
      const audio = audioElement();
      return Boolean(audio && !audio.paused);
    },
  };
}
