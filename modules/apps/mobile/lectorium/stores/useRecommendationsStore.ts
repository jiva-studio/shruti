import { defineStore } from "pinia"
import { ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import type { Track } from "@lib/domain/track.js"
import type { TopicId } from "@lib/domain/core.js"

/** One hot-topic shelf: the topic plus its highest-weight tracks (unheard). */
export interface TopicShelf {
  readonly topicId: TopicId
  readonly tracks: readonly Track[]
}

// Listening window that shapes the taste profile, and the fan-out sizes.
const HISTORY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000
const HOT_TOPICS = 6
const SHELF_SIZE = 12
const RECOMMENDED_SIZE = 3

/**
 * On-device recommender state. From the user's listening history it derives a
 * taste profile (topic affinity = Σ weight × listened seconds), then surfaces
 * the user's hot topics as shelves and a "Recommended for you" pick — always
 * excluding already-heard tracks. With no history it cold-starts on the first
 * topics so the surfaces are never empty.
 */
export const useRecommendationsStore = defineStore("recommendations", () => {
  const app = useLectorium()

  const recommended = ref<readonly Track[]>([])
  const shelves = ref<readonly TopicShelf[]>([])
  /** True when the profile was built from real listening history (drives the
   *  "Recommended for you" header and the per-shelf "because you listened"
   *  framing vs a plain topic header on cold start). */
  const hasHistory = ref<boolean>(false)
  const isLoading = ref<boolean>(false)
  let loaded = false

  async function refresh(): Promise<void> {
    isLoading.value = true
    try {
      const repos = app.repositories()
      const now = Date.now()
      const heard = await repos.listeningSessions.getTracksListenedInRange(
        now - HISTORY_WINDOW_MS,
        now
      )
      const secondsByTrack = new Map(heard.map((h) => [h.trackId, h.listenedSeconds]))
      const heardIds = new Set(heard.map((h) => h.trackId))

      let hotTopics: TopicId[]
      if (heardIds.size > 0) {
        const weights = await repos.topics.weightsForTracks([...heardIds])
        const affinity = new Map<TopicId, number>()
        for (const w of weights) {
          const seconds = secondsByTrack.get(w.trackId) ?? 0
          affinity.set(w.topicId, (affinity.get(w.topicId) ?? 0) + w.weight * seconds)
        }
        hotTopics = [...affinity.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, HOT_TOPICS)
          .map(([id]) => id)
        hasHistory.value = hotTopics.length > 0
      } else {
        hotTopics = []
        hasHistory.value = false
      }

      // Cold start (or no topics matched the heard tracks): fall back to the
      // first topics so the browse shelves still populate.
      if (hotTopics.length === 0) {
        const all = await repos.topics.listAll()
        hotTopics = all.slice(0, HOT_TOPICS).map((t) => t.id)
      }

      const shelfList: TopicShelf[] = []
      const topPicks: string[] = []
      for (const topicId of hotTopics) {
        const ids = (await repos.topics.topTrackIds(topicId, SHELF_SIZE)).filter(
          (id) => !heardIds.has(id)
        )
        if (ids.length === 0) continue
        const byId = await repos.tracks.getByIds(ids)
        const tracks = ids.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
        if (tracks.length === 0) continue
        shelfList.push({ topicId, tracks })
        if (tracks[0]) topPicks.push(tracks[0].id)
      }
      shelves.value = shelfList

      // "Recommended for you" = the top pick from each hot topic, deduped.
      const recIds = [...new Set(topPicks)].slice(0, RECOMMENDED_SIZE)
      const recById = await repos.tracks.getByIds(recIds)
      recommended.value = recIds
        .map((id) => recById.get(id))
        .filter((t): t is Track => t !== undefined)
      loaded = true
    } finally {
      isLoading.value = false
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    await refresh()
  }

  return { recommended, shelves, hasHistory, isLoading, ensureLoaded, refresh }
})
