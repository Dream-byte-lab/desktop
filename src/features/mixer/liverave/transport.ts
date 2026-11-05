// transport.ts — fresh transport arbitration (design §3.8).
//
// The plain player's command channel offers every command here
// FIRST while a DJ session runs. The partition, re-derived from the
// product behaviour (the deletion map's DjTransport contract,
// §2.1/§7.8 — the interface below reproduces it exactly):
//
// - Transport commands (pause / resume / toggle / next / previous /
//   seek) belong to the session while it runs: they are performed
//   on the transport and the command is HANDLED (returns true) —
//   the plain player never sees it.
// - A command that CHOOSES a track to play (PLAY_REQUESTED) is the
//   user taking the decks back: the session is stopped
//   (transport.stop()) and the command FALLS THROUGH (returns
//   false) so plain playback plays the pick.
// - Everything else (volume, rate, pitch, reverb, …) is not the
//   session's business: it falls through untouched, running or not.
// - No transport, or a transport that is not running: nothing is
//   offered, nothing is stopped, everything falls through.

import type { PlayerCommand } from "@/features/player/store/playerStore";

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

/**
 * Offers `command` to a running DJ session's transport.
 * Returns true when the session handled the command (the caller
 * must NOT also apply it to plain playback), false when the
 * command falls through to the plain player unchanged.
 */
export function routeDjCommand(
  command: PlayerCommand,
  transport: DjTransport | null,
): boolean {
  if (!transport || !transport.isRunning) return false;
  if (!command || typeof command.type !== "string") return false;

  switch (command.type) {
    case "PAUSE_REQUESTED":
      transport.pause();
      return true;
    case "RESUME_REQUESTED":
      transport.resume();
      return true;
    case "TOGGLE_PLAY_PAUSE":
      if (transport.isPaused) transport.resume();
      else transport.pause();
      return true;
    case "SKIP_NEXT":
      transport.skipNext();
      return true;
    case "SKIP_PREVIOUS":
      transport.skipPrevious();
      return true;
    case "SEEK_COMMITTED":
      transport.seekTo(command.positionMs);
      return true;
    case "PLAY_REQUESTED":
      // Choosing a track ends the session; the pick itself is
      // plain playback's to perform.
      transport.stop();
      return false;
    default:
      return false;
  }
}
