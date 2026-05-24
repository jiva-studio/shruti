import type { LanguageCode } from "@lib/domain/core.js"
import type { Reference } from "@lib/domain/reference.js"
import type { Source } from "@lib/domain/source.js"

/** En-dash (U+2013) — preferred separator for numeric ranges. */
const RANGE_SEP = "–"

/**
 * Collapses contiguous runs of consecutive scripture references into
 * range chips (e.g. `["BG 1.13", "BG 1.14"] → ["BG 1.13–14"]`).
 *
 * Adjacency rule (per spec):
 * - same `sourceId`
 * - `tokens.length` equal
 * - all tokens equal except the last
 * - last tokens parse to integers and differ by exactly 1
 *
 * Chains of 3+ collapse to one range with the lowest..highest tail
 * (e.g. 1.13, 1.14, 1.15 → "BG 1.13–15"). If a tail token isn't
 * purely numeric on either side, the pair does NOT collapse.
 *
 * **Original ordering is preserved**: only contiguous runs in the
 * input array are collapsed. Mixed/interleaved sources
 * (e.g. `BG 1.13, SB 2.5, BG 1.14`) are NOT reordered or grouped —
 * the two BGs stay separate chips. This keeps the editor's chosen
 * order intact and matches the issue's "preserve original ordering"
 * note.
 */
export function groupReferences(
  refs: readonly Reference[],
  sourcesById: ReadonlyMap<string, Source> | undefined,
  lang: LanguageCode
): string[] {
  if (refs.length === 0) return []

  const out: string[] = []
  let runStart = 0

  for (let i = 1; i <= refs.length; i++) {
    const continues = i < refs.length && isAdjacent(refs[i - 1]!, refs[i]!)
    if (!continues) {
      // close the run [runStart .. i-1]
      out.push(formatRun(refs, runStart, i - 1, sourcesById, lang))
      runStart = i
    }
  }

  return out
}

/** True when `b` is the immediate next reference after `a` per the adjacency rule. */
function isAdjacent(a: Reference, b: Reference): boolean {
  if (a.sourceId !== b.sourceId) return false
  if (a.tokens.length !== b.tokens.length) return false
  if (a.tokens.length === 0) return false

  const last = a.tokens.length - 1
  for (let i = 0; i < last; i++) {
    if (a.tokens[i] !== b.tokens[i]) return false
  }

  const aTail = a.tokens[last]!
  const bTail = b.tokens[last]!
  if (!isPureNonNegativeInt(aTail) || !isPureNonNegativeInt(bTail)) return false

  return Number(bTail) - Number(aTail) === 1
}

/** Only pure non-negative integer literals — no signs, no leading "+", no decimals. */
function isPureNonNegativeInt(s: string): boolean {
  if (s.length === 0) return false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 48 /* 0 */ || c > 57 /* 9 */) return false
  }
  return true
}

/** Renders a run [start..end] (inclusive) as either a single ref or a range. */
function formatRun(
  refs: readonly Reference[],
  start: number,
  end: number,
  sourcesById: ReadonlyMap<string, Source> | undefined,
  lang: LanguageCode
): string {
  const head = refs[start]!
  if (start === end) return formatReference(head, sourcesById, lang)

  const tail = refs[end]!
  const localised = localisedShortName(head, sourcesById, lang)
  const headTokens = head.tokens.join(".")
  const lastTail = tail.tokens[tail.tokens.length - 1]!
  return `${localised} ${headTokens}${RANGE_SEP}${lastTail}`
}

/** Renders a single Reference as "{localised-short} {tokens}". */
export function formatReference(
  ref: Reference,
  sourcesById: ReadonlyMap<string, Source> | undefined,
  lang: LanguageCode
): string {
  const localised = localisedShortName(ref, sourcesById, lang)
  const tokens = ref.tokens.join(".")
  return tokens.length > 0 ? `${localised} ${tokens}` : localised
}

/**
 * Renders a single Reference as "{localised-full} {tokens}".
 * Used by the verse-text block (centered chip above multi-line verse
 * text), where there is room for the long name. Falls back to the
 * short name, then the raw `sourceId`.
 */
export function formatReferenceFull(
  ref: Reference,
  sourcesById: ReadonlyMap<string, Source> | undefined,
  lang: LanguageCode
): string {
  const localised = localisedFullName(ref, sourcesById, lang)
  const tokens = ref.tokens.join(".")
  return tokens.length > 0 ? `${localised} ${tokens}` : localised
}

function localisedShortName(
  ref: Reference,
  sourcesById: ReadonlyMap<string, Source> | undefined,
  lang: LanguageCode
): string {
  const source = sourcesById?.get(ref.sourceId)
  return (
    source?.names.get(lang)?.shortName ??
    source?.names.values().next().value?.shortName ??
    ref.sourceId
  )
}

function localisedFullName(
  ref: Reference,
  sourcesById: ReadonlyMap<string, Source> | undefined,
  lang: LanguageCode
): string {
  const source = sourcesById?.get(ref.sourceId)
  const localised = source?.names.get(lang)
  const anyLocale = localised ?? source?.names.values().next().value
  // Treat empty strings as "missing" — DB rows with an absent fullName
  // are stored as "" by the importer, not as `undefined`. We still want
  // to fall through to the short name (then to the raw sourceId).
  const full = anyLocale?.fullName
  if (full && full.length > 0) return full
  const short = anyLocale?.shortName
  if (short && short.length > 0) return short
  return ref.sourceId
}
