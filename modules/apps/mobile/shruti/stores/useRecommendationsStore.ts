import { defineStore } from "pinia"
import { ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import type { Track } from "@lib/domain/track.js"
import type { LanguageCode, TopicId } from "@lib/domain/core.js"

/** One hot-topic shelf: the topic plus a few of its tracks the user hasn't
 *  heard and hasn't queued. */
export interface TopicShelf {
  readonly topicId: TopicId
  readonly tracks: readonly Track[]
}

// Listening window that shapes the taste profile.
const HISTORY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000
// The user's most-listened topics, shown lower down as "title + lectures"
// shelves (the cover carousel up top is any topics, derived in the view).
const SHELF_TOPICS = 3
const SHELF_SIZE = 12
const RECOMMENDED_SIZE = 3

/**
 * On-device recommender state. From the user's listening history it derives a
 * taste profile (topic affinity = Σ weight × listened seconds), surfaces the
 * three most-listened topics as shelves and a "Recommended for you" pick. Every
 * discovery surface excludes tracks the user already heard or already queued in
 * the playlist. With no history it cold-starts on the first topics so nothing is
 * empty.
 */
export const useRecommendationsStore = defineStore("recommendations", () => {
  const app = useShruti()
  const playlist = usePlaylistStore()
  const appLanguage = useAppLanguage()

  const recommended = ref<readonly Track[]>([])
  const shelves = ref<readonly TopicShelf[]>([])
  /** True when the profile was built from real listening history. */
  const hasHistory = ref<boolean>(false)
  const isLoading = ref<boolean>(false)
  let loaded = false

  async function refresh(): Promise<void> {
    isLoading.value = true
    try {
      const repos = app.repositories()
      await playlist.ensureLoaded()
      const now = Date.now()
      const heard = await repos.listeningSessions.getTracksListenedInRange(
        now - HISTORY_WINDOW_MS,
        now
      )
      const secondsByTrack = new Map(heard.map((h) => [h.trackId, h.listenedSeconds]))
      const heardIds = new Set(heard.map((h) => h.trackId))
      // Discovery never resurfaces what the user already heard or already has in
      // their playlist (queued or completed). `excluded` covers heard +
      // completed; playlist.hasTrack() covers anything currently queued.
      const excluded = new Set<string>([...heardIds, ...playlist.completedTrackIds])

      let hotTopics: TopicId[] = []
      if (heardIds.size > 0) {
        const weights = await repos.topics.weightsForTracks([...heardIds])
        const affinity = new Map<TopicId, number>()
        for (const w of weights) {
          const seconds = secondsByTrack.get(w.trackId) ?? 0
          affinity.set(w.topicId, (affinity.get(w.topicId) ?? 0) + w.weight * seconds)
        }
        hotTopics = [...affinity.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, SHELF_TOPICS)
          .map(([id]) => id)
      }
      hasHistory.value = hotTopics.length > 0

      // Cold start (or no topics matched the heard tracks): fall back to the
      // first topics so the shelves still populate.
      if (hotTopics.length === 0) {
        const all = await repos.topics.listAll()
        hotTopics = all.slice(0, SHELF_TOPICS).map((t) => t.id)
      }

      const shelfList: TopicShelf[] = []
      const topPicks: string[] = []
      for (const topicId of hotTopics) {
        const ids = (
          await repos.topics.topTrackIds(topicId, appLanguage.value as LanguageCode, SHELF_SIZE)
        ).filter((id) => !excluded.has(id) && !playlist.hasTrack(id))
        if (ids.length === 0) continue
        const byId = await repos.tracks.getByIds(ids)
        const tracks = ids.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined)
        if (tracks.length === 0) continue
        shelfList.push({ topicId, tracks })
        if (tracks[0]) topPicks.push(tracks[0].id)
      }
      shelves.value = shelfList

      // "Recommended for you": with history, the top unheard pick from each hot
      // topic. With nothing to personalise on (cold start), just three random
      // unheard lectures from the shelf pool so the section is never short.
      let recPool: string[]
      if (hasHistory.value) {
        recPool = [...new Set(topPicks)]
      } else {
        const all = [...new Set(shelfList.flatMap((s) => s.tracks.map((t) => t.id)))]
        for (let i = all.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[all[i], all[j]] = [all[j], all[i]]
        }
        recPool = all
      }
      const recIds = recPool.slice(0, RECOMMENDED_SIZE)
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
