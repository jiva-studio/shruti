import type { Author } from "@lib/domain/author.js"
import type { AuthorId, LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import type { Language } from "@lib/domain/language.js"
import type { Track } from "@lib/domain/track.js"
import {
  findAuthor,
  findTrack,
  findTracks,
  listTopicTrackIds,
} from "@usecases/catalog/catalogLookups.js"
import {
  listContentLanguages,
  loadDictionaries,
  type Dictionaries,
} from "@usecases/catalog/loadDictionaries.js"
import {
  buildRecommendations,
  type BuildRecommendationsInput,
  type BuildRecommendationsResult,
} from "@usecases/discovery/buildRecommendations.js"
import {
  searchAndFilterTracks,
  type SearchAndFilterTracksInput,
} from "@usecases/discovery/searchAndFilterTracks.js"
import { useShruti } from "@shruti/shruti.js"

export interface CatalogUseCases {
  findTrack(id: TrackId): Promise<Track | null>
  findTracks(ids: readonly TrackId[]): Promise<ReadonlyMap<TrackId, Track>>
  findAuthor(id: AuthorId): Promise<Author | null>
  listTopicTrackIds(
    topicId: TopicId,
    languages: readonly LanguageCode[],
    limit: number
  ): Promise<readonly TrackId[]>
  searchTracks(input: SearchAndFilterTracksInput): Promise<readonly Track[]>
  loadDictionaries(): Promise<Dictionaries>
  listContentLanguages(): Promise<readonly Language[]>
  buildRecommendations(input: BuildRecommendationsInput): Promise<BuildRecommendationsResult>
}

/** Catalog reads, bound to the repositories, which are resolved per call and
 *  so throw until the databases are open. */
export function useCatalogUseCases(): CatalogUseCases {
  const app = useShruti()
  return {
    findTrack: (id) => findTrack(id, app.repositories()),
    findTracks: (ids) => findTracks(ids, app.repositories()),
    findAuthor: (id) => findAuthor(id, app.repositories()),
    listTopicTrackIds: (topicId, languages, limit) =>
      listTopicTrackIds(topicId, languages, limit, app.repositories()),
    searchTracks: (input) => searchAndFilterTracks(input, app.repositories()),
    loadDictionaries: () => loadDictionaries(app.repositories()),
    listContentLanguages: () => listContentLanguages(app.repositories()),
    buildRecommendations: (input) => buildRecommendations(input, app.repositories()),
  }
}
