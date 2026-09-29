import type { Author } from "@lib/domain/author.js"
import type { AuthorId, LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import type { IAuthorRepository } from "@lib/domain/ports/authorRepository.js"
import type { ITopicRepository } from "@lib/domain/ports/topicRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"

/**
 * Single reads from the content catalog, for callers that need one entity and
 * nothing composed around it.
 */

export function findTrack(
  id: TrackId,
  deps: { readonly tracks: ITrackRepository }
): Promise<Track | null> {
  return deps.tracks.getById(id)
}

/** One batched read; ids the catalog does not carry are absent from the map. */
export function findTracks(
  ids: readonly TrackId[],
  deps: { readonly tracks: ITrackRepository }
): Promise<ReadonlyMap<TrackId, Track>> {
  return deps.tracks.getByIds(ids)
}

/** A topic's most-listened lecture ids in the given languages. */
export function listTopicTrackIds(
  topicId: TopicId,
  languages: readonly LanguageCode[],
  limit: number,
  deps: { readonly topics: ITopicRepository }
): Promise<readonly TrackId[]> {
  return deps.topics.topTrackIds(topicId, languages, limit)
}

export function findAuthor(
  id: AuthorId,
  deps: { readonly authors: IAuthorRepository }
): Promise<Author | null> {
  return deps.authors.getById(id)
}
