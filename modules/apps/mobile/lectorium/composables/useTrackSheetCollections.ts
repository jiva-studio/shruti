import { ref, watch, type Ref } from "vue"
import type { LanguageCode } from "@lib/domain/core.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"

export interface PartOfCollection {
  readonly id: string
  readonly name: string
  readonly coverUrl?: string
  readonly position: number
  readonly total: number
}

/**
 * The seminars a lecture belongs to. A talk given inside a retreat reads very
 * differently once you know which one and where it falls in it.
 *
 * Failure is silent: the collection tables may be missing on a bundled catalog
 * older than the schema, and a lecture without its seminar card is still a
 * complete lecture.
 */
export function useTrackSheetCollections(
  getTrackId: () => string | null,
  language: Ref<LanguageCode>
): Ref<readonly PartOfCollection[]> {
  const app = useLectorium()
  const partOf = ref<readonly PartOfCollection[]>([])

  watch(
    [getTrackId, language],
    async ([trackId, lang]) => {
      partOf.value = []
      if (!trackId) return
      try {
        const rows = await app.repositories().collections.getCollectionsOfTrack(trackId, lang)
        // The sheet swaps content in place (a similar lecture opens in the same
        // modal), so a slow answer for the previous track must not land here.
        if (getTrackId() !== trackId) return
        partOf.value = rows.map((r) => ({
          id: r.id,
          name: r.name,
          coverUrl: r.cover ? resolveAssetUrl(r.cover) : undefined,
          position: r.position,
          total: r.total,
        }))
      } catch {
        partOf.value = []
      }
    },
    { immediate: true }
  )

  return partOf
}
