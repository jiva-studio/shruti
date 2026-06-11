// Deterministic 1:1 Serbian Latin → Cyrillic transliteration.
//
// Serbian Latin (gajica) and Serbian Cyrillic are in a strict 1:1
// correspondence, the only subtlety being the three Latin digraphs
// (Lj, Nj, Dž) that each map to a single Cyrillic letter. Order matters:
// digraphs must be replaced before their constituent single letters.
//
// This is the same trick as the IAST→script transliterators on the chat
// side — a fixed lookup table applied left-to-right, no language model.
// We use it to generate the `sr-Cyrl/` UI bundle from the hand-authored
// `sr-Latn/` one, so the Cyrillic strings never drift from the Latin.

// Digraphs first (longest match wins). Each entry covers the three
// casings that occur in running text: all-caps (LJ), title (Lj), and
// lower (lj). "DŽ"/"Dž"/"dž" use the precomposed Ž as the second char.
const DIGRAPHS = [
  ["DŽ", "Џ"],
  ["Dž", "Џ"],
  ["dž", "џ"],
  ["LJ", "Љ"],
  ["Lj", "Љ"],
  ["lj", "љ"],
  ["NJ", "Њ"],
  ["Nj", "Њ"],
  ["nj", "њ"],
]

// Single-letter map. Latin letters with no Serbian Cyrillic equivalent
// (q, w, x, y) are left as-is — they only ever appear inside latin
// brand tokens / IAST, which we intentionally do not transliterate.
const SINGLES = {
  A: "А", a: "а",
  B: "Б", b: "б",
  V: "В", v: "в",
  G: "Г", g: "г",
  D: "Д", d: "д",
  Đ: "Ђ", đ: "ђ",
  E: "Е", e: "е",
  Ž: "Ж", ž: "ж",
  Z: "З", z: "з",
  I: "И", i: "и",
  J: "Ј", j: "ј",
  K: "К", k: "к",
  L: "Л", l: "л",
  M: "М", m: "м",
  N: "Н", n: "н",
  O: "О", o: "о",
  P: "П", p: "п",
  R: "Р", r: "р",
  S: "С", s: "с",
  T: "Т", t: "т",
  Ć: "Ћ", ć: "ћ",
  U: "У", u: "у",
  F: "Ф", f: "ф",
  H: "Х", h: "х",
  C: "Ц", c: "ц",
  Č: "Ч", č: "ч",
  Š: "Ш", š: "ш",
}

/**
 * Transliterate one Serbian Latin string to Serbian Cyrillic.
 * @param {string} input
 * @returns {string}
 */
export function srLatinToCyrillic(input) {
  let out = ""
  let i = 0
  outer: while (i < input.length) {
    // Try a two-char digraph first.
    const pair = input.slice(i, i + 2)
    for (const [latin, cyr] of DIGRAPHS) {
      if (pair === latin) {
        out += cyr
        i += 2
        continue outer
      }
    }
    const ch = input[i]
    out += SINGLES[ch] ?? ch
    i += 1
  }
  return out
}
