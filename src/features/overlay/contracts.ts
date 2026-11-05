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

export interface OverlayStatePayload {
  status: "playing" | "paused" | "loading" | "buffering" | "idle" | "error";
  track: OverlayTrackInfo | null;
  positionMs: number;
  positionAt?: number;
  playbackRate?: number;
  durationMs: number;
  volume: number;
  isLiked: boolean;
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
