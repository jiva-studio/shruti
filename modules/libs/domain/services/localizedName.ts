import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"

/**
 * Pick a localized display string from a `names` map keyed by language.
 * Falls back to the first NON-empty map entry when the preferred language
 * is missing or empty; returns `undefined` if the entity itself is
 * undefined OR if every entry is empty. Centralizes the fallback chain we
 * duplicated in NotesView, TrackView, useTranscriptDialogController, and
 * buildTrackRow.
 */
export function resolveLocalizedName(
  entity: { names: ReadonlyMap<LanguageCode, string> } | undefined | null,
  lang: LanguageCode
): string | undefined {
  if (!entity) return undefined
  const direct = entity.names.get(lang)
  if (direct && direct.length > 0) return direct
  for (const value of entity.names.values()) {
    if (value && value.length > 0) return value
  }
  return undefined
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

/**
 * The content language to DISPLAY a track in (title / transcript / audio):
 * a library language the track actually has a variant in, else the track's own
 * first variant language. `undefined` only for a track with no variants.
 *
 * This keeps display consistent with selection — a lecture that surfaced because
 * it has a Russian variant is shown in Russian even on an English UI — while a
 * single-language track always falls back to the one language it has (so a track
 * outside the library languages, e.g. one sitting in the playlist, never renders
 * blank or in a language it doesn't have). NOT for labels (author/location/
 * source names, dates) — those follow the UI language.
 *
 * When several library languages match (both selected AND the track has both),
 * the tie is broken by `uiLanguage`: among equally-valid library languages,
 * prefer the one the user reads the interface in; otherwise the first in library
 * priority order. Selection stays 100% library-driven — the UI language only
 * orders an already-chosen set.
 */
export function preferredContentLanguage(
  track: Pick<Track, "variants">,
  libraryLanguages: readonly LanguageCode[],
  uiLanguage?: LanguageCode
): LanguageCode | undefined {
  // Library languages the track actually has, in library priority order.
  const candidates = libraryLanguages.filter((l) => track.variants.some((v) => v.language === l))
  if (candidates.length === 0) return track.variants[0]?.language
  if (uiLanguage && candidates.includes(uiLanguage)) return uiLanguage
  return candidates[0]
}
