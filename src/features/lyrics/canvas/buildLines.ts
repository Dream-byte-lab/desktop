import type { Lyric } from "@braccato/parsers";
import { romanize } from "@/shared/text";
import { lineSyncedParts, tokenize } from "./tokens";
import type { LineAlign, LyricLineModel, LyricsModel } from "./types";

const RICHSYNC_SHIFT_MS = 150;
const LINE_SYNC_SHIFT_MS = 115;
const RTL =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}\p{Script=Mandaic}\p{Script=Hanifi_Rohingya}\p{Script=Samaritan}\p{Script=Yezidi}\p{Script=Mende_Kikakui}\p{Script=Old_Hungarian}]/u;
const LTR =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function alignFor(agent: string | undefined): LineAlign {
  if (agent === "v2" || agent === "v3") return "end";
  if (agent === "v1000") return "center";
  return "start";
}

function isRtl(text: string): boolean {
  for (const char of text) {
    if (RTL.test(char)) return true;
    if (LTR.test(char)) return false;
  }
  return false;
}

function hasTimedParts(lyrics: Lyric[]): boolean {
  return lyrics.some(
    (line) =>
      !line.isInstrumental &&
      line.parts?.some((part) => part.durationMs !== 0) === true,
  );
}

/**
 * The sub-line under a lyric line — the one place the two
 * romanization sources meet. Selection (Harvest Wave 4, Item 1;
 * ruling D2):
 *
 * - A translation, when present, always wins and is NEVER gated:
 *   it carries meaning, not pronunciation.
 * - Otherwise, with romanization ON: the source-provided
 *   romanization if the lyrics carry one, else the computed fill
 *   from the shared zero-dependency engine (`romanize` is
 *   letter-faithful; its composition rule refuses lines it cannot
 *   honestly carry, e.g. kanji-majority lines, and returns null).
 * - With romanization OFF: no sub-line from either romanization
 *   source — the toggle is the single truth for what it names.
 */
function subtitleOf(line: Lyric, romanizationOn: boolean): string | null {
  const translation = line.translation?.text;
  if (translation && translation.trim()) return translation.trim();
  if (!romanizationOn) return null;
  const text = line.romanization ?? romanize(line.words ?? "") ?? null;
  return text && text.trim() ? text.trim() : null;
}

export function buildLines(
  lyrics: Lyric[],
  options?: { romanization?: boolean },
): LyricsModel {
  const romanizationOn = options?.romanization ?? false;
  const lines = lyrics.map((line, index): LyricLineModel => {
    const words = line.words ?? "";
    const parts =
      line.parts && line.parts.length > 0
        ? line.parts
        : lineSyncedParts(words, line.startTimeMs);
    return {
      startMs: line.startTimeMs,
      durationMs: line.durationMs,
      endMs: line.startTimeMs + line.durationMs,
      nextStartMs: lyrics[index + 1]?.startTimeMs ?? Number.POSITIVE_INFINITY,
      align: alignFor(line.agent),
      rtl: isRtl(words),
      instrumental: Boolean(line.isInstrumental),
      tokens: line.isInstrumental ? [] : tokenize(parts),
      subtitle: subtitleOf(line, romanizationOn),
    };
  });
  return {
    lines,
    shiftMs: hasTimedParts(lyrics) ? RICHSYNC_SHIFT_MS : LINE_SYNC_SHIFT_MS,
  };
}
