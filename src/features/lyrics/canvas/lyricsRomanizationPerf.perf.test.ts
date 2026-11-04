// Perf gate harness (Harvest Wave 4, Item 1) — model-build cost of
// the romanization fill over a 260-line Korean track.
//
// MEASUREMENT ONLY, same discipline as lyricsPerf.perf.test.ts:
// the numbers are logged with a [perf] prefix and there are NO
// wall-clock pass/fail thresholds, so CI cannot flake on them.
// The kill criterion from the Wave 4 plan — model-build cost with
// fills on must not regress >2x the recorded ~10.4 ms / 260-line
// baseline (Wave 3 harness, Latin fixture) — is judged from these
// logged numbers in the build report, alongside the same-run
// romanization-OFF median, which is the machine-relative control.
//
// jsdom measures main-thread cost only; the canvas 2D context is a
// counting fake, so layout cost here is measure/wrap work, not
// rasterisation.

import { describe, expect, it } from "vitest";
import type { Lyric } from "@braccato/parsers";
import { buildLines } from "./buildLines";
import { layoutLines } from "./layoutLines";
import { createTextMeasure } from "./textMeasure";
import { LYRICS_TYPOGRAPHY } from "./fonts";

// ------------------------------------------------- counting 2D ctx

function makeFakeCtx() {
  const gradient = { addColorStop: () => undefined };
  const base: Record<string, unknown> = {
    canvas: null,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
    shadowBlur: 0,
    shadowColor: "",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    lineWidth: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    measureText: (text: string) => ({
      width: text.length * 9,
      fontBoundingBoxAscent: 24,
      fontBoundingBoxDescent: 8,
      actualBoundingBoxAscent: 24,
      actualBoundingBoxDescent: 8,
    }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  };
  const proxy = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
  return proxy as unknown as CanvasRenderingContext2D;
}

// ------------------------------------------------------------ fixture

const SYLLABLES = [
  "사",
  "랑",
  "해",
  "너",
  "를",
  "정",
  "말",
  "로",
  "밤",
  "하",
  "늘",
  "별",
  "빛",
  "우",
  "리",
  "함",
  "께",
];

/** 260 word-timed Korean lines; wording varies by line (chorus repeats included). */
function makeKoreanLyrics(count: number, lineMs = 2300): Lyric[] {
  return Array.from({ length: count }, (_, i) => {
    const start = i * lineMs;
    const wordMs = Math.floor(lineMs / 6);
    const parts = Array.from({ length: 6 }, (_, w) => {
      const a = SYLLABLES[(i * 3 + w * 5) % SYLLABLES.length] ?? "사";
      const b = SYLLABLES[(i + w * 7 + 2) % SYLLABLES.length] ?? "랑";
      return {
        startTimeMs: start + w * wordMs,
        durationMs: wordMs,
        words: `${a}${b} `,
      };
    });
    return {
      startTimeMs: start,
      durationMs: lineMs,
      words: parts.map((p) => p.words).join(""),
      parts,
    } as Lyric;
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measureBuild(lyrics: Lyric[], romanization: boolean): number[] {
  const ctx = makeFakeCtx();
  const costs: number[] = [];
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    const model = buildLines(lyrics, { romanization });
    const measure = createTextMeasure(ctx);
    const layouts = layoutLines(model.lines, measure, LYRICS_TYPOGRAPHY, {
      left: 32,
      width: 736,
      top: 32,
    });
    costs.push(performance.now() - start);
    expect(layouts.length).toBe(260);
  }
  return costs;
}

describe("romanization model-build cost (260-line Korean track)", () => {
  it("builds with fills on and off; logs both medians for the gate", () => {
    const lyrics = makeKoreanLyrics(260);

    const off = measureBuild(lyrics, false);
    const on = measureBuild(lyrics, true);
    const offMedian = median(off);
    const onMedian = median(on);
    console.log(
      `[perf] buildLines+layoutLines 260 Korean lines, romanization OFF: ` +
        `median=${offMedian.toFixed(3)}ms runs=${off.map((v) => v.toFixed(2)).join("/")}`,
    );
    console.log(
      `[perf] buildLines+layoutLines 260 Korean lines, romanization ON: ` +
        `median=${onMedian.toFixed(3)}ms runs=${on.map((v) => v.toFixed(2)).join("/")}`,
    );
    console.log(
      `[perf] romanization build ratio on/off = ${(onMedian / Math.max(offMedian, 0.001)).toFixed(2)}x ` +
        `(kill criterion: >2x the recorded 10.4ms Wave 3 baseline, judged in the report)`,
    );

    // Behavioural invariants: off = no sub-lines anywhere; on =
    // every line carries its computed fill.
    const offModel = buildLines(lyrics, { romanization: false });
    expect(offModel.lines.every((l) => l.subtitle === null)).toBe(true);
    const onModel = buildLines(lyrics, { romanization: true });
    expect(onModel.lines.every((l) => l.subtitle !== null)).toBe(true);
  });
});
