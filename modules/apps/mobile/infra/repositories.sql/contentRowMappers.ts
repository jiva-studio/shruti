import type { Author } from "@lib/domain/author.js"
import type { Language } from "@lib/domain/language.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import type { Tag } from "@lib/domain/tag.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant, TrackVariantKind } from "@lib/domain/trackVariant.js"
import type {
  AuthorNameRow,
  LanguageRow,
  LocationNameRow,
  SourceNameRow,
  TagNameRow,
  TrackReferenceRow,
  TrackRow,
  TrackTagRow,
  TrackVariantRow,
} from "@lib/persistence/main"

/**
 * Row-to-entity mappers for the content DB. These are the only functions
 * allowed to know about snake_case and NULL-vs-undefined boundaries
 * between SQL and the domain.
 */

function narrowVariantKind(raw: string | null): TrackVariantKind | null {
  if (raw === null) return null
  if (raw === "original" || raw === "generated" || raw === "edited") return raw
  throw new Error(`Invalid track_variant kind: ${raw}`)
}

export function rowToAuthor(row: { id: string }, names: readonly AuthorNameRow[]): Author {
  const byLanguage = new Map<string, string>()
  for (const n of names) if (n.author_id === row.id) byLanguage.set(n.language, n.full_name)
  return { id: row.id, names: byLanguage }
}

export function rowToLocation(row: { id: string }, names: readonly LocationNameRow[]): Location {
  const byLanguage = new Map<string, string>()
  for (const n of names) if (n.location_id === row.id) byLanguage.set(n.language, n.full_name)
  return { id: row.id, names: byLanguage }
}

export function rowToSource(row: { id: string }, names: readonly SourceNameRow[]): Source {
  const byLanguage = new Map<string, { fullName: string; shortName: string }>()
  for (const n of names) {
    if (n.source_id === row.id) {
      byLanguage.set(n.language, { fullName: n.full_name, shortName: n.short_name })
    }
  }
  return { id: row.id, names: byLanguage }
}

export function rowToLanguage(row: LanguageRow): Language {
  return { code: row.code, fullName: row.full_name, icon: row.icon }
}

export function rowToTag(row: { id: string }, names: readonly TagNameRow[]): Tag {
  const byLanguage = new Map<string, string>()
  for (const n of names) if (n.tag_id === row.id) byLanguage.set(n.language, n.full_name)
  return { id: row.id, names: byLanguage }
}

export function rowToTrackVariant(row: TrackVariantRow): TrackVariant {
  return {
    trackId: row.track_id,
    language: row.language,
    title: row.title,
    audio: row.audio_path
      ? {
          path: row.audio_path,
          filesize: row.audio_filesize,
          duration: row.audio_duration,
          kind: narrowVariantKind(row.audio_kind) ?? "original",
        }
      : null,
    transcript: row.transcript_path
      ? {
          path: row.transcript_path,
          kind: narrowVariantKind(row.transcript_kind) ?? "original",
        }
      : null,
  }
}

export interface TrackAssemblyParts {
  track: TrackRow
  variants: readonly TrackVariantRow[]
  references: readonly TrackReferenceRow[]
  tags: readonly TrackTagRow[]
}

export function rowToTrack(parts: TrackAssemblyParts): Track {
  const { track } = parts
  const variants = parts.variants.filter((v) => v.track_id === track.id).map(rowToTrackVariant)
  const tokens = parts.references
    .filter((r) => r.track_id === track.id)
    .sort((a, b) => a.ord - b.ord)
    .map((r) => r.token)
  const tagIds = parts.tags.filter((t) => t.track_id === track.id).map((t) => t.tag_id)
  return {
    id: track.id,
    authorId: track.author_id,
    locationId: track.location_id,
    date: track.date,
    hidden: track.hidden !== 0,
    sortReference: track.sort_reference,
    sortDate: track.sort_date,
    references: tokens.length ? [tokens] : [],
    tagIds,
    variants,
  }
}
