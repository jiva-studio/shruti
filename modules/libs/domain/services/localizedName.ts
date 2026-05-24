import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"

/**
 * Pick a localized display string from a `names` map keyed by language.
 * Falls back to the first map entry when the preferred language is
 * missing; returns `undefined` if the entity itself is undefined OR if
 * every entry is empty. Centralizes the fallback chain we duplicated in
 * NotesView, TrackView, useTranscriptDialogController, and buildTrackRow.
 */
export function resolveLocalizedName(
  entity: { names: ReadonlyMap<LanguageCode, string> } | undefined | null,
  lang: LanguageCode
): string | undefined {
  if (!entity) return undefined
  const direct = entity.names.get(lang)
  if (direct && direct.length > 0) return direct
  const fallback = entity.names.values().next().value
  return fallback && fallback.length > 0 ? fallback : undefined
}

/**
 * Same shape as {@link resolveLocalizedName} but returns an empty string
 * instead of `undefined` — for callers wiring UI rows where the field is
 * `string` (e.g. `UiTrackRow.author`).
 */
export function resolveLocalizedNameOrEmpty(
  entity: { names: ReadonlyMap<LanguageCode, string> } | undefined | null,
  lang: LanguageCode
): string {
  return resolveLocalizedName(entity, lang) ?? ""
}

/**
 * Pick the variant matching `lang`, falling back to the first listed
 * variant. Returns the title string or `undefined` when the track has
 * no variants OR every variant title is empty.
 */
export function resolveTrackTitle(
  track: Track | undefined | null,
  lang: LanguageCode
): string | undefined {
  if (!track || track.variants.length === 0) return undefined
  const variant = track.variants.find((v) => v.language === lang) ?? track.variants[0]
  return variant?.title && variant.title.length > 0 ? variant.title : undefined
}
