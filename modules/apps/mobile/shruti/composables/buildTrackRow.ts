import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import type { Tag } from "@lib/domain/tag.js"
import type { Track } from "@lib/domain/track.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"
import { groupReferences } from "@lib/domain/services/references.js"
import { formatTrackDate } from "@lib/domain/services/trackDate.js"
import {
  preferredContentLanguage,
  resolveLocalizedName,
  resolveLocalizedNameOrEmpty,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import { resolveTrackAuthorName } from "@lib/domain/services/trackAuthor.js"

export interface BuildTrackRowDeps {
  /** UI language — used only for the locale-formatted date. Author/location/
   *  source/tag labels follow the lecture's CONTENT language (see
   *  `contentLanguages`) so a row reads in one language, not three. */
  readonly preferredLanguage: LanguageCode
  /** The user's library languages — drive the lecture TITLE *and* its metadata
   *  labels (author/location/source/tags) so a lecture surfaced in Russian reads
   *  fully in Russian. Empty → everything follows the track's own variant
   *  language. */
  readonly contentLanguages: readonly LanguageCode[]
  readonly authorsById: ReadonlyMap<string, Author>
  readonly locationsById?: ReadonlyMap<string, Location>
  readonly sourcesById?: ReadonlyMap<string, Source>
  /** Tags keyed by id — resolved to the track's content language. Used as the
   *  chip fallback when a track has no scripture references. */
  readonly tagsById?: ReadonlyMap<string, Tag>
  /** Optional per-track state override (playlist/downloader state). */
  readonly state?: UiTrackState
  /**
   * 0..100 radial value. Meaning depends on `state`: "downloading" → download %,
   * "playing"/"queued" → playback %. Controller picks the right value per state.
   */
  readonly progressPct?: number
  /** 0..100 of the lecture the user has listened to, independent of any
   *  transfer state the row is showing. See `UiTrackRow.listenedPct`. */
  readonly listenedPct?: number
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

// A personal-library track's location may be a raw label with no corpus entity.
function resolveLocationName(
  track: Track,
  locationsById: ReadonlyMap<string, Location> | undefined,
  lang: LanguageCode
): string {
  const location = track.locationId ? locationsById?.get(track.locationId) : null
  return resolveLocalizedNameOrEmpty(location, lang) || track.locationRaw?.trim() || ""
}

function resolveTagLabels(
  track: Track,
  tagsById: ReadonlyMap<string, Tag> | undefined,
  lang: LanguageCode
): string[] {
  if (!tagsById) return []
  const labels: string[] = []
  for (const id of track.tagIds) {
    const tag = tagsById.get(id)
    const label = tag ? resolveLocalizedName(tag, lang) : undefined
    if (label) labels.push(label)
  }
  return labels
}

/**
 * Title AND metadata labels follow the CONTENT language (the library language
 * this track has), so a lecture surfaced in Russian reads fully in Russian even
 * on an English UI. Only the date stays on the UI language.
 */
function resolveTrackLabels(track: Track, deps: BuildTrackRowDeps) {
  const contentLang =
    preferredContentLanguage(track, deps.contentLanguages, deps.preferredLanguage) ??
    deps.preferredLanguage
  const author = track.authorId ? deps.authorsById.get(track.authorId) : null
  const durationMs = maxAudioDurationMs(track)
  return {
    title: resolveTrackTitle(track, contentLang) ?? track.id,
    // Author resolution is shared with the native player queue so the two
    // can't drift apart.
    author: resolveTrackAuthorName(track, author ?? null, contentLang),
    location: resolveLocationName(track, deps.locationsById, contentLang),
    date: formatTrackDate(track.date ?? "", deps.preferredLanguage),
    references: groupReferences(track.references, deps.sourcesById, contentLang),
    tags: resolveTagLabels(track, deps.tagsById, contentLang),
    // 0 (no playable audio) collapses to undefined so the duration field
    // renders nothing rather than a bogus "0m".
    duration: durationMs > 0 ? deps.formatDuration?.(durationMs) : undefined,
  }
}

/**
 * Flattens a domain Track into the verbatim legacy UI row shape:
 * picks the best variant for the preferred language, resolves author +
 * location localised names, formats references as display strings with
 * localised source short-names.
 */
export function buildTrackRow(track: Track, deps: BuildTrackRowDeps): UiTrackRow {
  return {
    id: track.id,
    ...resolveTrackLabels(track, deps),
    state: deps.state ?? "none",
    progressPct: deps.progressPct ?? 0,
    listenedPct: deps.listenedPct,
    disabled: deps.disabled ?? false,
    dimmed: deps.dimmed ?? false,
  }
}
