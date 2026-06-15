import { ref, computed, watch, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useShruti } from "@shruti/shruti.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import type { PlaylistRenderItem } from "@ui/features/playlist/index.js"
import type { TrackCollectionRef } from "@infra/repositories/sql/index.js"

export interface UsePlaylistGroupsReturn {
  /** The playlist flattened into standalone rows + collection groups. */
  readonly items: ComputedRef<readonly PlaylistRenderItem[]>
}

/**
 * Derives collection groups for the Home playlist from collection membership —
 * no per-item provenance is stored. For each playlist track we read which
 * collections it belongs to (`collection_tracks`) and group maximal runs of
 * consecutive rows that share a collection.
 *
 * A run is labelled with the collection that yields the LONGEST consecutive
 * run starting at that point; ties resolve to the lowest `sort_order` (the repo
 * returns memberships in that order, and we keep the first on a tie). A track
 * that belongs to two added collections therefore shows under one only, and a
 * track that was already in the playlist before a collection was added simply
 * falls outside the contiguous block — both accepted by design. Archiving a
 * middle track keeps the surrounding rows adjacent, so the group survives.
 *
 * Membership is keyed by `${locale}:${trackId}` so a UI-language switch
 * re-derives against that locale's collections.
 */
export function usePlaylistGroups(
  rows: ComputedRef<readonly UiTrackRow[]>,
  locale: Ref<string>
): UsePlaylistGroupsReturn {
  const app = useShruti()
  const { t } = useI18n()
  const membership = ref<Map<string, readonly TrackCollectionRef[]>>(new Map())

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

  async function load(ids: readonly string[], loc: string): Promise<void> {
    const repos = app.repositories()
    const next = new Map(membership.value)
    let changed = false
    await Promise.all(
      ids.map(async (id) => {
        const key = `${loc}:${id}`
        if (next.has(key)) return
        try {
          next.set(key, await repos.collections.getTrackCollections(id, loc))
        } catch {
          next.set(key, [])
        }
        changed = true
      })
    )
    if (changed) membership.value = next
  }

  watch(
    [() => rows.value.map((r) => r.id).join(","), locale],
    () => {
      void load(
        rows.value.map((r) => r.id),
        locale.value
      )
    },
    { immediate: true }
  )

  const items = computed<readonly PlaylistRenderItem[]>(() => {
    const rs = rows.value
    const loc = locale.value
    const memOf = (id: string): readonly TrackCollectionRef[] =>
      membership.value.get(`${loc}:${id}`) ?? []

    const out: PlaylistRenderItem[] = []
    let i = 0
    while (i < rs.length) {
      const here = memOf(rs[i].id)
      // Among the collections this row belongs to, pick the one whose
      // consecutive run (starting here) is longest.
      let best: { col: TrackCollectionRef; end: number } | null = null
      for (const col of here) {
        let j = i
        while (j + 1 < rs.length && memOf(rs[j + 1].id).some((c) => c.id === col.id)) j++
        if (j > i && (best === null || j - i > best.end - i)) best = { col, end: j }
      }
      if (best) {
        const groupRows = rs.slice(i, best.end + 1)
        out.push({
          kind: "group",
          id: best.col.id,
          name: best.col.name,
          author: dominantAuthor(groupRows),
          rows: groupRows,
        })
        i = best.end + 1
      } else {
        out.push({ kind: "track", row: rs[i] })
        i++
      }
    }
    return out
  })

  return { items }
}
