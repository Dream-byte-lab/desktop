import { beforeEach, describe, expect, it } from "vitest";
import { clearRomanizeCache, romanize, romanizeCacheSize } from "./romanize";

beforeEach(() => {
  clearRomanizeCache();
});

describe("romanize — Cyrillic", () => {
  it("romanizes Russian names", () => {
    expect(romanize("Привет")).toBe("Privet");
    expect(romanize("Москва")).toBe("Moskva");
    expect(romanize("Пошлая Молли")).toBe("Poshlaya Molli");
  });

  it("keeps е and э distinct and reads soft signs the ALA-LC way", () => {
    expect(romanize("Юрий")).toBe("Yuriy");
    expect(romanize("Дарья")).toBe("Darʹya");
    expect(romanize("Объявление")).toBe("Obʺyavlenie");
  });

  it("covers Ukrainian, Serbian and Macedonian letters from the same table", () => {
    // One unified table, no language detection: Ukrainian и takes the
    // table's i, so Київ reads Kiyiv (documented trade-off).
    expect(romanize("Київ")).toBe("Kiyiv");
    expect(romanize("Београд")).toBe("Beograd");
    expect(romanize("Џеп")).toBe("Dzhep");
  });

  it("preserves punctuation, spaces and digits", () => {
    expect(romanize("Привет, мир!")).toBe("Privet, mir!");
    expect(romanize("Группа 5")).toBe("Gruppa 5");
  });
});

describe("romanize — Greek", () => {
  it("romanizes monotonic Greek", () => {
    expect(romanize("Αθήνα")).toBe("Athēna");
    expect(romanize("Νίκος")).toBe("Nikos");
    expect(romanize("Θεσσαλονίκη")).toBe("Thessalonikē");
  });

  it("reads polytonic letters through their base letter", () => {
    expect(romanize("Ἀριστοτέλης")).toBe("Aristotelēs");
  });
});

describe("romanize — Hebrew", () => {
  it("transliterates consonants only, inventing no vowels", () => {
    expect(romanize("שלום")).toBe("shlvm");
    expect(romanize("דוד")).toBe("dvd");
    // ש is always sh in this table (sin/shin are indistinguishable unpointed)
    expect(romanize("ישראל")).toBe("yshrʾl");
  });

  it("strips niqqud instead of reading it", () => {
    expect(romanize("שָׁלוֹם")).toBe("shlvm");
  });

  it("maps final forms to the same value as regular forms", () => {
    expect(romanize("מלך")).toBe("mlk");
  });
});

describe("romanize — Arabic", () => {
  it("transliterates consonants and written long vowels only", () => {
    expect(romanize("محمد")).toBe("mḥmd");
    expect(romanize("فيروز")).toBe("fyrwz");
    expect(romanize("القاهرة")).toBe("alqahra");
  });

  it("strips harakat, shadda and tatweel", () => {
    expect(romanize("مُحَمَّد")).toBe("mḥmd");
    expect(romanize("محمـد")).toBe("mḥmd");
  });

  it("covers Persian and Urdu additions to the table", () => {
    expect(romanize("پژمان")).toBe("pzhman");
    expect(romanize("لاہور")).toBe("lahwr");
  });
});

describe("romanize — Japanese kana", () => {
  it("romanizes hiragana and katakana in Hepburn", () => {
    expect(romanize("さくら")).toBe("sakura");
    expect(romanize("カタカナ")).toBe("katakana");
  });

  it("doubles the consonant after a sokuon", () => {
    expect(romanize("ずっと")).toBe("zutto");
  });

  it("reads yōon combinations and keeps おう letter-faithful", () => {
    expect(romanize("きょう")).toBe("kyou");
  });

  it("applies the Hepburn ん rules", () => {
    expect(romanize("しんぶん")).toBe("shimbun");
    expect(romanize("かんい")).toBe("kan'i");
  });

  it("lengthens the vowel at a long-vowel mark", () => {
    expect(romanize("ラーメン")).toBe("rāmen");
  });
});

describe("romanize — Korean Hangul", () => {
  it("romanizes syllables algorithmically from their jamo", () => {
    // Hangul has no case, so the romanization is lower-case throughout
    expect(romanize("한국")).toBe("hanguk");
    expect(romanize("서울")).toBe("seoul");
    expect(romanize("부산")).toBe("busan");
  });

  it("is letter-faithful, with no assimilation between syllables", () => {
    expect(romanize("김치")).toBe("gimchi");
    expect(romanize("안녕하세요")).toBe("annyeonghaseyo");
    expect(romanize("한국말")).toBe("hangukmal");
  });
});

describe("romanize — composition rule", () => {
  it("returns null for already-Latin text", () => {
    expect(romanize("Hello World")).toBeNull();
    expect(romanize("Beyoncé")).toBeNull();
    expect(romanize("")).toBeNull();
    expect(romanize("123 !!!")).toBeNull();
  });

  it("returns null when Latin letters outnumber covered letters", () => {
    expect(romanize("Concert in Москва City")).toBeNull();
  });

  it("romanizes mixed text when covered letters at least match Latin ones", () => {
    expect(romanize("Live in Москва")).toBe("Live in Moskva");
    expect(romanize("BTS 방탄소년단")).toBe("BTS bangtansonyeondan");
    expect(romanize("🎵 Москва")).toBe("🎵 Moskva");
  });

  it("returns null for scripts with no coverage at all", () => {
    expect(romanize("สวัสดี")).toBeNull();
    expect(romanize("բարև")).toBeNull();
  });

  it("keeps a minority uncovered run verbatim rather than dropping it", () => {
    expect(romanize("東京スカイ")).toBe("東京sukai");
    expect(romanize("きのこ帝国")).toBe("kinoko帝国");
  });

  it("returns null when an uncovered script carries at least half the name", () => {
    expect(romanize("漢字かな")).toBeNull();
    // Kanji-dominant Japanese names are not guessed at: no dictionary.
    expect(romanize("宇多田ヒカル")).toBeNull();
    expect(romanize("東京")).toBeNull();
    expect(romanize("中文名")).toBeNull();
  });
});

describe("romanize — cache", () => {
  it("memoises results, including nulls", () => {
    expect(romanize("Москва")).toBe("Moskva");
    expect(romanize("Москва")).toBe("Moskva");
    expect(romanizeCacheSize()).toBe(1);
    expect(romanize("Hello")).toBeNull();
    expect(romanizeCacheSize()).toBe(2);
  });

  it("stays bounded under many distinct inputs", () => {
    for (let i = 0; i < 600; i++) {
      romanize(`Москва${i}`);
    }
    expect(romanizeCacheSize()).toBeLessThanOrEqual(512);
    expect(romanizeCacheSize()).toBeGreaterThan(0);
  });

  it("clears on demand", () => {
    romanize("Москва");
    clearRomanizeCache();
    expect(romanizeCacheSize()).toBe(0);
  });
});
