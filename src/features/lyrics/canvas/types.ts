export type LineAlign = "start" | "end" | "center";

export interface LyricToken {
  text: string;
  startMs: number;
  durationMs: number;
  background: boolean;
  space: boolean;
}

export interface LyricLineModel {
  startMs: number;
  durationMs: number;
  endMs: number;
  nextStartMs: number;
  align: LineAlign;
  rtl: boolean;
  instrumental: boolean;
  tokens: LyricToken[];
  subtitle: string | null;
}

export interface LyricsModel {
  lines: LyricLineModel[];
  shiftMs: number;
}

export interface PlacedToken {
  token: LyricToken;
  x: number;
  baseline: number;
  width: number;
}

export interface PlacedText {
  text: string;
  x: number;
  baseline: number;
}

export interface LineLayout {
  line: LyricLineModel;
  top: number;
  height: number;
  tokens: PlacedToken[];
  subtitle: PlacedText[];
}

export interface LyricsTypography {
  family: string;
  size: number;
  weight: number;
  lineHeight: number;
  paddingY: number;
  paddingX: number;
}

/**
 * Presentation-only display options for the lyrics canvas (reference
 * 27's accessibility controls). These steer layout and paint — never
 * timing: the sync engine neither reads nor depends on them.
 *
 * - `align`: the user's Text Align choice. `null` keeps each line's
 *   own source alignment (the renderer's historical behaviour, and
 *   its default outside the app wiring).
 * - `highlight`: the active line's karaoke emphasis. Off = every
 *   line painted in one even register.
 * - `textScale`: multiplier over the base typography (Bigger text).
 */
export interface LyricsDisplayOptions {
  align: LineAlign | null;
  highlight: boolean;
  textScale: number;
}

export const DEFAULT_LYRICS_DISPLAY_OPTIONS: LyricsDisplayOptions = {
  align: null,
  highlight: true,
  textScale: 1,
};
