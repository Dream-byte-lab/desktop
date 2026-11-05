export type OverlayPosition = "top-left" | "top-center" | "top-right";

/** Window size of the overlay in device-independent pixels. */
export interface OverlaySize {
  width: number;
  height: number;
}

export interface OverlaySettings {
  enabled: boolean;
  position: OverlayPosition;
  shortcut: string;
  autoShowOnMinimize: boolean;
  alwaysOnTop: boolean;
  size: OverlaySize;
}

export interface OverlayTrackInfo {
  id?: string;
  title: string;
  artist: string;
  album?: string;
  cover?: string | null;
  coverUrl?: string;
  durationMs?: number;
}

/** Mirrors the player store's RepeatMode (the overlay bundle cannot
 *  import the player tree; keep the values in step). */
export type OverlayRepeatMode = "off" | "all" | "one";

export interface OverlayStatePayload {
  status: "playing" | "paused" | "loading" | "buffering" | "idle" | "error";
  track: OverlayTrackInfo | null;
  positionMs: number;
  positionAt?: number;
  playbackRate?: number;
  durationMs: number;
  volume: number;
  isLiked: boolean;
  /** The player store's real shuffle switch (mirrors the main player). */
  shuffle: boolean;
  /** The player store's real repeat mode. */
  repeat: OverlayRepeatMode;
  /**
   * Honest playback-context label for the card's eyebrow — the source
   * the main window knows the queue came from ("Playing from album",
   * a playlist's own title, track radio), or null when no source is
   * known, in which case the card shows a neutral "Now playing".
   */
  contextLabel: string | null;
}

export interface OverlayAction {
  type:
    | "togglePlay"
    | "play"
    | "pause"
    | "next"
    | "prev"
    | "seek"
    | "seekBy"
    | "toggleMute"
    | "like"
    | "toggleShuffle"
    | "cycleRepeat"
    | "volumeUp"
    | "volumeDown"
    | "setVolume"
    | "focusMainWindow"
    | "closeOverlay"
    // Interactive corner-grip resize: "resizeOverlay" streams live sizes
    // (electron applies the bounds, nothing is persisted), and
    // "resizeOverlayCommit" ends a drag (electron persists the size and
    // forwards a "sizeChanged" notice to the main window, which mirrors
    // it into the settings store). Payload: { width: number; height: number }.
    | "resizeOverlay"
    | "resizeOverlayCommit"
    | "sizeChanged";
  payload?: any;
}
