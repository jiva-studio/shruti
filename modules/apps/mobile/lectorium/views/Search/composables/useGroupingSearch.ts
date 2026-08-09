import { computed, type ComputedRef, type Ref } from "vue"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useLibraryLandingStore } from "@lectorium/stores/useLibraryLandingStore.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import type { CarouselItem } from "@ui/features/collections/index.js"

/** As many as a shelf can hold before it stops being a glance. */
const SHELF_MAX = 12

/** A shelf entry, and which page opens it. */
export interface GroupingHit extends CarouselItem {
  readonly kind: "collection" | "topic"
}

export interface UseGroupingSearchReturn {
  items: ComputedRef<readonly GroupingHit[]>
}

/**
 * The two things the catalog is grouped by that a search can also match: a
 * collection and a topic.
 *
 * One shelf, not two. To somebody reading results they are the same offer —
 * "here is a ready-made set about that" — and which table it came from is our
 * business, not theirs. The "#" on a topic is the only thing that distinguishes
 * them, and it is enough.
 *
 * Both carry a cover and both already have a page, so they are shown as the
 * cards the landing shows them as. Nothing new is drawn for them.
 *
 * A collection GROUP is not here on purpose: it has no cover and no page of its
 * own — it is a heading over a shelf, and what is worth finding is the
 * collections under it, which are.
 *
 * Matched in memory rather than in SQL: there are a few dozen collections and a
 * few hundred topics, both already loaded for the landing, and a round trip to
 * the database per keystroke would cost more than walking them.
 */
export function useGroupingSearch(query: Ref<string>): UseGroupingSearchReturn {
  const landing = useLibraryLandingStore()
  const dictionaries = useDictionariesStore()
  const appLanguage = useAppLanguage()

  const needle = computed(() => query.value.trim().toLocaleLowerCase())

  const items = computed<readonly GroupingHit[]>(() => {
    if (!needle.value) return []
    const out: GroupingHit[] = []

    for (const c of landing.allCollections) {
      if (!c.name.toLocaleLowerCase().includes(needle.value)) continue
      out.push({ kind: "collection", id: c.id, name: c.name, coverUrl: c.coverUrl })
      if (out.length === SHELF_MAX) return out
    }

    for (const topic of dictionaries.topics) {
      // The short name is what a tile shows; the full one is what a person is
      // more likely to type, so both are worth matching.
      const short = dictionaries.topicShortNamesById.get(topic.id) ?? ""
      const full = topic.names.get(appLanguage.value) ?? ""
      const hay = `${short} ${full}`.toLocaleLowerCase()
      if (!hay.includes(needle.value)) continue
      out.push({
        kind: "topic",
        id: topic.id,
        // The "#" rides in the name so one shelf can hold both kinds without
        // the card having to know which it is showing.
        name: `#${short || full || topic.id}`,
        coverUrl: topic.cover ? resolveAssetUrl(topic.cover) : undefined,
      })
      if (out.length === SHELF_MAX) break
    }
    return out
  })

  return { items }
}
