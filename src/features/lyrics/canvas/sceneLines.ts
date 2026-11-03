import { drawInstrumental } from "./drawInstrumental";
import { drawLine } from "./drawLine";
import type { EdgeFog } from "./edgeFog";
import { BITMAP_PAD, type LineBitmaps } from "./lineBitmaps";
import type { LyricsScene } from "./lyricsScene";
import type { ScrollMotion } from "./scrollMotion";
import { isLineAnimating, lineExitMs } from "./timing";
import type { LineLayout } from "./types";

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
    );
  };
}

function litState(layout: LineLayout, timeMs: number): string {
  if (timeMs >= lineExitMs(layout.line)) return "done";
  return String(
    layout.tokens.filter((placed) => placed.token.startMs <= timeMs).length,
  );
}

export function visibleLines(frame: SceneFrame): VisibleLine[] {
  const { scene, motion, now, timeMs, dpr } = frame;
  const highlight = scene.display.highlight;
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
    // emphasis).
    const live =
      isLineAnimating(layout.line, timeMs, now) &&
      (highlight || layout.line.instrumental);
    const moving = offset !== 0 || motion.isWheelMoving();
    lines.push({
      index,
      layout,
      top: moving ? exact : Math.round(exact * dpr) / dpr,
      key: live
        ? `live:${now}`
        : `still:${scene.version}:${highlight ? litState(layout, timeMs) : "even"}`,
      live,
      fading: live && timeMs >= lineExitMs(layout.line),
      moving,
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
