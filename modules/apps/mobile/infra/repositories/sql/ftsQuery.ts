/**
 * The user's query string, turned into an FTS4 MATCH expression against the
 * catalog's single `combined` row per track.
 *
 * Query and index must fold the same way, so the folding here mirrors the
 * catalog writer's `unicode61 "remove_diacritics=2"` tokenizer.
 */

/** A multi-component numeric reference (`2.13`, `1.1.2`); a bare year is not one. */
const REFERENCE_PATTERN = /^\d+(?:\.\d+)+$/

interface QueryPiece {
  phrase: boolean
  text: string
}

/** Split raw input into quoted phrases and bare words. */
function splitQueryPieces(raw: string): QueryPiece[] {
  const out: QueryPiece[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      const text = m[1].trim()
      if (text.length > 0) out.push({ phrase: true, text })
    } else if (m[2] !== undefined) {
      out.push({ phrase: false, text: m[2] })
    }
  }
  return out
}

/**
 * Fold a string into the form the catalog indexes: lower case, no combining
 * marks, Cyrillic `ё` → `е`.
 *
 * Lower-casing runs first because `İ`.toLowerCase() manufactures a mark of its
 * own. Latin and Greek marks are deleted, so `gītā` folds to `gita`;
 * everything else is re-composed first, which keeps `й ё ї ў` as themselves
 * and strips only the marks with no precomposed form.
 */
export function foldSearchText(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/([\p{Script=Latin}\p{Script=Greek}])\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/\p{M}+/gu, "")
    .replace(/ё/gu, "е")
}

/**
 * Split a folded string into index tokens, on the letter/digit classes
 * `unicode61` itself tokenises on — so Ukrainian `і ї є ґ` and Serbian
 * `ј љ њ ћ ђ џ` survive an `a-z`/`а-я` deny-list. Tokens stay alphanumeric,
 * so no FTS operator or quote can leak into the MATCH expression.
 */
function sanitizeTokens(raw: string): string[] {
  return foldSearchText(raw)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
}

/** A user-quoted phrase. A single token stays a bare prefix: FTS4 returns
 *  nothing for a quoted-then-starred Cyrillic term (`"джент"*`). */
function renderPhrase(text: string): string | null {
  const inner = sanitizeTokens(text)
  if (inner.length === 0) return null
  return inner.length === 1 ? `${inner[0]}*` : `"${inner.join(" ")}"`
}

/** A bare word. A dotted reference becomes a phrase so FTS enforces adjacency
 *  on the components — prefix-ANDing `2* 13*` matches any 2.x plus any 13.x. */
function renderWord(text: string): string[] {
  if (REFERENCE_PATTERN.test(text)) return [`"${text.split(".").join(" ")}"`]
  return sanitizeTokens(text).map((t) => `${t}*`)
}

/**
 * An implicit AND across prefixes: every token must appear somewhere in the
 * matched row. Negation (`-term`) is not supported — the stock FTS4 build
 * silently ignores it and falls back to a positive match.
 */
export function buildFtsQuery(raw: string): string {
  const out: string[] = []
  for (const piece of splitQueryPieces(raw)) {
    if (piece.phrase) {
      const rendered = renderPhrase(piece.text)
      if (rendered) out.push(rendered)
    } else {
      out.push(...renderWord(piece.text))
    }
  }
  return out.join(" ")
}
