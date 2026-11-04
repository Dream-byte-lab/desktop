import type { Lyric } from "@braccato/parsers";
import { buildLines } from "./buildLines";
import { LYRICS_TYPOGRAPHY, loadLyricsFonts, resolveFamily } from "./fonts";
import { layoutLines, type LayoutFrame } from "./layoutLines";
import { createTextMeasure, type TextMeasure } from "./textMeasure";
import { maxScrollFor } from "./scrollPlan";
import {
  DEFAULT_LYRICS_DISPLAY_OPTIONS,
  type LineLayout,
  type LyricsDisplayOptions,
  type LyricLineModel,
  type LyricsTypography,
} from "./types";

const SIDE_INSET = 24;
const TOP_INSET = 32;

export class LyricsScene {
  lines: LyricLineModel[] = [];
  shiftMs = 0;
  layouts: LineLayout[] = [];
  width = 0;
  height = 0;
  typography: LyricsTypography = LYRICS_TYPOGRAPHY;
  measure: TextMeasure;
  version = 0;
  /** Presentation options (reference 27 controls); see types.ts. */
  display: LyricsDisplayOptions = { ...DEFAULT_LYRICS_DISPLAY_OPTIONS };
  private lyricsText = "";
  /**
   * The last source lyrics passed to `setLyrics`, retained so a
   * romanization flip can rebuild the line model with the new flag
   * at change time (never per frame).
   */
  private sourceLyrics: Lyric[] = [];

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    host: Element,
    private readonly onFontsReady: () => void,
  ) {
    this.typography = {
      ...LYRICS_TYPOGRAPHY,
      family: resolveFamily(host),
    };
    this.measure = createTextMeasure(ctx);
    document.fonts?.addEventListener("loadingdone", this.remeasure);
    void loadLyricsFonts(this.typography).then(this.remeasure);
  }

  /**
   * Applies the user's display options. A text-scale change rebuilds
   * the typography and remeasures (the measure cache is keyed by font
   * string, and the bigger face must be loaded before it is painted);
   * alignment/highlight changes only relayout. Unchanged options are
   * a no-op so callers may push state freely.
   */
  setDisplayOptions(next: Partial<LyricsDisplayOptions>) {
    const merged = { ...this.display, ...next };
    const romanizationChanged =
      Boolean(merged.romanization) !== Boolean(this.display.romanization);
    if (
      merged.align === this.display.align &&
      merged.highlight === this.display.highlight &&
      merged.textScale === this.display.textScale &&
      !romanizationChanged
    ) {
      return;
    }
    const scaleChanged = merged.textScale !== this.display.textScale;
    this.display = merged;
    if (romanizationChanged) this.rebuildModel();
    if (!scaleChanged) {
      this.relayout();
      this.onFontsReady();
      return;
    }
    const scale = merged.textScale;
    this.typography = {
      ...this.typography,
      size: Math.round(LYRICS_TYPOGRAPHY.size * scale),
      lineHeight: LYRICS_TYPOGRAPHY.lineHeight * scale,
      paddingY: LYRICS_TYPOGRAPHY.paddingY * scale,
    };
    void loadLyricsFonts(this.typography, this.lyricsText || undefined).then(
      this.remeasure,
    );
    this.remeasure();
  }

  private readonly remeasure = () => {
    this.measure = createTextMeasure(this.ctx);
    this.relayout();
    this.onFontsReady();
  };

  dispose() {
    document.fonts?.removeEventListener("loadingdone", this.remeasure);
  }

  get frame(): LayoutFrame {
    const left = SIDE_INSET + this.typography.paddingX;
    return { left, width: Math.max(1, this.width - left * 2), top: TOP_INSET };
  }

  setLyrics(lyrics: Lyric[]) {
    this.sourceLyrics = lyrics;
    this.rebuildModel();
    this.relayout();
    this.lyricsText = lyrics.map((line) => line.words ?? "").join("\n");
    void loadLyricsFonts(this.typography, this.lyricsText);
  }

  /** Rebuilds the line model from the retained source lyrics. */
  private rebuildModel() {
    const model = buildLines(this.sourceLyrics, {
      romanization: Boolean(this.display.romanization),
    });
    this.lines = model.lines;
    this.shiftMs = model.shiftMs;
  }

  setSize(width: number, height: number) {
    const widthChanged = width !== this.width;
    this.width = width;
    this.height = height;
    if (widthChanged) this.relayout();
  }

  relayout() {
    this.version += 1;
    if (this.width <= 0) {
      this.layouts = [];
      return;
    }
    // The user's Text Align choice replaces every line's source
    // alignment; with no choice (null) lines keep their own.
    const align = this.display.align;
    const lines = align
      ? this.lines.map((line) =>
          line.align === align ? line : { ...line, align },
        )
      : this.lines;
    this.layouts = layoutLines(
      lines,
      this.measure,
      this.typography,
      this.frame,
    );
  }

  maxScroll(): number {
    return maxScrollFor(this.layouts, this.height);
  }

  lineAt(y: number, scroll: number): number | null {
    const contentY = y + scroll;
    const index = this.layouts.findIndex(
      (layout) =>
        contentY >= layout.top && contentY < layout.top + layout.height,
    );
    return index >= 0 ? index : null;
  }
}
