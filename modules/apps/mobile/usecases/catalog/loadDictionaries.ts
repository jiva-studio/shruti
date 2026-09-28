import type { Author } from "@lib/domain/author.js"
import type { Language } from "@lib/domain/language.js"
import type { Location } from "@lib/domain/location.js"
import type { IAuthorRepository } from "@lib/domain/ports/authorRepository.js"
import type { ILanguageRepository } from "@lib/domain/ports/languageRepository.js"
import type { ILocationRepository } from "@lib/domain/ports/locationRepository.js"
import type { ISourceRepository } from "@lib/domain/ports/sourceRepository.js"
import type { ITagRepository } from "@lib/domain/ports/tagRepository.js"
import type { ITopicRepository } from "@lib/domain/ports/topicRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Source } from "@lib/domain/source.js"
import type { Tag } from "@lib/domain/tag.js"
import type { Topic } from "@lib/domain/topic.js"

export interface DictionariesDeps {
  readonly authors: IAuthorRepository
  readonly languages: ILanguageRepository
  readonly locations: ILocationRepository
  readonly sources: ISourceRepository
  readonly tags: ITagRepository
  readonly topics: ITopicRepository
  readonly tracks: ITrackRepository
}

/** The catalog's lookup lists, as the filters and the rows label things. */
export interface Dictionaries {
  readonly authors: readonly Author[]
  /** Only the languages some lecture is in. */
  readonly languages: readonly Language[]
  readonly locations: readonly Location[]
  readonly sources: readonly Source[]
  readonly tags: readonly Tag[]
  readonly topics: readonly Topic[]
  /** Calendar years present in the catalog, newest first. */
  readonly years: readonly number[]
}

/** Every lookup list, read in parallel. */
export async function loadDictionaries(deps: DictionariesDeps): Promise<Dictionaries> {
  const [authors, languages, locations, sources, tags, topics, years] = await Promise.all([
    deps.authors.listAll(),
    deps.languages.listWithTracks(),
    deps.locations.listAll(),
    deps.sources.listAll(),
    deps.tags.listAll(),
    deps.topics.listAll(),
    deps.tracks.listYears(),
  ])
  return { authors, languages, locations, sources, tags, topics, years }
}

/** The languages some lecture is in. */
export function listContentLanguages(deps: {
  readonly languages: ILanguageRepository
}): Promise<readonly Language[]> {
  return deps.languages.listWithTracks()
}
