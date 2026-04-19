/**
 * Primitive id and code types used across domain entities.
 *
 * Nominal typing is avoided here (no branded types) to keep construction
 * and test data ergonomic. The discipline is that every string passing
 * across layer boundaries as "an id" carries its type in the variable /
 * parameter name, not the value.
 */

export type TrackId = string
export type AuthorId = string
export type LocationId = string
export type SourceId = string
export type TagId = string
export type NoteId = string
export type PlaylistItemId = string
export type MediaItemId = string

/** ISO-639 code, e.g. "ru", "en", "hi". */
export type LanguageCode = string

/** ISO date "YYYY-MM-DD", or null when date is unknown. */
export type IsoDate = string | null

/** Unix time in milliseconds. */
export type UnixMs = number
