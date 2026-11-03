import {
  ARABIC_MAP,
  CYRILLIC_MAP,
  GREEK_MAP,
  HANGUL_FINALS,
  HANGUL_INITIALS,
  HANGUL_MEDIALS,
  HEBREW_MAP,
  KANA_COMBOS,
  KANA_MAP,
} from "./tables";

/**
 * Name romanization engine — DISPLAY ONLY.
 *
 * `romanize(text)` returns a Latin-script reading of a track / artist /
 * playlist name, or `null` when no honest reading exists. It never mutates
 * its input and callers must never write the result back: search identity,
 * matching and stored names always use the original string. The helper only
 * feeds a secondary, visually subordinate display line.
 *
 * The engine is pure, synchronous and offline. Results are memoised in a
 * bounded cache (see CACHE_LIMIT) because list rows re-render often.
 *
 * Composition rule (tested in romanize.test.ts):
 *   Let C = covered-script letters (Cyrillic, Greek, Hebrew, Arabic, kana,
 *   Hangul syllables), L = Latin letters, U = letters of any other script
 *   (Han, Thai, Devanagari, Armenian, …).
 *   1. C = 0                       -> null (nothing to romanize)
 *   2. L > C                       -> null (already Latin-dominant)
 *   3. U > 0 and U >= C            -> null (an uncovered script carries at
 *      least half of the non-Latin name; a partial reading would mislead)
 *   4. otherwise compose: covered runs are romanized, Latin / digit /
 *      punctuation / symbol runs are kept verbatim, and uncovered runs are
 *      kept verbatim — they are a strict minority (rule 3) and dropping
 *      them would silently lose part of the name.
 *   Kanji/kana corollary: a Japanese name romanizes its kana only when kana
 *   letters outnumber Han letters (rule 3 with U = Han); a kanji-dominant
 *   or kanji-only name returns null, because kanji readings need a
 *   dictionary this tree does not ship.
 */

const CACHE_LIMIT = 512;
const cache = new Map<string, string | null>();

export function romanizeCacheSize(): number {
  return cache.size;
}

export function clearRomanizeCache(): void {
  cache.clear();
}

const MARK_RE = /\p{M}/u;
const LETTER_RE = /\p{L}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const LATIN_LETTER_RE = /\p{Script=Latin}/u;
const TATWEEL = "ـ";

type SegmentClass =
  | "cyrillic"
  | "greek"
  | "hebrew"
  | "arabic"
  | "kana"
  | "hangul"
  | "latin"
  | "han"
  | "uncovered"
  | "neutral";

interface Segment {
  cls: SegmentClass;
  text: string;
}

function greekBase(ch: string): string | undefined {
  const nfd = [...ch.normalize("NFD")];
  const base = nfd[0];
  return base ? GREEK_MAP[base] : undefined;
}

function classify(ch: string): SegmentClass | "mark" {
  if (ch === TATWEEL) return "mark";
  if (MARK_RE.test(ch)) return "mark";
  const cp = ch.codePointAt(0) ?? 0;

  if (CYRILLIC_MAP[ch] !== undefined) return "cyrillic";
  if (GREEK_MAP[ch] !== undefined || greekBase(ch) !== undefined) {
    if (
      (cp >= 0x0370 && cp <= 0x03ff) ||
      (cp >= 0x1f00 && cp <= 0x1fff) ||
      GREEK_MAP[ch] !== undefined
    ) {
      return "greek";
    }
  }
  if (HEBREW_MAP[ch] !== undefined) return "hebrew";
  if (ARABIC_MAP[ch] !== undefined) return "arabic";
  if (cp >= 0xac00 && cp <= 0xd7a3) return "hangul";
  if ((cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff)) {
    return "kana";
  }
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) {
    return "han";
  }
  if (LATIN_RE.test(ch)) return "latin";
  if (LETTER_RE.test(ch)) return "uncovered";
  return "neutral";
}

function isCovered(cls: SegmentClass): boolean {
  return (
    cls === "cyrillic" ||
    cls === "greek" ||
    cls === "hebrew" ||
    cls === "arabic" ||
    cls === "kana" ||
    cls === "hangul"
  );
}

function convertCyrillic(text: string): string {
  let out = "";
  for (const ch of text) {
    if (MARK_RE.test(ch)) continue;
    out += CYRILLIC_MAP[ch] ?? ch;
  }
  return out;
}

function convertGreek(text: string): string {
  let out = "";
  for (const ch of text) {
    if (MARK_RE.test(ch)) continue;
    const direct = GREEK_MAP[ch];
    if (direct !== undefined) {
      out += direct;
      continue;
    }
    // Polytonic / accented precomposed letter: read its NFD base letter and
    // drop the diacritics (breathings, accents, iota subscript).
    out += greekBase(ch) ?? ch;
  }
  return out;
}

function convertHebrew(text: string): string {
  let out = "";
  for (const ch of text) {
    // Niqqud and cantillation marks are combining marks: stripped, not read.
    if (MARK_RE.test(ch)) continue;
    out += HEBREW_MAP[ch] ?? ch;
  }
  return out;
}

function convertArabic(text: string): string {
  let out = "";
  for (const ch of text) {
    // Harakat, shadda and other vowel marks are combining marks: stripped.
    if (MARK_RE.test(ch) || ch === TATWEEL) continue;
    out += ARABIC_MAP[ch] ?? ch;
  }
  return out;
}

function convertHangul(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0xac00 || cp > 0xd7a3) {
      out += ch;
      continue;
    }
    const s = cp - 0xac00;
    const initial = Math.floor(s / 588);
    const medial = Math.floor((s % 588) / 28);
    const final = s % 28;
    out +=
      (HANGUL_INITIALS[initial] ?? "") +
      (HANGUL_MEDIALS[medial] ?? "") +
      (HANGUL_FINALS[final] ?? "");
  }
  return out;
}

const MACRON: Record<string, string> = {
  a: "ā",
  i: "ī",
  u: "ū",
  e: "ē",
  o: "ō",
};

/** Re-spell a kana syllable under a dakuten (voiced) or handakuten mark. */
function voiceRomaji(rom: string, handakuten: boolean): string {
  const rules: ReadonlyArray<readonly [string, string]> = [
    ["sh", "j"],
    ["ch", "j"],
    ["ts", "z"],
    ["k", "g"],
    ["s", "z"],
    ["t", "d"],
    ["f", handakuten ? "p" : "b"],
    ["h", handakuten ? "p" : "b"],
  ];
  for (const [from, to] of rules) {
    if (rom.startsWith(from)) return to + rom.slice(from.length);
  }
  return rom;
}

function convertKana(text: string): string {
  const chars = [...text];
  let out = "";
  let lastRomaji = "";
  let doubleNext = false;

  /** Romaji of the unit starting at `idx`, without consuming it. */
  const unitAt = (idx: number): string | null => {
    const ch = chars[idx];
    if (ch === undefined) return null;
    if (ch === "っ" || ch === "ッ") return null;
    const pair = ch + (chars[idx + 1] ?? "");
    if (KANA_COMBOS[pair] !== undefined) return KANA_COMBOS[pair];
    if (ch === "ん" || ch === "ン") return "n";
    return KANA_MAP[ch] ?? null;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    if (MARK_RE.test(ch)) {
      // Combining dakuten / handakuten written as separate marks (が, ぱ).
      if ((ch === "゙" || ch === "゚") && lastRomaji) {
        const voiced = voiceRomaji(lastRomaji, ch === "゚");
        out = out.slice(0, out.length - lastRomaji.length) + voiced;
        lastRomaji = voiced;
      }
      continue;
    }

    if (ch === "っ" || ch === "ッ") {
      // Sokuon: geminate the next syllable's initial consonant.
      doubleNext = true;
      continue;
    }

    if (ch === "ー") {
      // Long-vowel mark: lengthen the vowel just produced (Hepburn macron).
      for (let j = out.length - 1; j >= 0; j--) {
        const macron = MACRON[out[j]];
        if (macron) {
          out = out.slice(0, j) + macron + out.slice(j + 1);
          break;
        }
        if (out[j] !== "'") break;
      }
      continue;
    }

    if (ch === "ゝ" || ch === "ヽ" || ch === "ゞ" || ch === "ヾ") {
      // Iteration mark: repeat the previous syllable (voiced for ゞ / ヾ).
      const rom =
        ch === "ゞ" || ch === "ヾ"
          ? voiceRomaji(lastRomaji, false)
          : lastRomaji;
      if (rom) {
        out += rom;
        lastRomaji = rom;
      }
      continue;
    }

    let romaji: string;
    const pair = ch + (chars[i + 1] ?? "");
    if (KANA_COMBOS[pair] !== undefined) {
      romaji = KANA_COMBOS[pair];
      i += 1;
    } else if (ch === "ん" || ch === "ン") {
      // Hepburn ん: m before b/m/p, n' before a vowel or y, else n.
      const next = unitAt(i + 1);
      if (next && /^[bmp]/.test(next)) romaji = "m";
      else if (next && /^[aiueoy]/.test(next)) romaji = "n'";
      else romaji = "n";
    } else {
      romaji = KANA_MAP[ch] ?? ch;
    }

    if (doubleNext) {
      doubleNext = false;
      const first = romaji.charAt(0);
      if (first && !"aiueo".includes(first) && /[a-z]/.test(first)) {
        romaji = first + romaji;
      }
    }

    out += romaji;
    lastRomaji = romaji;
  }
  return out;
}

function convertSegment(segment: Segment): string {
  switch (segment.cls) {
    case "cyrillic":
      return convertCyrillic(segment.text);
    case "greek":
      return convertGreek(segment.text);
    case "hebrew":
      return convertHebrew(segment.text);
    case "arabic":
      return convertArabic(segment.text);
    case "kana":
      return convertKana(segment.text);
    case "hangul":
      return convertHangul(segment.text);
    default:
      // Latin, Han, uncovered and neutral runs are kept exactly as written.
      return segment.text;
  }
}

function romanizeUncached(text: string): string | null {
  const segments: Segment[] = [];
  let covered = 0;
  let latin = 0;
  let uncovered = 0;

  for (const ch of text) {
    const cls = classify(ch);
    if (cls === "mark") {
      // Combining marks ride along with the run they modify; the run's
      // converter decides whether to read or strip them.
      const last = segments[segments.length - 1];
      if (last) last.text += ch;
      else segments.push({ cls: "neutral", text: ch });
      continue;
    }
    if (isCovered(cls)) covered += 1;
    else if (cls === "latin") latin += 1;
    else if (cls === "han" || cls === "uncovered") uncovered += 1;

    const last = segments[segments.length - 1];
    if (last && last.cls === cls) last.text += ch;
    else segments.push({ cls, text: ch });
  }

  if (covered === 0) return null;
  if (latin > covered) return null;
  if (uncovered > 0 && uncovered >= covered) return null;

  const out = segments.map(convertSegment).join("");
  if (out === text) return null;
  if (![...out].some((ch) => LATIN_LETTER_RE.test(ch))) return null;
  return out;
}

/**
 * Romanize a name for display. Returns `null` when the text is already
 * Latin-dominant or no covered script can honestly carry it. Never mutates
 * the input; the result is a display string only.
 */
export function romanize(text: string): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const result = romanizeUncached(text);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, result);
  return result;
}
