import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import type { Track } from "@lib/domain/track.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"
import { groupReferences } from "./groupReferences.js"
import { resolveLocalizedNameOrEmpty, resolveTrackTitle } from "./resolveLocalized.js"

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
  /**
   * Render the row as visibly disabled and non-interactive. Controllers
   * set this while a track is mid-load (e.g. `player.openTrack` in
   * flight) so a second tap on the same row doesn't queue another open.
   */
  readonly disabled?: boolean
  /** Visual dim only (opacity). Keeps the row tappable — used for the
   *  failed-download state so the user can retry. */
  readonly dimmed?: boolean
}

/**
 * Flattens a domain Track into the verbatim legacy UI row shape:
 * picks the best variant for the preferred language, resolves author +
 * location localised names, formats references as display strings with
 * localised source short-names.
 */
export function buildTrackRow(track: Track, deps: BuildTrackRowDeps): UiTrackRow {
  const title = resolveTrackTitle(track, deps.preferredLanguage) ?? track.id
  const author = track.authorId ? deps.authorsById.get(track.authorId) : null
  const authorName = resolveLocalizedNameOrEmpty(author, deps.preferredLanguage)
  const location = track.locationId ? deps.locationsById?.get(track.locationId) : null
  const locationName = resolveLocalizedNameOrEmpty(location, deps.preferredLanguage)

  const references = groupReferences(track.references, deps.sourcesById, deps.preferredLanguage)
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
    disabled: deps.disabled ?? false,
    dimmed: deps.dimmed ?? false,
  }
}
