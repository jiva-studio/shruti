import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import type { ITopicRepository } from "@lib/domain/ports/topicRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"

export interface ListSimilarTracksByTopicInput {
  /** The seed track — its first `seedTopics` topics drive the similarity. */
  readonly track: Pick<Track, "id" | "topicIds">
  /** How many of the track's topics to use as the similarity seed. */
  readonly seedTopics: number
  /** Restrict neighbours to these library languages (empty = no filter). */
  readonly languages: readonly LanguageCode[]
  /** Max neighbours to return. */
  readonly limit: number
}

export interface ListSimilarTracksByTopicDeps {
  readonly topics: Pick<ITopicRepository, "similarTrackIds">
  readonly tracks: Pick<ITrackRepository, "getByIds">
}

/**
 * "Similar by topic" row: neighbours of a track scored by topic overlap,
 * excluding the seed, resolved to full tracks in similarity order. Returns
 * empty when the track has no topics or has no neighbours.
 *
 * Extracted from SimilarTracksRow.vue so the seed/limit/order rule is testable
 * and the component only wires reactivity.
 */
export async function listSimilarTracksByTopic(
  input: ListSimilarTracksByTopicInput,
  deps: ListSimilarTracksByTopicDeps
): Promise<readonly Track[]> {
  const seedTopics = input.track.topicIds.slice(0, input.seedTopics) as TopicId[]
  if (seedTopics.length === 0) return []
  const ids = await deps.topics.similarTrackIds(
    seedTopics,
    input.track.id as TrackId,
    input.languages,
    input.limit
  )
  if (ids.length === 0) return []
  const byId = await deps.tracks.getByIds([...ids])
  return ids.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
}
