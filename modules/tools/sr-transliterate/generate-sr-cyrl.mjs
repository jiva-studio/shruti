#!/usr/bin/env node
// One-shot generator: produce the `sr-Cyrl/` UI locale bundle by
// transliterating the hand-authored `sr-Latn/` bundle with the
// deterministic Serbian Latin → Cyrillic map.
//
// Run from the repo root:
//   node modules/tools/sr-transliterate/generate-sr-cyrl.mjs
//
// It rewrites every `.ts` under sr-Cyrl/ in place. Only the *contents*
// of string literals are transliterated — object keys, identifiers,
// comments and placeholders such as {when}/{count}/{n} are preserved
// byte-for-byte (placeholders contain only ASCII, which the map leaves
// untouched, but we additionally skip over `{...}` spans to be safe).

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { srLatinToCyrillic } from "./srLatinToCyrillic.mjs"

// Latin brand names, product SKUs and code-like tokens that must stay in
// Latin script (matching how ru/ keeps them verbatim). Longest first so
// "Shruti Pro" wins over "Shruti". Matched as exact
// substrings inside a string-literal body.
const PROTECTED = [
  "Shruti Pro",
  "Shruti",
  "Shruti",
  "Google",
  "Apple",
  "PRO",
  "PDF",
  "CDN",
  "SSE",
  "AI",
  "BG",
]

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = join(__dirname, "../../apps/mobile/shruti/i18n/locales")
const SRC = join(LOCALES_DIR, "sr-Latn")
const DST = join(LOCALES_DIR, "sr-Cyrl")

/**
 * Transliterate the body of one quoted string literal, leaving `{...}`
 * interpolation placeholders intact.
 * @param {string} body — raw literal contents (without the quotes)
 */
function transliterateLiteral(body) {
  let out = ""
  let i = 0
  let run = ""
  const flush = () => {
    if (run) {
      out += srLatinToCyrillic(run)
      run = ""
    }
  }
  outer: while (i < body.length) {
    if (body[i] === "{") {
      const end = body.indexOf("}", i)
      if (end !== -1) {
        flush()
        out += body.slice(i, end + 1)
        i = end + 1
        continue
      }
    }
    for (const token of PROTECTED) {
      if (body.startsWith(token, i)) {
        flush()
        out += token
        i += token.length
        continue outer
      }
    }
    run += body[i]
    i += 1
  }
  flush()
  return out
}

/**
 * Walk a `.ts` source character by character. Inside double- or
 * single-quoted string literals, transliterate the body; everywhere
 * else (keys, identifiers, comments, punctuation) emit verbatim.
 * Handles escaped quotes (\" / \') and escape sequences like \n.
 */
function transliterateSource(src) {
  let out = ""
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]

    // Line comment — copy to end of line untouched.
    if (ch === "/" && src[i + 1] === "/") {
      const eol = src.indexOf("\n", i)
      const end = eol === -1 ? n : eol
      out += src.slice(i, end)
      i = end
      continue
    }
    // Block comment — copy to closing */ untouched.
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2)
      const end = close === -1 ? n : close + 2
      out += src.slice(i, end)
      i = end
      continue
    }

    // String literal.
    if (ch === '"' || ch === "'") {
      const quote = ch
      out += quote
      i += 1
      let body = ""
      while (i < n) {
        const c = src[i]
        if (c === "\\") {
          // Preserve the escape sequence as-is (e.g. \n, \", \').
          body += c + (src[i + 1] ?? "")
          i += 2
          continue
        }
        if (c === quote) break
        body += c
        i += 1
      }
      i += 1 // consume closing quote

      // A quoted string is an object KEY (not a value) when the next
      // non-whitespace char is `:` — e.g. "what-is-sadhana": {…} or
      // "30m": "30 minutes". Keys must mirror en/ byte-for-byte, so we
      // emit them verbatim and only transliterate values.
      let j = i
      while (j < n && /\s/.test(src[j])) j += 1
      const isKey = src[j] === ":"

      if (isKey) {
        out += body
      } else {
        // Transliterate the value body, keeping escape sequences intact
        // by only mapping the non-escape runs.
        out += body.replace(/\\.|[^\\]+/g, (seg) =>
          seg.startsWith("\\") ? seg : transliterateLiteral(seg),
        )
      }
      out += quote // closing quote
      continue
    }

    out += ch
    i += 1
  }
  return out
}

const AUTOGEN_HEADER =
  "// AUTO-GENERATED from ../sr-Latn by modules/tools/sr-transliterate/generate-sr-cyrl.mjs\n" +
  "// Do not edit by hand — re-run the generator instead.\n"

mkdirSync(DST, { recursive: true })

const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"))
let count = 0
for (const file of files) {
  const src = readFileSync(join(SRC, file), "utf8")
  const out = AUTOGEN_HEADER + transliterateSource(src)
  writeFileSync(join(DST, file), out)
  count += 1
}

// Transliteration shifts a few line lengths (digraphs like nj→њ shorten
// a line by one char), so re-format the generated files with the mobile
// app's own prettier to keep the bundle lint-clean and stable on re-run.
const MOBILE = join(LOCALES_DIR, "../../..")
const prettierBin = join(MOBILE, "node_modules/.bin/prettier")
const fmt = spawnSync(prettierBin, ["--write", join(DST, "*.ts")], {
  cwd: MOBILE,
  stdio: "inherit",
  shell: false,
})
if (fmt.status !== 0) {
  console.warn(
    "prettier formatting of sr-Cyrl failed (is it installed?); files written unformatted.",
  )
}

console.log(`Generated ${count} sr-Cyrl file(s) from sr-Latn.`)
