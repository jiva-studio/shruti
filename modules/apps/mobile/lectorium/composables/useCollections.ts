import { ref, watch, type Ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"

/**
 * One featured collection as the Home view consumes it: label + the ordered
 * track ids it adds to the playlist on tap. `trackIds` is pre-fetched eagerly
 * so the tap handler doesn't have to await another SQL round-trip.
 */
export interface FeaturedCollection {
  readonly id: string
  readonly name: string
  readonly trackIds: readonly string[]
}

export interface UseCollectionsReturn {
  /** Featured collections for the current locale, sorted by `sort_order ASC`. Empty when none. */
  readonly collections: Ref<readonly FeaturedCollection[]>
}

/**
 * Reactive list of featured collections for the active UI locale.
 *
 * Reads `collections` + `collection_tags` (tag_featured) + `collection_tracks`
 * from the catalog DB via the SQL repo. Safe against an older bundled
 * `current.db` that predates the schema: the repo treats `no such table` as
 * "none" and the composable surfaces an empty array, so the Home view degrades
 * to the pre-feature empty-state automatically.
 *
 * Reactive on `locale`: switching the UI language between RU and EN re-loads
 * the set. Loads on mount and on every locale change.
 */
export function useCollections(locale: Ref<string>): UseCollectionsReturn {
  const app = useLectorium()
  const collections = ref<readonly FeaturedCollection[]>([])

  async function load(currentLocale: string): Promise<void> {
    try {
      const repos = app.repositories()
      const headers = await repos.collections.listFeaturedCollections(currentLocale)
      if (headers.length === 0) {
        collections.value = []
        return
      }
      const hydrated = await Promise.all(
        headers.map(async (h) => {
          const trackIds = await repos.collections.getCollectionTrackIds(h.id, currentLocale)
          return { id: h.id, name: h.name, trackIds }
        })
      )
      collections.value = hydrated
    } catch (err) {
      // Repositories aren't built yet (content DB still opening), or the
      // catalog DB raised an unexpected error. Either way the Home empty-state
      // should fall back to the no-chips look; log for diagnosis but don't
      // surface to the user.
      console.warn("[collections] load failed", err)
      collections.value = []
    }
  }

  watch(
    locale,
    (value) => {
      void load(value)
    },
    { immediate: true }
  )

  return { collections }
}
