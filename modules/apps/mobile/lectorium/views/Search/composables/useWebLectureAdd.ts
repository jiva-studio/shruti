import { computed, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { useToast } from "@kit/composables"
import { useLectorium } from "@lectorium/lectorium.js"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import { useIngestStatusFor } from "@lectorium/composables/useIngestStatusFor.js"
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
  const { t } = useI18n()
  const app = useLectorium()
  const library = useLibraryStore()
  const toast = useToast()
  const ingestStatusFor = useIngestStatusFor()

  // The same rule the chat card uses, and for the same reason: a just-submitted
  // row is found by its job id and by nothing else yet.
  const status = computed(() => ingestStatusFor(hit().media_url))

  const state = computed<WebAddState>(() => {
    const live = status.value
    if (live?.kind === "pending") return "pending"
    if (live?.kind === "failed") return "failed"
    return library.hasSource(hit().media_url) ? "ready" : "addable"
  })

  const percent = computed(() => status.value?.percent)
  const stageLabel = computed(() => status.value?.label ?? "")

  async function add(): Promise<void> {
    void app.haptics.impact("light")
    const h = hit()
    const result = await library.addByUrl(h.media_url, {
      title: h.title || undefined,
      author: h.author || undefined,
    })
    // A rejected submit records no job id, so the tile stays an offer and
    // nothing on screen moves — the tap has to say so itself. `paywalled`
    // already showed the subscription page and is not a failure to report.
    if (result === "failed") await toast.error(t("library.addError"))
  }

  return { state, stageLabel, percent, add }
}
