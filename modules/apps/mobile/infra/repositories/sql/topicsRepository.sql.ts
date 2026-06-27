import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import type { Topic } from "@lib/domain/topic.js"
import type { ITopicRepository, TrackTopicWeight } from "@lib/domain/ports/topicRepository.js"
import type { TopicRow, TrackTopicRow } from "@lib/persistence/main"
import { foldDictRows, rowToTopic } from "./contentRowMappers.js"

export function createSqlTopicRepository(contentDb: IDatabase): ITopicRepository {
  return {
    async getById(id: TopicId): Promise<Topic | null> {
      const rows = await contentDb.query<TopicRow>("SELECT * FROM topics WHERE id = ?", [id])
      if (rows.length === 0) return null
      return rowToTopic(rows)
    },

    async getByIds(ids: readonly TopicId[]): Promise<readonly Topic[]> {
      if (ids.length === 0) return []
      const placeholders = ids.map(() => "?").join(", ")
      const rows = await contentDb.query<TopicRow>(
        `SELECT * FROM topics WHERE id IN (${placeholders})`,
        [...ids]
      )
      const byId = foldDictRows(rows, rowToTopic)
      // Preserve the caller's order; drop ids that resolved to nothing.
      return ids.map((id) => byId.get(id)).filter((t): t is Topic => t != null)
    },

    async listAll(): Promise<readonly Topic[]> {
      const rows = await contentDb.query<TopicRow>("SELECT * FROM topics ORDER BY id ASC")
      const byId = foldDictRows(rows, rowToTopic)
      return [...byId.values()]
    },

    async weightsForTracks(trackIds: readonly TrackId[]): Promise<readonly TrackTopicWeight[]> {
      if (trackIds.length === 0) return []
      const placeholders = trackIds.map(() => "?").join(", ")
      const rows = await contentDb.query<TrackTopicRow>(
        `SELECT track_id, topic_id, weight FROM track_topics WHERE track_id IN (${placeholders})`,
        [...trackIds]
      )
      return rows.map((r) => ({ trackId: r.track_id, topicId: r.topic_id, weight: r.weight }))
    },

    async topTrackIds(
      topicId: TopicId,
      languages: readonly LanguageCode[],
      limit: number,
      opts?: { lecturesOnly?: boolean; withReference?: boolean }
    ): Promise<readonly TrackId[]> {
      // Restrict to tracks that have a variant in one of the user's library
      // languages, so a topic page never surfaces lectures they can't read.
      // EXISTS (not a JOIN) so a track with several matching variants stays one
      // row. Empty `languages` = no filter (show every track on the topic).
      // `lecturesOnly` drops kind-tagged tracks (a track carries at most one tag,
      // so "no track_tags row" == a plain lecture). `withReference` keeps only
      // tracks tied to a scripture verse (a class on a specific śloka). Both are
      // used by the onboarding pick, which wants the strongest lectures.
      const extra = [
        opts?.lecturesOnly === true
          ? `AND NOT EXISTS (SELECT 1 FROM track_tags tg WHERE tg.track_id = tt.track_id)`
          : ``,
        opts?.withReference === true
          ? `AND EXISTS (SELECT 1 FROM track_references tr WHERE tr.track_id = tt.track_id)`
          : ``,
      ].join("\n            ")
      const lectureClause = extra
      if (languages.length === 0) {
        const rows = await contentDb.query<{ track_id: string }>(
          `SELECT tt.track_id
             FROM track_topics tt
            WHERE tt.topic_id = ?
              ${lectureClause}
            ORDER BY tt.weight DESC
            LIMIT ?`,
          [topicId, limit]
        )
        return rows.map((r) => r.track_id)
      }
      const langPh = languages.map(() => "?").join(", ")
      const rows = await contentDb.query<{ track_id: string }>(
        `SELECT tt.track_id
           FROM track_topics tt
          WHERE tt.topic_id = ?
            AND EXISTS (
              SELECT 1 FROM track_variants tv
               WHERE tv.track_id = tt.track_id AND tv.language IN (${langPh})
            )
            ${lectureClause}
          ORDER BY tt.weight DESC
          LIMIT ?`,
        [topicId, ...languages, limit]
      )
      return rows.map((r) => r.track_id)
    },

    async topicIdsWithTracksIn(languages: readonly LanguageCode[]): Promise<readonly TopicId[]> {
      if (languages.length === 0) {
        const rows = await contentDb.query<{ topic_id: string }>(
          `SELECT DISTINCT topic_id FROM track_topics`
        )
        return rows.map((r) => r.topic_id as TopicId)
      }
      const langPh = languages.map(() => "?").join(", ")
      const rows = await contentDb.query<{ topic_id: string }>(
        `SELECT DISTINCT tt.topic_id
           FROM track_topics tt
          WHERE EXISTS (
            SELECT 1 FROM track_variants tv
             WHERE tv.track_id = tt.track_id AND tv.language IN (${langPh})
          )`,
        [...languages]
      )
      return rows.map((r) => r.topic_id as TopicId)
    },

    async similarTrackIds(
      topicIds: readonly TopicId[],
      excludeTrackId: TrackId,
      languages: readonly LanguageCode[],
      limit: number
    ): Promise<readonly TrackId[]> {
      if (topicIds.length === 0) return []
      const topicPh = topicIds.map(() => "?").join(", ")
      // EXISTS keeps SUM(weight) honest — a JOIN to track_variants would
      // multiply a track's row per matching variant and inflate its score.
      const langClause =
        languages.length === 0
          ? ""
          : `AND EXISTS (SELECT 1 FROM track_variants tv
               WHERE tv.track_id = tt.track_id AND tv.language IN (${languages
                 .map(() => "?")
                 .join(", ")}))`
      const rows = await contentDb.query<{ track_id: string }>(
        `SELECT tt.track_id
           FROM track_topics tt
          WHERE tt.topic_id IN (${topicPh}) AND tt.track_id != ?
            ${langClause}
          GROUP BY tt.track_id
          ORDER BY SUM(tt.weight) DESC
          LIMIT ?`,
        [...topicIds, excludeTrackId, ...languages, limit]
      )
      return rows.map((r) => r.track_id)
    },
  }
}
