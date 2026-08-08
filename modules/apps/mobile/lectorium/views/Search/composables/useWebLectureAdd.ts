import { computed, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import type { DiscoveryHit } from "@lib/contracts"

/** What the add control on a web result is currently offering. */
export type WebAddState = "addable" | "pending" | "ready" | "failed"

export interface UseWebLectureAddReturn {
  state: ComputedRef<WebAddState>
  /** Stage text while ingesting ("Downloading 40%"), else "". */
  stageLabel: ComputedRef<string>
  /** 0-100 while downloading; undefined for stages with no measure. */
  percent: ComputedRef<number | undefined>
  /** Add it, or restart it if the last attempt died. One call either way. */
  add: () => Promise<void>
}

/**
 * The add control on a lecture found elsewhere, and what it knows about a
 * lecture that has already been added.
 *
 * There is no separate "adding" spinner. The moment the store accepts the URL
 * the item exists with a status, and the same badge the library shelf uses
 * takes over — one vocabulary for the same job, whichever surface started it.
 *
 * Everything the button has to decide already lives in the store: the tier
 * gate and the paywall, an item that is present, one that was archived and is
 * coming back, one that failed and needs restarting. So this passes the tap
 * straight through rather than re-deciding any of it.
 */
export function useWebLectureAdd(hit: () => DiscoveryHit): UseWebLectureAddReturn {
  const app = useLectorium()
  const library = useLibraryStore()
  const { t, te } = useI18n()

  const item = computed(() => library.findBySource(hit().media_url))

  const state = computed<WebAddState>(() => {
    const status = item.value?.status
    if (!status) return "addable"
    if (status === "failed") return "failed"
    if (status === "ready") return "ready"
    return "pending"
  })

  const percent = computed(() => (item.value ? library.livePercents.get(item.value.id) : undefined))

  const stageLabel = computed(() => {
    if (!item.value) return ""
    const stage = library.liveStages.get(item.value.id)
    const key = stage ? `library.status.stages.${stage}` : ""
    return key && te(key) ? t(key) : t("library.status.processing")
  })

  async function add(): Promise<void> {
    void app.haptics.impact("light")
    const h = hit()
    await library.addByUrl(h.media_url, {
      title: h.title || undefined,
      author: h.author || undefined,
    })
  }

  return { state, stageLabel, percent, add }
}
