#!/usr/bin/env node
// One-shot generator: produce the Serbian Cyrillic (`*.sr-Cyrl.md`) help
// pages by transliterating the hand-translated Serbian Latin
// (`*.sr-Latn.md`) ones with the deterministic Serbian Latin → Cyrillic
// map — the same trick used for the UI bundle (see generate-sr-cyrl.mjs).
//
// Run from the repo root:
//   node modules/tools/sr-transliterate/generate-sr-cyrl-help.mjs
//
// It rewrites every `*.sr-Cyrl.md` under modules/docs/help/ in place.
// Markdown syntax, URLs, inline/fenced code and a fixed list of Latin
// brand tokens are preserved verbatim; only running prose is mapped.
//
// Note on "Sadhu": the assistant's name is written in Cyrillic in the
// Serbian UI ("Питај Садхуа"), so a bare "Sadhu" is intentionally
// transliterated to "Садху". Only the product brand "Shruti"
// stays Latin (it is in the PROTECTED list, longest-match-first).

import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { srLatinToCyrillic } from "./srLatinToCyrillic.mjs"

// Latin tokens that must stay in Latin script (matching the UI bundle
// generator + a few brand names that only appear in the help corpus).
// Longest first so multi-word brands win over their prefixes.
const PROTECTED = [
  "Shruti Pro",
  "Shruti",
  "Google Play",
  "App Store",
  "OpenRouter",
  "Shruti",
  "SQLite",
  "Gemini",
  "Google",
  "Apple",
  "iOS",
  "PRO",
  "PDF",
  "CDN",
  "SSE",
  "AI",
  "BG",
]

// IAST (Sanskrit transliteration) diacritics carry over from the Latin
// source — the base srLatinToCyrillic map leaves them untouched, which
// would strand a Latin glyph inside Cyrillic prose (e.g. "Бхагавад-гīту").
// Map them to their plain Serbian Cyrillic counterpart so the output is
// pure Cyrillic, never a mixed-script hybrid.
const IAST = {
  "ā": "а", "Ā": "А", // ā Ā
  "ī": "и", "Ī": "И", // ī Ī
  "ū": "у", "Ū": "У", // ū Ū
  "ṛ": "р", "Ṛ": "Р", "ṝ": "р", // ṛ Ṛ ṝ
  "ḷ": "л", // ḷ
  "ṭ": "т", "Ṭ": "Т", // ṭ Ṭ
  "ḍ": "д", "Ḍ": "Д", // ḍ Ḍ
  "ṇ": "н", "Ṇ": "Н", // ṇ Ṇ
  "ṅ": "н", "Ṅ": "Н", // ṅ Ṅ
  "ñ": "њ", "Ñ": "Њ", // ñ Ñ
  "ṣ": "ш", "Ṣ": "Ш", // ṣ Ṣ
  "ś": "ш", "Ś": "Ш", // ś Ś
  "ḥ": "х", "Ḥ": "Х", // ḥ Ḥ
  "ṁ": "м", "Ṁ": "М", // ṁ Ṁ
  "ṃ": "м", "Ṃ": "М", // ṃ Ṃ
}
const IAST_RE = new RegExp("[" + Object.keys(IAST).join("") + "]", "g")

function mapRun(run) {
  return srLatinToCyrillic(run).replace(IAST_RE, (ch) => IAST[ch])
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const HELP_DIR = join(__dirname, "../../docs/help")

/**
 * Transliterate one markdown document, leaving markdown syntax that must
 * not be touched intact: fenced code blocks, inline code spans, link /
 * image URL targets, bare http(s) URLs, and the PROTECTED brand tokens.
 * @param {string} src
 */
function transliterateMarkdown(src) {
  let out = ""
  let i = 0
  const n = src.length
  let run = ""
  const flush = () => {
    if (run) {
      out += mapRun(run)
      run = ""
    }
  }

  while (i < n) {
    // Fenced code block — copy ```...``` verbatim to the closing fence.
    if (src.startsWith("```", i)) {
      flush()
      const close = src.indexOf("```", i + 3)
      const end = close === -1 ? n : close + 3
      out += src.slice(i, end)
      i = end
      continue
    }
    // Inline code span — copy `...` verbatim.
    if (src[i] === "`") {
      flush()
      const close = src.indexOf("`", i + 1)
      const end = close === -1 ? i + 1 : close + 1
      out += src.slice(i, end)
      i = end
      continue
    }
    // Markdown link / image target: `](url)` — transliterate the link
    // text (already handled char-by-char before we reach `]`), keep the
    // `(url)` verbatim.
    if (src.startsWith("](", i)) {
      flush()
      const close = src.indexOf(")", i + 2)
      const end = close === -1 ? i + 2 : close + 1
      out += src.slice(i, end)
      i = end
      continue
    }
    // Bare URL — copy until whitespace or a closing delimiter.
    if (src.startsWith("http://", i) || src.startsWith("https://", i)) {
      flush()
      let j = i
      while (j < n && !/[\s)>\]]/.test(src[j])) j += 1
      out += src.slice(i, j)
      i = j
      continue
    }
    // Protected Latin brand token.
    let matched = false
    for (const token of PROTECTED) {
      if (src.startsWith(token, i)) {
        flush()
        out += token
        i += token.length
        matched = true
        break
      }
    }
    if (matched) continue

    run += src[i]
    i += 1
  }
  flush()
  return out
}

const files = readdirSync(HELP_DIR).filter((f) => f.endsWith(".sr-Latn.md"))
let count = 0
for (const file of files) {
  const base = file.slice(0, -".sr-Latn.md".length)
  const src = readFileSync(join(HELP_DIR, file), "utf8")
  writeFileSync(join(HELP_DIR, `${base}.sr-Cyrl.md`), transliterateMarkdown(src))
  count += 1
}

console.log(`Generated ${count} sr-Cyrl help page(s) from sr-Latn.`)
