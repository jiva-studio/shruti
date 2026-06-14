import { ref, watch, type Ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"

/** One collection card within a group. */
export interface GroupCollection {
  readonly id: string
  readonly name: string
  readonly coverUrl?: string
  readonly description?: string
}

/** A named group (shelf) with its ordered collections, ready to render. */
export interface CollectionGroupView {
  readonly id: string
  readonly name: string
  readonly collections: readonly GroupCollection[]
}

export interface UseCollectionGroupsReturn {
  readonly groups: Ref<readonly CollectionGroupView[]>
  /** All collections for the locale (flat, sort_order), for the "others" list. */
  readonly allCollections: Ref<readonly GroupCollection[]>
}

/**
 * Reactive list of collection groups (shelves) for the active locale — each
 * with its ordered collections and resolved cover URLs. Drives the Search-page
 * browse surface. Empty/missing tables degrade to []. Groups with no
 * collections are dropped so the page shows no empty shelves.
 */
export function useCollectionGroups(locale: Ref<string>): UseCollectionGroupsReturn {
  const app = useLectorium()
  const groups = ref<readonly CollectionGroupView[]>([])
  const allCollections = ref<readonly GroupCollection[]>([])

  async function load(currentLocale: string): Promise<void> {
    try {
      const repos = app.repositories()
      const [headers, flat] = await Promise.all([
        repos.collections.listGroups(currentLocale),
        repos.collections.listCollections(currentLocale),
      ])
      const built = await Promise.all(
        headers.map(async (g) => {
          const cols = await repos.collections.getGroupCollections(g.id, currentLocale)
          const collections = cols.map((c) => ({
            id: c.id,
            name: c.name,
            coverUrl: resolveAssetUrl(c.cover),
          }))
          return { id: g.id, name: g.name, collections }
        })
      )
      groups.value = built.filter((g) => g.collections.length > 0)
      allCollections.value = flat.map((c) => ({
        id: c.id,
        name: c.name,
        coverUrl: resolveAssetUrl(c.cover),
        description: c.description,
      }))
    } catch (err) {
      console.warn("[collection-groups] load failed", err)
      groups.value = []
      allCollections.value = []
    }
  }

  watch(
    locale,
    (value) => {
      void load(value)
    },
    { immediate: true }
  )

  return { groups, allCollections }
}
