import { defineStore } from "pinia"
import { ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { shuffled } from "@lectorium/utils/shuffle.js"
import {
  buildRecommendations,
  type RecommendationShelf,
} from "@lib/application/buildRecommendations.js"
import type { Track } from "@lib/domain/track.js"
import type { LanguageCode } from "@lib/domain/core.js"

export type { RecommendationShelf } from "@lib/application/buildRecommendations.js"

// Listening window that shapes the taste profile.
const HISTORY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000
// The user's most-listened topics, shown lower down as "title + lectures"
// shelves (the cover carousel up top is any topics, derived in the view).
const SHELF_TOPICS = 3
const SHELF_SIZE = 12
const RECOMMENDED_SIZE = 3

/**
 * On-device recommender state. The taste-profile logic lives in the
 * `buildRecommendations` use case (@lib/application); this store is the thin
 * reactive shim that supplies wall-clock, the active UI language, the
 * playlist-derived exclusion predicate and a shuffle, runs it single-flight,
 * and exposes the result.
 */
export const useRecommendationsStore = defineStore("recommendations", () => {
  const app = useLectorium()
  const playlist = usePlaylistStore()
  const appLanguage = useAppLanguage()

  const recommended = ref<readonly Track[]>([])
  const shelves = ref<readonly RecommendationShelf[]>([])
  /** True when the profile was built from real listening history. */
  const hasHistory = ref<boolean>(false)
  const isLoading = ref<boolean>(false)

  // Single-flight: SearchView fires refresh() on every view-enter, which can
  // overlap a still-running build. Coalesce concurrent calls onto one run so a
  // slower older pass can't overwrite the newer shelves.
  let inFlight: Promise<void> | null = null

  function refresh(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = build().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function build(): Promise<void> {
    isLoading.value = true
    try {
      await playlist.ensureLoaded()
      const result = await buildRecommendations(
        {
          now: Date.now(),
          language: appLanguage.value as LanguageCode,
          historyWindowMs: HISTORY_WINDOW_MS,
          shelfTopics: SHELF_TOPICS,
          shelfSize: SHELF_SIZE,
          recommendedSize: RECOMMENDED_SIZE,
          // Discovery never resurfaces what's already heard (handled inside the
          // use case), completed, or currently queued.
          isExcluded: (id) => playlist.completedTrackIds.has(id) || playlist.hasTrack(id),
          shuffle: shuffled,
        },
        app.repositories()
      )
      recommended.value = result.recommended
      shelves.value = result.shelves
      hasHistory.value = result.hasHistory
    } catch (err) {
      console.warn("[recommendations] refresh failed", err)
    } finally {
      isLoading.value = false
    }
  }

  return { recommended, shelves, hasHistory, isLoading, refresh }
})
