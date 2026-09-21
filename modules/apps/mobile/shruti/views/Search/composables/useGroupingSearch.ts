import { computed, type ComputedRef, type Ref } from "vue"
import { resolveAssetUrl } from "@shruti/services/regionsRegistry.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useLibraryLandingStore } from "@shruti/stores/useLibraryLandingStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import {
  matchCollections,
  matchTopics,
  normalizeNeedle,
  type GroupingHit,
} from "./groupingMatch.js"

export type { GroupingHit }

/** As many as a shelf can hold before it stops being a glance. */
const SHELF_MAX = 12

export interface UseGroupingSearchReturn {
  items: ComputedRef<readonly GroupingHit[]>
}

/**
 * The two things the catalog is grouped by that a search can also match: a
 * collection and a topic.
 *
 * One shelf, not two. To somebody reading results they are the same offer —
 * "here is a ready-made set about that" — and which table it came from is our
 * business, not theirs.
 *
 * A collection GROUP is not here on purpose: it has no cover and no page of
 * its own, and what is worth finding is the collections under it.
 *
 * Matched in memory: both sets are already loaded for the landing, and a round
 * trip per keystroke would cost more than walking them.
 */
export function useGroupingSearch(query: Ref<string>): UseGroupingSearchReturn {
  const landing = useLibraryLandingStore()
  const dictionaries = useDictionariesStore()
  const appLanguage = useAppLanguage()

  const needle = computed(() => normalizeNeedle(query.value))

  const topics = computed(() =>
    dictionaries.topics.map((topic) => ({
      id: topic.id,
      shortName: dictionaries.topicShortNamesById.get(topic.id) ?? "",
      fullName: topic.names.get(appLanguage.value) ?? "",
      coverUrl: topic.cover ? resolveAssetUrl(topic.cover) : undefined,
    }))
  )

  const items = computed<readonly GroupingHit[]>(() => {
    if (!needle.value) return []
    const collections = matchCollections(landing.allCollections, needle.value, SHELF_MAX)
    const room = SHELF_MAX - collections.length
    return [...collections, ...matchTopics(topics.value, needle.value, room)]
  })

  return { items }
}
