import { ref, watch, type Ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"

/**
 * One starter pack as the Home view consumes it: chip label + the
 * ordered track ids it adds to the playlist on tap. `trackIds` is
 * pre-fetched eagerly so the tap handler doesn't have to await another
 * SQL round-trip with `disabled` already flipped.
 */
export interface StarterPack {
  readonly id: string
  readonly name: string
  readonly trackIds: readonly string[]
}

export interface UseStarterPacksReturn {
  /** Featured packs for the current locale, sorted by `sort_order ASC`. Empty when none. */
  readonly packs: Ref<readonly StarterPack[]>
}

/**
 * Reactive list of featured starter packs for the active UI locale.
 *
 * Reads from `packs` + `pack_tracks` in the catalog DB via the SQL
 * repo. Safe against an older bundled `current.db` that predates the
 * starter-packs schema: the repo treats `no such table` as "no packs"
 * and the composable surfaces an empty array, so the Home view
 * degrades to the pre-feature empty-state automatically.
 *
 * Reactive on `locale`: switching the UI language between RU and EN
 * re-loads the chip set. Loads on mount and on every locale change;
 * Home re-mounts on navigation so a stale value is rare.
 */
export function useStarterPacks(locale: Ref<string>): UseStarterPacksReturn {
  const app = useLectorium()
  const packs = ref<readonly StarterPack[]>([])

  async function load(currentLocale: string): Promise<void> {
    try {
      const repos = app.repositories()
      const headers = await repos.packs.listFeaturedPacks(currentLocale)
      if (headers.length === 0) {
        packs.value = []
        return
      }
      const hydrated = await Promise.all(
        headers.map(async (h) => {
          const trackIds = await repos.packs.getPackTrackIds(h.id, currentLocale)
          return { id: h.id, name: h.name, trackIds }
        })
      )
      packs.value = hydrated
    } catch (err) {
      // Repositories aren't built yet (content DB still opening),
      // or the catalog DB raised an unexpected error. Either way the
      // Home empty-state should fall back to the no-chips look; log
      // for diagnosis but don't surface to the user.
      console.warn("[starter-packs] load failed", err)
      packs.value = []
    }
  }

  watch(
    locale,
    (value) => {
      void load(value)
    },
    { immediate: true }
  )

  return { packs }
}
