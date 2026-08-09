import { ref, computed, watch, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import type { PlaylistRenderItem } from "@ui/features/playlist/index.js"

export interface UsePlaylistGroupsReturn {
  /** The playlist flattened into standalone rows + collection groups. */
  readonly items: ComputedRef<readonly PlaylistRenderItem[]>
}

/**
 * Groups the Home playlist into collection accordions from STORED provenance:
 * each playlist item records the collection it was added from (`collectionId`,
 * set only when the user adds a whole collection — see migration 012). Maximal
 * runs of two-or-more consecutive rows sharing the same source collection
 * become one group; everything else renders as a standalone track.
 *
 * Unlike the old derive-by-membership approach, this reflects user intent: a
 * single lecture opened from a collection (no provenance) is never folded into
 * a group, and an "add all" groups exactly the tracks the user added —
 * independent of which catalog collections those tracks happen to belong to.
 *
 * Collection names are localized, so they're resolved per `collectionId` for
 * the active locale; an id that no longer resolves (collection removed from the
 * bundled catalog) falls back to standalone rows.
 */
export function usePlaylistGroups(
  rows: ComputedRef<readonly UiTrackRow[]>,
  locale: Ref<string>
): UsePlaylistGroupsReturn {
  const app = useLectorium()
  const playlist = usePlaylistStore()
  const { t } = useI18n()
  // `${locale}:${collectionId}` → display name (or null when unresolved).
  const names = ref<Map<string, string | null>>(new Map())
  // `${locale}:${collectionId}` → trackId → 1-based place in the collection.
  // Taken from the catalog, not from the queue: a group here is a run of
  // consecutive queue rows, so counting them would renumber the rest the moment
  // one is removed, and would disagree with the collection page.
  const orders = ref<Map<string, ReadonlyMap<string, number>>>(new Map())

  // trackId → source collectionId, from the active playlist items. A track is
  // unique in the active playlist, so this mapping is unambiguous.
  const sourceByTrack = computed(() => {
    const m = new Map<string, string>()
    for (const { item } of playlist.entries) {
      if (item.collectionId) m.set(item.trackId, item.collectionId)
    }
    return m
  })

  // Dominant author across a group's lectures: the one contributing the most
  // lectures, with an "…and others" suffix when more than one author appears.
  // "" when none of the rows carry an author name.
  function dominantAuthor(rows: readonly UiTrackRow[]): string {
    const counts = new Map<string, number>()
    for (const r of rows) {
      const name = r.author.trim()
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    if (counts.size === 0) return ""
    let top = ""
    let topCount = -1
    for (const [name, n] of counts) {
      if (n > topCount) {
        top = name
        topCount = n
      }
    }
    return counts.size > 1 ? t("home.collectionMoreAuthors", { author: top }) : top
  }

  async function loadNames(ids: readonly string[], loc: string): Promise<void> {
    const repos = app.repositories()
    const next = new Map(names.value)
    const nextOrders = new Map(orders.value)
    let changed = false
    await Promise.all(
      ids.map(async (id) => {
        const key = `${loc}:${id}`
        if (next.has(key)) return
        try {
          next.set(key, await repos.collections.getCollectionName(id, loc))
          const ids = await repos.collections.getCollectionTrackIds(id, loc)
          nextOrders.set(key, new Map(ids.map((tid, i) => [tid, i + 1])))
        } catch {
          next.set(key, null)
        }
        changed = true
      })
    )
    if (changed) {
      names.value = next
      orders.value = nextOrders
    }
  }

  watch(
    [() => [...new Set(sourceByTrack.value.values())].sort().join(","), locale],
    () => void loadNames([...new Set(sourceByTrack.value.values())], locale.value),
    { immediate: true }
  )

  const items = computed<readonly PlaylistRenderItem[]>(() => {
    const rs = rows.value
    const loc = locale.value
    const src = sourceByTrack.value
    // A row's source collection counts only once its name has resolved for the
    // active locale; an unresolved id leaves the row standalone.
    const colOf = (rowId: string): { id: string; name: string } | null => {
      const cid = src.get(rowId)
      if (!cid) return null
      const name = names.value.get(`${loc}:${cid}`)
      return name ? { id: cid, name } : null
    }

    const out: PlaylistRenderItem[] = []
    let i = 0
    while (i < rs.length) {
      const here = colOf(rs[i].id)
      // Extend a run of consecutive rows sharing the same source collection.
      let j = i
      if (here) {
        while (j + 1 < rs.length && colOf(rs[j + 1].id)?.id === here.id) j++
      }
      if (here && j > i) {
        const place = orders.value.get(`${loc}:${here.id}`)
        const groupRows = rs.slice(i, j + 1).map((row) => {
          const n = place?.get(row.id)
          return n ? { ...row, position: n } : row
        })
        out.push({
          kind: "group",
          id: here.id,
          name: here.name,
          author: dominantAuthor(groupRows),
          rows: groupRows,
        })
        i = j + 1
      } else {
        out.push({ kind: "track", row: rs[i] })
        i++
      }
    }
    return out
  })

  return { items }
}
