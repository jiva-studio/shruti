import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { UiTrackRow } from "@ui/features/tracks.list/index.js"

export interface BuildTrackRowDeps {
  readonly preferredLanguage: LanguageCode
  /** Authors keyed by id, for name resolution. */
  readonly authorsById: ReadonlyMap<string, Author>
}

/**
 * Flattens a domain Track into the UI row shape: picks the best variant
 * for the preferred language, resolves the author's localized name, and
 * formats the reference + date for display.
 */
export function buildTrackRow(track: Track, deps: BuildTrackRowDeps): UiTrackRow {
  const variant =
    track.variants.find((v) => v.language === deps.preferredLanguage) ?? track.variants[0]
  const title = variant?.title ?? track.id
  const durationMs = variant?.audio?.duration ?? null

  const author = track.authorId ? deps.authorsById.get(track.authorId) : null
  const authorName =
    author?.names.get(deps.preferredLanguage) ??
    author?.names.values().next().value ??
    track.authorId ??
    ""

  const reference = track.references[0]?.join(" ") ?? null

  return {
    id: track.id,
    title,
    authorName,
    date: track.date,
    durationMs,
    reference,
  }
}
