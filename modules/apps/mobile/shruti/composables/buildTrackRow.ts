import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Location } from "@lib/domain/location.js"
import type { Reference } from "@lib/domain/reference.js"
import type { Source } from "@lib/domain/source.js"
import type { Track } from "@lib/domain/track.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"

export interface BuildTrackRowDeps {
  readonly preferredLanguage: LanguageCode
  readonly authorsById: ReadonlyMap<string, Author>
  readonly locationsById?: ReadonlyMap<string, Location>
  readonly sourcesById?: ReadonlyMap<string, Source>
  /** Tag display names keyed by tag id. Used as a fallback when a track has no references. */
  readonly tagNamesById?: ReadonlyMap<string, string>
  /** Optional per-track state override (playlist/downloader state). */
  readonly state?: UiTrackState
  /**
   * 0..100 radial value. Meaning depends on `state`: "downloading" → download %,
   * "playing"/"queued" → playback %. Controller picks the right value per state.
   */
  readonly progressPct?: number
}

/**
 * Flattens a domain Track into the verbatim legacy UI row shape:
 * picks the best variant for the preferred language, resolves author +
 * location localised names, formats references as display strings with
 * localised source short-names.
 */
export function buildTrackRow(track: Track, deps: BuildTrackRowDeps): UiTrackRow {
  const variant =
    track.variants.find((v) => v.language === deps.preferredLanguage) ?? track.variants[0]
  const title = variant?.title ?? track.id

  const author = track.authorId ? deps.authorsById.get(track.authorId) : null
  const authorName =
    author?.names.get(deps.preferredLanguage) ?? author?.names.values().next().value ?? ""

  const location = track.locationId ? deps.locationsById?.get(track.locationId) : null
  const locationName =
    location?.names.get(deps.preferredLanguage) ?? location?.names.values().next().value ?? ""

  const references = track.references.map((ref) =>
    formatReference(ref, deps.sourcesById, deps.preferredLanguage)
  )
  const tagDisplay =
    deps.tagNamesById && track.tagIds.length > 0
      ? track.tagIds.map((id) => deps.tagNamesById?.get(id)).filter((v): v is string => Boolean(v))
      : []

  return {
    id: track.id,
    title,
    author: authorName,
    location: locationName,
    date: track.date ?? "",
    references,
    tags: tagDisplay,
    state: deps.state ?? "none",
    progressPct: deps.progressPct ?? 0,
    disabled: false,
  }
}

/**
 * Renders a Reference as "{localised-short} {tokens}" — e.g. "БГ 10.5",
 * "BG 10.5". Falls back to the raw `sourceId` when no localised entry
 * exists (unknown source, empty dict, etc.).
 */
function formatReference(
  ref: Reference,
  sourcesById: ReadonlyMap<string, Source> | undefined,
  lang: LanguageCode
): string {
  const source = sourcesById?.get(ref.sourceId)
  const localised =
    source?.names.get(lang)?.shortName ??
    source?.names.values().next().value?.shortName ??
    ref.sourceId
  const tokens = ref.tokens.join(".")
  return tokens.length > 0 ? `${localised} ${tokens}` : localised
}
