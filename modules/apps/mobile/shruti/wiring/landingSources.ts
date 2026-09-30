import { resolveAssetUrl } from "@shruti/services/regionsRegistry.js"
import {
  loadAllowedTopicIds,
  loadCollections,
  loadLectureCount,
  loadLecturePool,
  type CollectionsResult,
} from "@usecases/catalog/loadLandingSections.js"
import type { AppRepositories } from "@shruti/repositories.js"
import { useShruti } from "@shruti/shruti.js"
import type { Track } from "@lib/domain/track.js"
import type { LanguageCode, TopicId } from "@lib/domain/core.js"

export type { CollectionGroupView, GroupCollection } from "@usecases/catalog/loadLandingSections.js"

/** The Search landing's reads, bound to one repository bundle. */
export interface LandingSources {
  collections(locale: string): Promise<CollectionsResult>
  lecturePool(languages: readonly LanguageCode[]): Promise<readonly Track[]>
  lectureCount(languages: readonly LanguageCode[]): Promise<number | null>
  allowedTopicIds(languages: readonly LanguageCode[]): Promise<ReadonlySet<TopicId> | null>
}

/**
 * Bind the landing's reads to the repositories, or answer `null` while the
 * databases are not open yet — on a fresh or cleared start they open after
 * the landing first asks.
 */
export function useLandingSources(): () => LandingSources | null {
  const app = useShruti()
  return () => {
    let repos: AppRepositories
    try {
      repos = app.repositories()
    } catch {
      return null
    }
    return {
      collections: (locale) =>
        loadCollections(locale, { collections: repos.collections, resolveAssetUrl }),
      lecturePool: (languages) => loadLecturePool(languages, repos),
      lectureCount: (languages) => loadLectureCount(languages, repos),
      allowedTopicIds: (languages) => loadAllowedTopicIds(languages, repos),
    }
  }
}
