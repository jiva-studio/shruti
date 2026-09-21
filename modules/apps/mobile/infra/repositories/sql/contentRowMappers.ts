import type { Author } from "@lib/domain/author.js"
import type { Language } from "@lib/domain/language.js"
import type { Location } from "@lib/domain/location.js"
import type { Reference } from "@lib/domain/reference.js"
import type { Source } from "@lib/domain/source.js"
import type { Tag } from "@lib/domain/tag.js"
import type { Topic } from "@lib/domain/topic.js"
import type { Track } from "@lib/domain/track.js"
import type {
  TrackAudio,
  TrackAudioKind,
  TrackOutlineChapter,
  TrackVariant,
  TrackVariantKind,
} from "@lib/domain/trackVariant.js"
import { pickPlayableAudio } from "@lib/domain/trackVariant.js"
import type {
  AuthorRow,
  LanguageRow,
  LocationRow,
  SourceRow,
  TagRow,
  TopicRow,
  TrackAudioRow,
  TrackReferenceRow,
  TrackRow,
  TrackTagRow,
  TrackTopicRow,
  TrackVariantRow,
} from "@lib/persistence/main"

/**
 * Row-to-entity mappers for the content DB. Only functions allowed to
 * know about snake_case and NULL-vs-undefined boundaries between SQL
 * and the domain. The dict tables are flat — one row per locale — so
 * the `rowToX(rows)` mappers take the full per-id set and fold them
 * into a single entity with a `Map<lang, name>`.
 */

// Runs during every list/search hydration via rowToTrack; an unexpected enum
// value from the catalog DB must not crash the whole list, so fall back to
// "original" rather than throwing (mirrors narrowAudioKind below).
function narrowVariantKind(raw: string | null): TrackVariantKind | null {
  if (raw === null) return null
  if (raw === "original" || raw === "generated" || raw === "edited") return raw
  return "original"
}

// Audio kind is a display-preference field; an unexpected value must not crash
// list hydration, so fall back to "original" rather than throwing.
export function narrowAudioKind(raw: string): TrackAudioKind {
  return raw === "clean" ? "clean" : "original"
}

export function rowToAuthor(rows: readonly AuthorRow[]): Author {
  const byLanguage = new Map<string, string>()
  for (const r of rows) byLanguage.set(r.language, r.full_name)
  return { id: rows[0].id, names: byLanguage }
}

export function rowToLocation(rows: readonly LocationRow[]): Location {
  const byLanguage = new Map<string, string>()
  for (const r of rows) byLanguage.set(r.language, r.full_name)
  return { id: rows[0].id, names: byLanguage }
}

export function rowToSource(rows: readonly SourceRow[]): Source {
  const byLanguage = new Map<string, { fullName: string; shortName: string }>()
  for (const r of rows) {
    byLanguage.set(r.language, { fullName: r.full_name, shortName: r.short_name })
  }
  return { id: rows[0].id, names: byLanguage }
}

export function rowToLanguage(row: LanguageRow): Language {
  return { code: row.code, fullName: row.full_name, icon: row.icon }
}

export function rowToTag(rows: readonly TagRow[]): Tag {
  const byLanguage = new Map<string, string>()
  for (const r of rows) byLanguage.set(r.language, r.full_name)
  return { id: rows[0].id, names: byLanguage }
}

export function rowToTopic(rows: readonly TopicRow[]): Topic {
  const names = new Map<string, string>()
  const shortNames = new Map<string, string>()
  let cover: string | null = null
  for (const r of rows) {
    names.set(r.language, r.full_name)
    if (r.short_name) shortNames.set(r.language, r.short_name)
    if (!cover && r.cover) cover = r.cover
  }
  return { id: rows[0].id, names, shortNames, cover }
}

/**
 * Fold a list of dict rows (which may contain rows for many ids) into a
 * map `id → entity`. Used by `listAll()` implementations.
 */
export function foldDictRows<R extends { id: string }, E>(
  rows: readonly R[],
  build: (rowsForId: readonly R[]) => E
): Map<string, E> {
  const byId = new Map<string, R[]>()
  for (const r of rows) {
    const bucket = byId.get(r.id)
    if (bucket) bucket.push(r)
    else byId.set(r.id, [r])
  }
  const result = new Map<string, E>()
  for (const [id, bucket] of byId) result.set(id, build(bucket))
  return result
}

export function rowToTrackVariant(
  row: TrackVariantRow,
  audioRows: readonly TrackAudioRow[]
): TrackVariant {
  const audios: TrackAudio[] = audioRows
    .filter((a) => a.track_id === row.track_id && a.language === row.language)
    .map((a) => ({
      path: a.path,
      filesize: a.filesize,
      // DB and domain are both in milliseconds.
      duration: a.duration ?? null,
      kind: narrowAudioKind(a.kind),
    }))
  return {
    trackId: row.track_id,
    language: row.language,
    title: row.title,
    audios,
    audio: pickPlayableAudio(audios),
    transcript: row.transcript_path
      ? {
          path: row.transcript_path,
          kind: narrowVariantKind(row.transcript_kind) ?? "original",
        }
      : null,
    outline: parseOutline(row.outline),
    description: row.description ?? null,
  }
}

const numberOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null)

/** One outline entry, or null when it lacks a title or a usable span. A
 *  missing or non-numeric end would collapse to a zero-length [start, start)
 *  chapter that the "chapter at time T" lookup never matches. */
/** One stored outline entry as a domain chapter, or null when it is not one:
 *  a blank title, a non-numeric bound, or a span that ends where it starts or
 *  earlier — a chapter the at-time-T lookup could never match. */
export function readOutlineChapter(entry: unknown): TrackOutlineChapter | null {
  if (entry == null || typeof entry !== "object") return null
  const e = entry as Record<string, unknown>
  const title = typeof e.title === "string" ? e.title.trim() : ""
  const startMs = numberOrNull(e.start)
  const endMs = numberOrNull(e.end)
  if (!title || startMs === null) return null
  if (endMs === null || endMs <= startMs) return null
  return { title, startMs, endMs }
}

/** The catalog's raw outline JSON (`[{title,start,end}]` in ms) as domain
 *  chapters; null when absent, malformed or empty. */
export function parseOutline(raw: string | null): readonly TrackOutlineChapter[] | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out = parsed.map(readOutlineChapter).filter((c): c is TrackOutlineChapter => c !== null)
  return out.length > 0 ? out : null
}

export interface TrackAssemblyParts {
  track: TrackRow
  variants: readonly TrackVariantRow[]
  audios: readonly TrackAudioRow[]
  references: readonly TrackReferenceRow[]
  tags: readonly TrackTagRow[]
  topics: readonly TrackTopicRow[]
}

export function rowToTrack(parts: TrackAssemblyParts): Track {
  const { track } = parts
  const variants = parts.variants
    .filter((v) => v.track_id === track.id)
    .map((v) => rowToTrackVariant(v, parts.audios))
  const references: Reference[] = parts.references
    .filter((r) => r.track_id === track.id)
    .sort((a, b) => a.ref_idx - b.ref_idx)
    .map((r) => ({
      sourceId: r.source_id,
      tokens: r.tokens.length > 0 ? r.tokens.split(".") : [],
    }))
  const tagIds = parts.tags.filter((t) => t.track_id === track.id).map((t) => t.tag_id)
  const topicIds = parts.topics
    .filter((t) => t.track_id === track.id)
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((t) => t.topic_id)
  return {
    id: track.id,
    authorId: track.author_id,
    locationId: track.location_id,
    date: track.date,
    hidden: track.hidden !== 0,
    references,
    tagIds,
    topicIds,
    variants,
  }
}
