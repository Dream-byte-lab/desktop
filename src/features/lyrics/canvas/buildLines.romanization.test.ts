// Harvest Wave 4, Item 1 — the sub-line selection rule in
// buildLines (ruling D2: the romanization toggle gates BOTH the
// source-provided and the computed romanization; translations are
// never gated). The computed fill is the shared zero-dependency
// engine, letter-faithful (D1): 안녕하세요 -> "annyeonghaseyo".

import { describe, expect, it } from "vitest";
import type { Lyric } from "@braccato/parsers";
import { buildLines } from "./buildLines";

function line(partial: Partial<Lyric>): Lyric {
  return {
    startTimeMs: 0,
    durationMs: 3000,
    words: "",
    ...partial,
  } as Lyric;
}

function subtitleOf(
  lyric: Lyric,
  options?: { romanization?: boolean },
): string | null {
  return buildLines([lyric], options).lines[0]?.subtitle ?? null;
}

describe("buildLines romanization selection", () => {
  it("translation always wins and is never gated", () => {
    const lyric = line({
      words: "안녕하세요",
      translation: { text: "Hello", lang: "en" },
      romanization: "SOURCE-READING",
    });
    expect(subtitleOf(lyric)).toBe("Hello");
    expect(subtitleOf(lyric, { romanization: false })).toBe("Hello");
    expect(subtitleOf(lyric, { romanization: true })).toBe("Hello");
  });

  it("source-provided romanization shows only when the toggle is on", () => {
    const lyric = line({
      words: "안녕하세요",
      romanization: "SOURCE-READING",
    });
    expect(subtitleOf(lyric, { romanization: true })).toBe("SOURCE-READING");
    expect(subtitleOf(lyric, { romanization: false })).toBeNull();
    // Default (no options) is off.
    expect(subtitleOf(lyric)).toBeNull();
  });

  it("source romanization takes precedence over the computed fill", () => {
    const lyric = line({
      words: "안녕하세요",
      romanization: "SOURCE-READING",
    });
    // The computed fill would be "annyeonghaseyo"; the source wins.
    expect(subtitleOf(lyric, { romanization: true })).toBe("SOURCE-READING");
  });

  it("computed fill romanizes a Hangul line when on, nothing when off", () => {
    const lyric = line({ words: "안녕하세요" });
    expect(subtitleOf(lyric, { romanization: true })).toBe("annyeonghaseyo");
    expect(subtitleOf(lyric, { romanization: false })).toBeNull();
    expect(subtitleOf(lyric)).toBeNull();
  });

  it("kana-majority line converts its kana and keeps minority kanji", () => {
    const lyric = line({ words: "きのこ帝国" });
    expect(subtitleOf(lyric, { romanization: true })).toBe("kinoko帝国");
  });

  it("kanji-majority line gets no sub-line (the composition rule refuses)", () => {
    const lyric = line({ words: "漢字かな" });
    expect(subtitleOf(lyric, { romanization: true })).toBeNull();
  });

  it("Latin and instrumental lines are unchanged either way", () => {
    const latin = line({ words: "Hello world, here we go" });
    expect(subtitleOf(latin, { romanization: true })).toBeNull();
    expect(subtitleOf(latin, { romanization: false })).toBeNull();

    const instrumental = line({ words: "", isInstrumental: true });
    expect(subtitleOf(instrumental, { romanization: true })).toBeNull();
    expect(subtitleOf(instrumental, { romanization: false })).toBeNull();
  });

  it("word-timed lines get the same plain-text sub-line (no per-word timing)", () => {
    const words = ["안녕", "하세요 "];
    const lyric = line({
      words: words.join(""),
      parts: words.map((word, i) => ({
        startTimeMs: i * 1000,
        durationMs: 1000,
        words: word,
      })),
    });
    const model = buildLines([lyric], { romanization: true });
    expect(model.lines[0]?.subtitle).toBe("annyeonghaseyo");
    // The sub-line is a single string on the model; tokens are the
    // line's own words, untouched by the fill.
    expect(model.lines[0]?.tokens.length).toBeGreaterThan(0);
  });
});
