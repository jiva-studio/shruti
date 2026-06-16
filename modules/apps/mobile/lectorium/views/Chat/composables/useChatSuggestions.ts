import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from "vue"
import { useI18n } from "vue-i18n"
import { shuffled } from "@lectorium/utils/shuffle.js"

/**
 * Builds the empty-state suggestion chips for the chat screen — the data
 * half of what used to live inside SuggestionChips.vue. Rendering is now
 * the shared ChatChips component; this owns the recap chip + shuffled pool.
 *
 *   current track → "Recap the current lecture"
 *   recent listen → "Recap the last lecture"
 *   neither       → omit the recap chip
 *
 * The rest of the row is the i18n `chat.suggestions` pool, shuffled, capped
 * at `limit` (recap included in the count).
 */
export function useChatSuggestions(opts: {
  hasCurrentTrack: MaybeRefOrGetter<boolean>
  hasRecentListening: MaybeRefOrGetter<boolean>
  limit?: number
}): { chips: ComputedRef<string[]> } {
  const { tm, t } = useI18n()
  const limit = opts.limit ?? 4

  const recapChip = computed<string | null>(() => {
    if (toValue(opts.hasCurrentTrack)) return t("chat.suggestionRecapCurrent")
    if (toValue(opts.hasRecentListening)) return t("chat.suggestionRecapRecent")
    return null
  })

  function readSuggestions(): string[] {
    const raw = tm("chat.suggestions") as unknown
    if (Array.isArray(raw)) {
      return raw.filter((x): x is string => typeof x === "string" && x.length > 0)
    }
    return []
  }

  const chips = computed<string[]>(() => {
    const pool = shuffled(readSuggestions())
    const recap = recapChip.value
    const head = recap ? [recap] : []
    return [...head, ...pool].slice(0, Math.max(1, limit))
  })

  return { chips }
}
