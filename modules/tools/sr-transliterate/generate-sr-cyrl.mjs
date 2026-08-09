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

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { srLatinToCyrillic } from "./srLatinToCyrillic.mjs"

// Latin brand names, product SKUs and code-like tokens that must stay in
// Latin script, the way the hand-authored ru/ bundle writes them
// ("Слушай Садху Pro", "беседы с Ask Sadhu"). Sorted longest first so
// "Shruti Pro" wins over "Shruti".
//
// Only product/feature names belong here. A bare "Sadhu" is a name in
// running text, which ru/ and sr-Cyrl both render in Cyrillic ("Садху"),
// as they do "Studio" → "Студио". "Ask Sadhu" is on the list because
// settings.syncChats.description quotes the brand verbatim in en/ and
// ru/ alike; the nav label at settings.sections.chat is localized
// ("Pitaj Sadhua") and stays that way — this list decides script, never
// wording.
const PROTECTED = [
  "Shruti Pro",
  "Shruti",
  "Ask Sadhu",
  "Lectorium",
  "Google",
  "Apple",
  "PRO",
  "PDF",
  "CDN",
  "SSE",
  "Pro",
  "AI",
  "BG",
].sort((a, b) => b.length - a.length)

// Tokens match case-sensitively and only on whole-word boundaries. The
// boundary is what makes short entries safe to list at all: matched as a
// bare substring, "Pro" would rewrite "Prošlo" → "Proшло", "Proverite" →
// "Proверите", "Program" → "Proграм".
//
// The trade-off is that a token glued to a suffix is no longer protected
// — a hypothetical "PDFovi" transliterates whole, to "ПДФови". No such
// form exists in sr-Latn (declensions are written "PDF-ovi", where the
// hyphen keeps the boundary), and that is the better default: silently
// splitting a Serbian word is worse than transliterating one.
const WORD_CHAR = /[0-9A-Za-zČĆĐŠŽčćđšž]/
const isWordChar = (ch) => ch !== undefined && WORD_CHAR.test(ch)

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOCALES_DIR = join(__dirname, "../../apps/mobile/lectorium/i18n/locales")
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
      if (!body.startsWith(token, i)) continue
      if (isWordChar(body[i - 1]) || isWordChar(body[i + token.length])) continue
      flush()
      out += token
      i += token.length
      continue outer
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

// Transliteration shifts a few line lengths (digraphs like nj→њ shorten
// a line by one char), so the output is re-formatted with the mobile
// app's own prettier. That step is mandatory, not best-effort: unwrapped
// lines get silently reflowed by the next run that does have prettier,
// which is drift disguised as someone else's diff. Resolve it up front —
// through the package, not the `.bin` shim, so any cwd works — and bail
// before writing anything.
const MOBILE = join(LOCALES_DIR, "../../..")
let prettierBin
try {
  prettierBin = createRequire(join(MOBILE, "package.json")).resolve("prettier/bin/prettier.cjs")
} catch {
  console.error(
    `prettier is not installed under ${MOBILE}. Run \`npm ci\` there, then re-run this generator.`,
  )
  process.exit(1)
}

mkdirSync(DST, { recursive: true })

const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"))
const written = []
for (const file of files) {
  const src = readFileSync(join(SRC, file), "utf8")
  const out = AUTOGEN_HEADER + transliterateSource(src)
  writeFileSync(join(DST, file), out)
  written.push(join(DST, file))
}

// Drop outputs whose sr-Latn counterpart is gone, so a removed namespace
// can't leave a tracked orphan behind — the idempotence check compares
// against git, and an orphan is invisible to it once committed.
let pruned = 0
for (const file of readdirSync(DST).filter((f) => f.endsWith(".ts"))) {
  if (files.includes(file)) continue
  rmSync(join(DST, file))
  pruned += 1
}

const fmt = spawnSync(
  process.execPath,
  [prettierBin, "--log-level", "warn", "--write", ...written],
  { cwd: MOBILE, stdio: "inherit" },
)
if (fmt.status !== 0) {
  console.error("prettier failed to format sr-Cyrl; the generated bundle is unformatted.")
  process.exit(fmt.status ?? 1)
}

console.log(
  `Generated ${written.length} sr-Cyrl file(s) from sr-Latn` +
    (pruned ? `, pruned ${pruned} orphan(s).` : "."),
)
