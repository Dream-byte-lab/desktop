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
 * - `romanization`: the pronunciation sub-line (source-provided or
 *   computed at model-build time). Off = no romanization sub-lines
 *   at all; translations are a different feature and never gated
 *   by it. Optional in the type because `buildLines` treats an
 *   absent flag as off; the default below pins it off.
 */
export interface LyricsDisplayOptions {
  align: LineAlign | null;
  highlight: boolean;
  textScale: number;
  romanization?: boolean;
}

export const DEFAULT_LYRICS_DISPLAY_OPTIONS: LyricsDisplayOptions = {
  align: null,
  highlight: true,
  textScale: 1,
  romanization: false,
};
