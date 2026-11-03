/**
 * Romanization tables — written for this codebase, not copied from any
 * upstream project or library. Each table is a deliberately *letter-faithful*
 * mapping: one source letter maps to one Latin spelling, with no dictionary,
 * no pronunciation/assimilation rules, and no invented vowels. Where a real
 * standard distinguishes forms we cannot tell apart without knowing the
 * language of the specific name, the table picks one documented spelling and
 * the section file (investigation/wave3-sections/item2-romanization.md)
 * records the trade-off.
 *
 * Coverage is limited to scripts whose romanization is algorithmic or a
 * finite letter table. Han characters are intentionally absent: readings
 * need a dictionary, which this tree does not ship.
 */

function capitalise(rom: string): string {
  if (!rom) return rom;
  return rom.charAt(0).toUpperCase() + rom.slice(1);
}

/** Adds an uppercase entry for every lowercase entry in a case-ful table. */
function withUppercase(
  pairs: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [ch, rom] of pairs) {
    map[ch] = rom;
    const upper = ch.toUpperCase();
    if (upper !== ch && !(upper in map)) {
      map[upper] = capitalise(rom);
    }
  }
  return map;
}

/**
 * Cyrillic — unified letter table in an ALA-LC/ISO-9 flavour, simplified for
 * name display (ĭ written y, ė kept for э so е/э stay distinct, ë for ё).
 * One table serves Russian, Ukrainian, Bulgarian, Serbian, Macedonian and
 * Belarusian names; it is NOT language-detected, so e.g. Ukrainian и reads
 * i (Russian value) and Bulgarian ъ reads as the hard sign ʺ. Serbian and
 * Macedonian extras use ASCII digraphs (dj, lj, nj, dzh, gj, kj) for
 * consistency with the rest of the table rather than Serbian Latin đ/ć.
 */
export const CYRILLIC_MAP: Record<string, string> = withUppercase([
  ["а", "a"],
  ["б", "b"],
  ["в", "v"],
  ["г", "g"],
  ["д", "d"],
  ["е", "e"],
  ["ё", "ë"],
  ["ж", "zh"],
  ["з", "z"],
  ["и", "i"],
  ["й", "y"],
  ["к", "k"],
  ["л", "l"],
  ["м", "m"],
  ["н", "n"],
  ["о", "o"],
  ["п", "p"],
  ["р", "r"],
  ["с", "s"],
  ["т", "t"],
  ["у", "u"],
  ["ф", "f"],
  ["х", "kh"],
  ["ц", "ts"],
  ["ч", "ch"],
  ["ш", "sh"],
  ["щ", "shch"],
  ["ъ", "ʺ"],
  ["ы", "y"],
  ["ь", "ʹ"],
  ["э", "ė"],
  ["ю", "yu"],
  ["я", "ya"],
  // Ukrainian
  ["є", "ye"],
  ["і", "i"],
  ["ї", "yi"],
  ["ґ", "g"],
  // Serbian / Macedonian / Belarusian extras
  ["ђ", "dj"],
  ["ј", "j"],
  ["љ", "lj"],
  ["њ", "nj"],
  ["ћ", "tj"],
  ["џ", "dzh"],
  ["ѕ", "dz"],
  ["ѓ", "gj"],
  ["ќ", "kj"],
  ["ў", "u"],
  // Grave-marked vowels (Macedonian/Serbian stress forms)
  ["ѐ", "e"],
  ["ѝ", "i"],
]);

/**
 * Greek — scholarly monotonic table (η ē, ω ō, θ th, φ ph, χ kh, ξ x, ψ ps).
 * Accented and polytonic forms are not listed one by one: the engine looks
 * unmapped Greek letters up by their NFD base letter, so ά, ἄ, ᾳ and ῥ all
 * resolve through α / ρ with their diacritics dropped.
 */
export const GREEK_MAP: Record<string, string> = withUppercase([
  ["α", "a"],
  ["β", "b"],
  ["γ", "g"],
  ["δ", "d"],
  ["ε", "e"],
  ["ζ", "z"],
  ["η", "ē"],
  ["θ", "th"],
  ["ι", "i"],
  ["κ", "k"],
  ["λ", "l"],
  ["μ", "m"],
  ["ν", "n"],
  ["ξ", "x"],
  ["ο", "o"],
  ["π", "p"],
  ["ρ", "r"],
  ["σ", "s"],
  ["ς", "s"],
  ["τ", "t"],
  ["υ", "y"],
  ["φ", "ph"],
  ["χ", "kh"],
  ["ψ", "ps"],
  ["ω", "ō"],
  ["ϑ", "th"],
  ["ϕ", "ph"],
]);

/**
 * Hebrew — consonantal transliteration. Only consonants are written: vowels
 * that the source does not write are not invented, and niqqud points, when
 * present, are stripped rather than read. Begedkefet letters keep one
 * spelling each (ב b, כ k, פ p) because the pointed/unpointed distinction is
 * not reliably present in names. Final forms (sofit) map to the same value
 * as their regular forms. ש is always sh (the sin dot is rarely present).
 */
export const HEBREW_MAP: Record<string, string> = {
  א: "ʾ",
  ב: "b",
  ג: "g",
  ד: "d",
  ה: "h",
  ו: "v",
  ז: "z",
  ח: "ḥ",
  ט: "ṭ",
  י: "y",
  כ: "k",
  ך: "k",
  ל: "l",
  מ: "m",
  ם: "m",
  נ: "n",
  ן: "n",
  ס: "s",
  ע: "ʿ",
  פ: "p",
  ף: "p",
  צ: "ts",
  ץ: "ts",
  ק: "q",
  ר: "r",
  ש: "sh",
  ת: "t",
};

/**
 * Arabic — consonantal transliteration in an ALA-LC flavour (ḥ ṣ ḍ ṭ ẓ for
 * the emphatics, ʾ / ʿ for hamza and ʿayn). Short-vowel marks (harakat),
 * shadda and tatweel are stripped, never read, so unvocalised names keep
 * only the vowels actually written (long ا / و / ي). ة (tāʾ marbūṭa) reads
 * a, its pausal name form; ى (alif maqṣūra) reads a. Persian and Urdu
 * letters that are single additions to the same table are included
 * (پ چ ژ گ ک ی ے ٹ ڈ ڑ ھ ہ ں ڭ ڤ ە); letters outside the table stay
 * uncovered and engage the engine's composition rule instead of guessing.
 */
export const ARABIC_MAP: Record<string, string> = {
  ء: "ʾ",
  آ: "a",
  أ: "a",
  ؤ: "ʾ",
  إ: "i",
  ئ: "ʾ",
  ا: "a",
  ب: "b",
  ة: "a",
  ت: "t",
  ث: "th",
  ج: "j",
  ح: "ḥ",
  خ: "kh",
  د: "d",
  ذ: "dh",
  ر: "r",
  ز: "z",
  س: "s",
  ش: "sh",
  ص: "ṣ",
  ض: "ḍ",
  ط: "ṭ",
  ظ: "ẓ",
  ع: "ʿ",
  غ: "gh",
  ف: "f",
  ق: "q",
  ك: "k",
  ل: "l",
  م: "m",
  ن: "n",
  ه: "h",
  و: "w",
  ى: "a",
  ي: "y",
  ٱ: "a",
  // Persian / Urdu additions
  پ: "p",
  چ: "ch",
  ڈ: "ḍ",
  ژ: "zh",
  ڑ: "ṛ",
  ٹ: "ṭ",
  ک: "k",
  گ: "g",
  ڭ: "ng",
  ڤ: "v",
  ی: "y",
  ے: "e",
  ہ: "h",
  ھ: "h",
  ں: "n",
  ە: "a",
};

const HIRAGANA_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["あ", "a"],
  ["い", "i"],
  ["う", "u"],
  ["え", "e"],
  ["お", "o"],
  ["か", "ka"],
  ["き", "ki"],
  ["く", "ku"],
  ["け", "ke"],
  ["こ", "ko"],
  ["さ", "sa"],
  ["し", "shi"],
  ["す", "su"],
  ["せ", "se"],
  ["そ", "so"],
  ["た", "ta"],
  ["ち", "chi"],
  ["つ", "tsu"],
  ["て", "te"],
  ["と", "to"],
  ["な", "na"],
  ["に", "ni"],
  ["ぬ", "nu"],
  ["ね", "ne"],
  ["の", "no"],
  ["は", "ha"],
  ["ひ", "hi"],
  ["ふ", "fu"],
  ["へ", "he"],
  ["ほ", "ho"],
  ["ま", "ma"],
  ["み", "mi"],
  ["む", "mu"],
  ["め", "me"],
  ["も", "mo"],
  ["や", "ya"],
  ["ゆ", "yu"],
  ["よ", "yo"],
  ["ら", "ra"],
  ["り", "ri"],
  ["る", "ru"],
  ["れ", "re"],
  ["ろ", "ro"],
  ["わ", "wa"],
  ["ゐ", "wi"],
  ["ゑ", "we"],
  ["を", "wo"],
  ["ん", "n"],
  ["が", "ga"],
  ["ぎ", "gi"],
  ["ぐ", "gu"],
  ["げ", "ge"],
  ["ご", "go"],
  ["ざ", "za"],
  ["じ", "ji"],
  ["ず", "zu"],
  ["ぜ", "ze"],
  ["ぞ", "zo"],
  ["だ", "da"],
  ["ぢ", "ji"],
  ["づ", "zu"],
  ["で", "de"],
  ["ど", "do"],
  ["ば", "ba"],
  ["び", "bi"],
  ["ぶ", "bu"],
  ["べ", "be"],
  ["ぼ", "bo"],
  ["ぱ", "pa"],
  ["ぴ", "pi"],
  ["ぷ", "pu"],
  ["ぺ", "pe"],
  ["ぽ", "po"],
  ["ゔ", "vu"],
  // Small kana standing alone (in combinations the combo table wins)
  ["ぁ", "a"],
  ["ぃ", "i"],
  ["ぅ", "u"],
  ["ぇ", "e"],
  ["ぉ", "o"],
  ["ゃ", "ya"],
  ["ゅ", "yu"],
  ["ょ", "yo"],
  ["ゎ", "wa"],
  ["ゕ", "ka"],
  ["ゖ", "ke"],
];

function toKatakanaChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x3041 && cp <= 0x3096 ? String.fromCodePoint(cp + 0x60) : ch;
}

/** Hiragana + katakana letter table (Hepburn). Sokuon and ー are handled by
 *  the engine, not here; ん is here but its spelling is context-adjusted. */
export const KANA_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [ch, rom] of HIRAGANA_PAIRS) {
    map[ch] = rom;
    map[toKatakanaChar(ch)] = rom;
  }
  return map;
})();

const HIRAGANA_COMBOS: ReadonlyArray<readonly [string, string]> = [
  ["きゃ", "kya"],
  ["きゅ", "kyu"],
  ["きょ", "kyo"],
  ["しゃ", "sha"],
  ["しゅ", "shu"],
  ["しょ", "sho"],
  ["ちゃ", "cha"],
  ["ちゅ", "chu"],
  ["ちょ", "cho"],
  ["にゃ", "nya"],
  ["にゅ", "nyu"],
  ["にょ", "nyo"],
  ["ひゃ", "hya"],
  ["ひゅ", "hyu"],
  ["ひょ", "hyo"],
  ["みゃ", "mya"],
  ["みゅ", "myu"],
  ["みょ", "myo"],
  ["りゃ", "rya"],
  ["りゅ", "ryu"],
  ["りょ", "ryo"],
  ["ぎゃ", "gya"],
  ["ぎゅ", "gyu"],
  ["ぎょ", "gyo"],
  ["じゃ", "ja"],
  ["じゅ", "ju"],
  ["じょ", "jo"],
  ["ぢゃ", "ja"],
  ["ぢゅ", "ju"],
  ["ぢょ", "jo"],
  ["びゃ", "bya"],
  ["びゅ", "byu"],
  ["びょ", "byo"],
  ["ぴゃ", "pya"],
  ["ぴゅ", "pyu"],
  ["ぴょ", "pyo"],
  ["ふぁ", "fa"],
  ["ふぃ", "fi"],
  ["ふぇ", "fe"],
  ["ふぉ", "fo"],
  ["ゔぁ", "va"],
  ["ゔぃ", "vi"],
  ["ゔぇ", "ve"],
  ["ゔぉ", "vo"],
  ["てぃ", "ti"],
  ["でぃ", "di"],
  ["とぅ", "tu"],
  ["どぅ", "du"],
  ["ちぇ", "che"],
  ["しぇ", "she"],
  ["じぇ", "je"],
  ["うぃ", "wi"],
  ["うぇ", "we"],
  ["うぉ", "wo"],
  ["くぁ", "kwa"],
  ["くぃ", "kwi"],
  ["くぇ", "kwe"],
  ["くぉ", "kwo"],
  ["つぁ", "tsa"],
  ["つぃ", "tsi"],
  ["つぇ", "tse"],
  ["つぉ", "tso"],
];

/** Two-kana combinations (yōon and loanword pairs), hiragana + katakana. */
export const KANA_COMBOS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [pair, rom] of HIRAGANA_COMBOS) {
    map[pair] = rom;
    map[[...pair].map(toKatakanaChar).join("")] = rom;
  }
  return map;
})();

/**
 * Korean jamo tables for an algorithmic, letter-faithful Revised
 * Romanization: a syllable's spelling is initial + medial + final read
 * straight off its jamo, with NO assimilation or pronunciation rules
 * (so e.g. a final ㅅ is always t, never carried into the next syllable).
 * This is the spelling of the letters, not a pronunciation guide.
 */
export const HANGUL_INITIALS: readonly string[] = [
  "g", // ㄱ
  "kk", // ㄲ
  "n", // ㄴ
  "d", // ㄷ
  "tt", // ㄸ
  "r", // ㄹ
  "m", // ㅁ
  "b", // ㅂ
  "pp", // ㅃ
  "s", // ㅅ
  "ss", // ㅆ
  "", // ㅇ (silent as an initial)
  "j", // ㅈ
  "jj", // ㅉ
  "ch", // ㅊ
  "k", // ㅋ
  "t", // ㅌ
  "p", // ㅍ
  "h", // ㅎ
];

export const HANGUL_MEDIALS: readonly string[] = [
  "a", // ㅏ
  "ae", // ㅐ
  "ya", // ㅑ
  "yae", // ㅒ
  "eo", // ㅓ
  "e", // ㅔ
  "yeo", // ㅕ
  "ye", // ㅖ
  "o", // ㅗ
  "wa", // ㅘ
  "wae", // ㅙ
  "oe", // ㅚ
  "yo", // ㅛ
  "u", // ㅜ
  "wo", // ㅝ
  "we", // ㅞ
  "wi", // ㅟ
  "yu", // ㅠ
  "eu", // ㅡ
  "ui", // ㅢ
  "i", // ㅣ
];

export const HANGUL_FINALS: readonly string[] = [
  "", // no final
  "k", // ㄱ
  "k", // ㄲ
  "ks", // ㄳ
  "n", // ㄴ
  "nj", // ㄵ
  "nh", // ㄶ
  "t", // ㄷ
  "l", // ㄹ
  "lk", // ㄺ
  "lm", // ㄻ
  "lp", // ㄼ
  "ls", // ㄽ
  "lt", // ㄾ
  "lp", // ㄿ
  "lh", // ㅀ
  "m", // ㅁ
  "p", // ㅂ
  "ps", // ㅂ+ㅅ cluster
  "t", // ㅅ
  "t", // ㅆ
  "ng", // ㅇ
  "t", // ㅈ
  "t", // ㅊ
  "k", // ㅋ
  "t", // ㅌ
  "p", // ㅍ
  "t", // ㅎ
];
