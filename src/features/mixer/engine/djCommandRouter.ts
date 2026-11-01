import type { PlayerCommand } from "../../player/store/playerStore";

// Transport arbitration. Every control in the app — the player bar,
// the fullscreen view, keyboard shortcuts — talks to the player through
// one command channel. While a DJ session is running, that channel is
// offered each command first:
//
// - transport commands (pause, resume, toggle, next, previous, seek)
//   go to the session, which owns the sound; the normal player never
//   sees them, so the two can never play over each other;
// - choosing a track to play ends the session first, then the command
//   falls through to the normal player untouched — picking a song by
//   hand is the user taking the decks back;
// - everything else (volume, speed display, settings) falls through:
//   the session already follows the store's volume on its own.

export interface DjTransport {
  readonly isRunning: boolean;
  readonly isPaused: boolean;
  pause(): void;
  resume(): void;
  skipNext(): void;
  skipPrevious(): void;
  seekTo(positionMs: number): void;
  stop(): void;
}

/** Returns true when the session handled the command. */
export function routeDjCommand(
  command: PlayerCommand,
  dj: DjTransport,
): boolean {
  if (!dj.isRunning) return false;

  switch (command.type) {
    case "PAUSE_REQUESTED":
      dj.pause();
      return true;
    case "RESUME_REQUESTED":
      dj.resume();
      return true;
    case "TOGGLE_PLAY_PAUSE":
      if (dj.isPaused) {
        dj.resume();
      } else {
        dj.pause();
      }
      return true;
    case "SKIP_NEXT":
      dj.skipNext();
      return true;
    case "SKIP_PREVIOUS":
      dj.skipPrevious();
      return true;
    case "SEEK_COMMITTED":
      dj.seekTo(command.positionMs);
      return true;
    case "PLAY_REQUESTED":
      dj.stop();
      return false;
    default:
      return false;
  }
}
