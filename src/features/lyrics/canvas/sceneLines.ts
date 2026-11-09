import { drawInstrumental } from "./drawInstrumental";
import { drawLine } from "./drawLine";
import type { EdgeFog } from "./edgeFog";
import { BITMAP_PAD, type LineBitmaps } from "./lineBitmaps";
import type { LyricsScene } from "./lyricsScene";
import type { ScrollMotion } from "./scrollMotion";
import { isLineAnimating, lineExitMs } from "./timing";
import type { LineLayout, LyricLineModel } from "./types";

export interface SceneFrame {
  ctx: CanvasRenderingContext2D;
  scene: LyricsScene;
  motion: ScrollMotion;
  fog: EdgeFog;
  bitmaps: LineBitmaps;
  dpr: number;
  now: number;
  timeMs: number;
}

export interface VisibleLine {
  index: number;
  layout: LineLayout;
  top: number;
  key: string;
  live: boolean;
  fading: boolean;
  moving: boolean;
  /** Composite-time brightness for context lines (reference 28):
   * 1 at the sung line and its neighbours, falling with distance.
   * Always 1 while highlighting is off — that register is even. */
  dim: number;
}

/**
 * Reference 28's register: the lines around the one being sung fall
 * away in brightness with their distance from it, instead of every
 * context line sitting at one flat level. The falloff is applied
 * when the still bitmaps are composited (see drawScene), so the
 * alphas painted into the bitmaps — and therefore their cache keys —
 * do not move; only the composite multiplier changes as the sung
 * line advances.
 */
const DIM_PER_STEP = 0.065;
const DIM_FLOOR = 0.6;

/** Brightness multiplier for a line `distance` lines from the sung one. */
export function contextDim(distance: number): number {
  if (distance <= 1) return 1;
  return Math.max(DIM_FLOOR, 1 - DIM_PER_STEP * (distance - 1));
}

/**
 * The line being sung at `timeMs`: the last line that has started,
 * or the first line before anything has started (the intro, where
 * the opening line is the anchor the column gathers around).
 */
export function activeLineIndex(
  lines: readonly LyricLineModel[],
  timeMs: number,
): number {
  let anchor = 0;
  lines.forEach((line, index) => {
    if (line.startMs <= timeMs) anchor = index;
  });
  return anchor;
}

export function paintLine(frame: SceneFrame, layout: LineLayout) {
  const { scene, timeMs, dpr, now } = frame;
  return (ctx: CanvasRenderingContext2D, top: number) => {
    if (layout.line.instrumental) {
      drawInstrumental(
        ctx,
        layout,
        top,
        timeMs,
        scene.typography,
        scene.frame,
        dpr,
        now,
      );
      return;
    }
    drawLine(
      ctx,
      layout,
      top,
      timeMs,
      scene.typography,
      dpr,
      now,
      scene.display.highlight,
      scene.timed,
    );
  };
}

function litState(layout: LineLayout, timeMs: number, timed: boolean) {
  if (!timed) return "static";
  if (timeMs >= lineExitMs(layout.line)) return "done";
  return String(
    layout.tokens.filter((placed) => placed.token.startMs <= timeMs).length,
  );
}

export function visibleLines(frame: SceneFrame): VisibleLine[] {
  const { scene, motion, now, timeMs, dpr } = frame;
  const highlight = scene.display.highlight;
  const anchor = highlight ? activeLineIndex(scene.lines, timeMs) : 0;
  const lines: VisibleLine[] = [];
  scene.layouts.forEach((layout, index) => {
    const offset = motion.offsetFor(index, now);
    const exact = layout.top - motion.position + offset;
    const bottom = exact + layout.height + BITMAP_PAD;
    if (bottom < 0 || exact - BITMAP_PAD > scene.height) return;
    // With highlighting off a sung line's appearance never changes
    // over time, so it is never "live": its bitmap stays stable and
    // the frame loop drops to its poll demand. Instrumental breaks
    // keep animating (their dots are a progress display, not lyric
    // emphasis). Untimed lines are never live either: with no timing
    // there is nothing to animate.
    const live =
      scene.timed &&
      isLineAnimating(layout.line, timeMs, now) &&
      (highlight || layout.line.instrumental);
    const moving = offset !== 0 || motion.isWheelMoving();
    lines.push({
      index,
      layout,
      top: moving ? exact : Math.round(exact * dpr) / dpr,
      key: live
        ? `live:${now}`
        : `still:${scene.version}:${highlight ? litState(layout, timeMs, scene.timed) : "even"}`,
      live,
      fading: live && timeMs >= lineExitMs(layout.line),
      moving,
      dim: highlight ? contextDim(Math.abs(index - anchor)) : 1,
    });
  });
  return lines;
}

export function lineBitmap(frame: SceneFrame, line: VisibleLine) {
  return frame.bitmaps.get(
    line.index,
    line.key,
    frame.scene.width,
    line.layout.height,
    frame.dpr,
    paintLine(frame, line.layout),
  );
}
