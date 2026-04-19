import type { IDatabase } from "@ports/app/index.js"
import type { TrackId } from "@lib/domain/core.js"
import type {
  ITrackRepository,
  TrackListQuery,
  TrackSearchQuery,
} from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import type {
  TrackReferenceRow,
  TrackRow,
  TrackTagRow,
  TrackVariantRow,
} from "@lib/persistence/main"
import { rowToTrack } from "./contentRowMappers.js"

async function hydrate(contentDb: IDatabase, tracks: readonly TrackRow[]): Promise<Track[]> {
  if (tracks.length === 0) return []
  const ids = tracks.map((t) => t.id)
  const placeholders = ids.map(() => "?").join(", ")

  const [variants, references, tags] = await Promise.all([
    contentDb.query<TrackVariantRow>(
      `SELECT * FROM track_variants WHERE track_id IN (${placeholders})`,
      ids
    ),
    contentDb.query<TrackReferenceRow>(
      `SELECT * FROM track_references WHERE track_id IN (${placeholders})`,
      ids
    ),
    contentDb.query<TrackTagRow>(
      `SELECT * FROM track_tags WHERE track_id IN (${placeholders})`,
      ids
    ),
  ])

  return tracks.map((track) => rowToTrack({ track, variants, references, tags }))
}

function sortOrderClause(sortBy: TrackListQuery["sortBy"]): string {
  switch (sortBy) {
    case "byReference":
      return "ORDER BY t.sort_reference ASC"
    case "byDate":
    default:
      return "ORDER BY t.sort_date DESC"
  }
}

export function createSqlTrackRepository(contentDb: IDatabase): ITrackRepository {
  return {
    async getById(id: TrackId): Promise<Track | null> {
      const rows = await contentDb.query<TrackRow>(
        "SELECT * FROM tracks WHERE id = ? AND hidden = 0",
        [id]
      )
      const hydrated = await hydrate(contentDb, rows)
      return hydrated[0] ?? null
    },

    async list(query: TrackListQuery): Promise<readonly Track[]> {
      const filters = query.filters ?? {}
      const clauses: string[] = ["t.hidden = 0"]
      const params: (string | number)[] = []

      if (filters.authorIds?.length) {
        clauses.push(`t.author_id IN (${filters.authorIds.map(() => "?").join(", ")})`)
        params.push(...filters.authorIds)
      }
      if (filters.locationIds?.length) {
        clauses.push(`t.location_id IN (${filters.locationIds.map(() => "?").join(", ")})`)
        params.push(...filters.locationIds)
      }
      if (filters.tagIds?.length) {
        clauses.push(
          `t.id IN (SELECT track_id FROM track_tags WHERE tag_id IN (${filters.tagIds
            .map(() => "?")
            .join(", ")}))`
        )
        params.push(...filters.tagIds)
      }
      if (filters.languageCodes?.length) {
        clauses.push(
          `t.id IN (SELECT track_id FROM track_variants WHERE language IN (${filters.languageCodes
            .map(() => "?")
            .join(", ")}))`
        )
        params.push(...filters.languageCodes)
      }
      if (filters.durationMinMs !== undefined) {
        // Duration comes from any variant that has audio. Pick the max of
        // the per-variant durations — every variant of the same track
        // points at the same original recording for now.
        clauses.push(
          `(SELECT COALESCE(MAX(audio_duration), 0) FROM track_variants WHERE track_id = t.id) >= ?`
        )
        params.push(filters.durationMinMs)
      }
      if (filters.durationMaxMs !== undefined) {
        clauses.push(
          `(SELECT COALESCE(MAX(audio_duration), 0) FROM track_variants WHERE track_id = t.id) < ?`
        )
        params.push(filters.durationMaxMs)
      }

      const limit = query.limit ?? 50
      const offset = query.offset ?? 0

      const rows = await contentDb.query<TrackRow>(
        `SELECT t.* FROM tracks t
         WHERE ${clauses.join(" AND ")}
         ${sortOrderClause(query.sortBy)}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      )
      return hydrate(contentDb, rows)
    },

    async search(query: TrackSearchQuery): Promise<readonly Track[]> {
      const limit = query.limit ?? 50
      const offset = query.offset ?? 0
      const clauses: string[] = ["t.hidden = 0"]
      const params: (string | number)[] = []

      if (query.text && query.text.trim().length > 0) {
        clauses.push(
          `t.id IN (
             SELECT track_id FROM track_variants
             WHERE title LIKE ? COLLATE NOCASE
               ${query.language ? "AND language = ?" : ""}
           )`
        )
        params.push(`%${query.text.trim()}%`)
        if (query.language) params.push(query.language)
      }

      if (query.referenceTokens?.length) {
        // Match any track that has all the requested tokens as a
        // contiguous prefix of its first-reference tokens.
        const tokens = query.referenceTokens
        clauses.push(
          `t.id IN (
             SELECT track_id FROM track_references
             WHERE ord < ? AND token IN (${tokens.map(() => "?").join(", ")})
             GROUP BY track_id
             HAVING COUNT(DISTINCT token) >= ?
           )`
        )
        params.push(tokens.length, ...tokens, tokens.length)
      }

      const rows = await contentDb.query<TrackRow>(
        `SELECT t.* FROM tracks t
         WHERE ${clauses.join(" AND ")}
         ORDER BY t.sort_reference ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      )
      return hydrate(contentDb, rows)
    },
  }
}
