import type { IDatabase } from "@ports/app/index.js"
import type { Track } from "@lib/domain/track.js"
import type {
  TrackAudioRow,
  TrackReferenceRow,
  TrackRow,
  TrackTagRow,
  TrackTopicRow,
  TrackVariantRow,
} from "@lib/persistence/main"
import { rowToTrack } from "./contentRowMappers.js"

/** A `tracks` page, joined with the five satellite tables in one round of
 *  queries rather than per row. */
export async function hydrateTracks(
  contentDb: IDatabase,
  tracks: readonly TrackRow[]
): Promise<Track[]> {
  if (tracks.length === 0) return []
  const ids = tracks.map((t) => t.id)
  const placeholders = ids.map(() => "?").join(", ")

  const [variants, audios, references, tags, topics] = await Promise.all([
    contentDb.query<TrackVariantRow>(
      `SELECT * FROM track_variants WHERE track_id IN (${placeholders})`,
      ids
    ),
    contentDb.query<TrackAudioRow>(
      `SELECT * FROM track_audio WHERE track_id IN (${placeholders})`,
      ids
    ),
    contentDb.query<TrackReferenceRow>(
      `SELECT * FROM track_references WHERE track_id IN (${placeholders}) ORDER BY track_id, ref_idx`,
      ids
    ),
    contentDb.query<TrackTagRow>(
      `SELECT * FROM track_tags WHERE track_id IN (${placeholders})`,
      ids
    ),
    contentDb.query<TrackTopicRow>(
      `SELECT * FROM track_topics WHERE track_id IN (${placeholders})`,
      ids
    ),
  ])

  return tracks.map((track) => rowToTrack({ track, variants, audios, references, tags, topics }))
}
