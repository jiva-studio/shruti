import {
  preferredContentLanguage,
  resolveLocalizedName,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import { formatReference } from "@lib/domain/services/references.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Author } from "@lib/domain/author.js"
import type { Track } from "@lib/domain/track.js"

/** Resolved, UI-localized attribution for one cited track — the same
 *  fields `CitationCard.vue` renders, in a flat shape the markdown export
 *  can drop straight into its source line. */
export interface CitationMeta {
  readonly trackTitle: string
  readonly authorName: string
  readonly reference: string
  readonly trackDate: string
}

/**
 * The title follows the content language (a library language the track has),
 * not the UI language, which still drives the author and reference labels.
 */
export function formatCitationMeta(
  entry: { track: Track | null; author: Author | null },
  lc: LanguageCode,
  libraryLanguages: readonly string[],
  sourcesById: Parameters<typeof formatReference>[1]
): CitationMeta {
  const { track, author } = entry
  const first = track?.references?.[0]
  const contentLang = track ? (preferredContentLanguage(track, libraryLanguages, lc) ?? lc) : lc
  return {
    trackTitle: resolveTrackTitle(track, contentLang) ?? "",
    authorName: resolveLocalizedName(author, lc) ?? "",
    reference: first ? formatReference(first, sourcesById, lc) : "",
    trackDate: track?.date || "",
  }
}
