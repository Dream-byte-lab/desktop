import { drawToken, white } from "./drawWord";
import { backgroundFont, mainFont, subtitleFont } from "./fonts";
import { tokenHighlight } from "./timing";
import type { LineLayout, LyricsTypography } from "./types";

const INACTIVE_ALPHA = 0.3;
const BACKGROUND_RATIO = 0.78;
/** The even register (Highlight lyrics off): one mid-level tint for
 * every line — brighter than the dimmed context lines, short of the
 * active line's full white. */
const EVEN_ALPHA = 0.62;
const SUBTITLE_ALPHA = 0.6;
const REM_PX = 16;

export function drawLine(
  ctx: CanvasRenderingContext2D,
  layout: LineLayout,
  top: number,
  timeMs: number,
  type: LyricsTypography,
  dpr: number,
  now: number,
  highlight: boolean,
) {
  const { line } = layout;
  ctx.direction = line.rtl ? "rtl" : "ltr";
  const sungBase = highlight ? INACTIVE_ALPHA : EVEN_ALPHA;
  let current = "";
  for (const placed of layout.tokens) {
    const background = placed.token.background;
    const font = background ? backgroundFont(type) : mainFont(type);
    if (font !== current) {
      current = font;
      ctx.font = font;
    }
    drawToken(
      {
        ctx,
        top,
        rtl: line.rtl,
        base: background ? sungBase * BACKGROUND_RATIO : sungBase,
        remPx: REM_PX,
        dpr,
      },
      placed,
      highlight ? tokenHighlight(placed.token, line, timeMs, now) : null,
    );
  }
  if (layout.subtitle.length === 0) return;
  ctx.font = subtitleFont(type);
  ctx.fillStyle = white(SUBTITLE_ALPHA);
  for (const text of layout.subtitle) {
    ctx.fillText(
      text.text,
      text.x,
      Math.round((top + text.baseline) * dpr) / dpr,
    );
  }
}
