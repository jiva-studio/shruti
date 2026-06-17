import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import type { Track } from "@lib/domain/track.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"
import { groupReferences } from "@lib/domain/services/references.js"
import { formatTrackDate } from "./formatTrackDate.js"
import {
  preferredContentLanguage,
  resolveLocalizedNameOrEmpty,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"

export interface BuildTrackRowDeps {
  /** UI language — drives LABELS: author/location/source names, date, ref
   *  prefixes. Not the lecture title (see `contentLanguages`). */
  readonly preferredLanguage: LanguageCode
  /** The user's library languages — drive the lecture TITLE so it matches the
   *  language the track was surfaced in. Empty → title follows preferredLanguage. */
  readonly contentLanguages: readonly LanguageCode[]
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
  /** Formats a ms duration into a rounded, localised label ("47m" /
   *  "1h 23m"). Injected so this stays free of the i18n runtime; omit it
   *  and the duration field renders nothing. */
  readonly formatDuration?: (ms: number) => string
}

/**
 * Flattens a domain Track into the verbatim legacy UI row shape:
 * picks the best variant for the preferred language, resolves author +
 * location localised names, formats references as display strings with
 * localised source short-names.
 */
export function buildTrackRow(track: Track, deps: BuildTrackRowDeps): UiTrackRow {
  // Title follows the content language (the library language this track has),
  // so a lecture surfaced in Russian reads in Russian even on an English UI.
  // Labels below stay on the UI language.
  const contentLang =
    preferredContentLanguage(track, deps.contentLanguages, deps.preferredLanguage) ??
    deps.preferredLanguage
  const title = resolveTrackTitle(track, contentLang) ?? track.id
  const author = track.authorId ? deps.authorsById.get(track.authorId) : null
  const authorName = resolveLocalizedNameOrEmpty(author, deps.preferredLanguage)
  const location = track.locationId ? deps.locationsById?.get(track.locationId) : null
  const locationName = resolveLocalizedNameOrEmpty(location, deps.preferredLanguage)

  const references = groupReferences(track.references, deps.sourcesById, deps.preferredLanguage)
  // 0 (no playable audio) collapses to undefined so the duration field
  // just renders nothing rather than a bogus "0m".
  const durationMs = maxAudioDurationMs(track)
  const duration =
    durationMs > 0 && deps.formatDuration ? deps.formatDuration(durationMs) : undefined
  const tagDisplay =
    deps.tagNamesById && track.tagIds.length > 0
      ? track.tagIds.map((id) => deps.tagNamesById?.get(id)).filter((v): v is string => Boolean(v))
      : []

  return {
    id: track.id,
    title,
    author: authorName,
    location: locationName,
    date: formatTrackDate(track.date ?? "", deps.preferredLanguage),
    references,
    tags: tagDisplay,
    duration,
    state: deps.state ?? "none",
    progressPct: deps.progressPct ?? 0,
    disabled: deps.disabled ?? false,
    dimmed: deps.dimmed ?? false,
  }
}
