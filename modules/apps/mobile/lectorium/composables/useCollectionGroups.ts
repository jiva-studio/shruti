import { ref, watch, type Ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { getRegions } from "@lectorium/services/regionsRegistry.js"

/** One collection card within a group. */
export interface GroupCollection {
  readonly id: string
  readonly name: string
  readonly coverUrl?: string
}

/** A named group (shelf) with its ordered collections, ready to render. */
export interface CollectionGroupView {
  readonly id: string
  readonly name: string
  readonly collections: readonly GroupCollection[]
}

export interface UseCollectionGroupsReturn {
  readonly groups: Ref<readonly CollectionGroupView[]>
}

function coverUrl(cover: string): string | undefined {
  if (!cover) return undefined
  const region = getRegions()[0]
  return region ? buildServerUrl(region, cover) : undefined
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

  async function load(currentLocale: string): Promise<void> {
    try {
      const repos = app.repositories()
      const headers = await repos.collections.listGroups(currentLocale)
      const built = await Promise.all(
        headers.map(async (g) => {
          const cols = await repos.collections.getGroupCollections(g.id, currentLocale)
          const collections = cols.map((c) => ({
            id: c.id,
            name: c.name,
            coverUrl: coverUrl(c.cover),
          }))
          return { id: g.id, name: g.name, collections }
        })
      )
      groups.value = built.filter((g) => g.collections.length > 0)
    } catch (err) {
      console.warn("[collection-groups] load failed", err)
      groups.value = []
    }
  }

  watch(
    locale,
    (value) => {
      void load(value)
    },
    { immediate: true }
  )

  return { groups }
}
