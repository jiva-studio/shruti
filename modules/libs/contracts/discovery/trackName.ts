import type { DiscoveryHit } from "./discoveryClient.js"

/**
 * What to call a recording on screen.
 *
 * Most carry a name of their own. Some do not, and truthfully so: an archive
 * that files a talk as "Ачьютатма дас - Шримад Бхагаватам 7.5.33-37 - 30.06.24"
 * has written down a speaker, a passage and a day, and no name — every part of
 * it is already a field of its own, and nothing is left over to be a title.
 *
 * Then the thing to show is what the talk *is*: the passage it reads. Never the
 * address of the file, which is what happens by default and which says nothing
 * to anybody.
 *
 * References arrive one apiece, because that is how a talk covering a span is
 * found by any reference inside it. On screen a span reads as a span.
 */
export function trackName(hit: DiscoveryHit): string {
  const named = hit.title?.trim()
  if (named) return named

  const span = referenceSpan(hit.references ?? [])
  if (span) return span

  // A recording with neither a name nor a passage still has a day and a
  // speaker, and those are already beside it. Better an empty line than a URL.
  return ""
}

/** "SB 7.5.33" … "SB 7.5.37" reads as "SB 7.5.33–37". */
function referenceSpan(refs: readonly string[]): string {
  if (refs.length === 0) return ""
  const first = refs[0]
  if (refs.length === 1) return first

  const last = refs[refs.length - 1]
  const cut = first.lastIndexOf(".")
  if (cut > 0 && last.startsWith(first.slice(0, cut + 1))) {
    return `${first}–${last.slice(cut + 1)}`
  }
  return first
}
