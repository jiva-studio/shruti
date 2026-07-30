import type { Author } from "../author.js"
import type { LanguageCode } from "../core.js"
import type { Track } from "../track.js"
import { resolveLocalizedNameOrEmpty } from "./localizedName.js"

/**
 * The author's display name for a track in `lang`: the resolved corpus-author
 * entity's localized name, falling back to the raw author label a
 * personal-library track carries when the author is not a corpus entity
 * (`authorId` null). Empty string when neither resolves.
 *
 * Shared by the playlist rows (`buildTrackRow`) and the native player queue
 * (`buildQueueFrom`) so both surfaces resolve the author identically — they had
 * drifted apart (different empty-string handling and raw fallback), which let
 * one track show a different author in the list vs. the lock screen.
 */
export function resolveTrackAuthorName(
  track: Track,
  author: Author | null,
  lang: LanguageCode
): string {
  return resolveLocalizedNameOrEmpty(author, lang) || track.authorRaw?.trim() || ""
}
