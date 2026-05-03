import { ref, type Ref } from "vue"
import { buildHeatmapDays, type HeatmapDay } from "@lib/application/buildHeatmapDays.js"
import { computeCurrentStreak } from "@lib/application/computeCurrentStreak.js"
import { getDailyListeningHeatmap } from "@lib/application/getDailyListeningHeatmap.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { maxAudioDurationMs } from "@lectorium/composables/trackDuration.js"

/** Width of the heatmap window in days. ~32 weeks of past, plus a week ahead. */
const TOTAL_DAYS = 224

export interface UseActivityHeatmapReturn {
  readonly days: Ref<readonly HeatmapDay[]>
  readonly currentStreak: Ref<number>
  readonly completedCount: Ref<number>
  readonly totalListenedSeconds: Ref<number>
  reload: () => Promise<void>
}

/**
 * Loads daily listening totals and aggregate stats from
 * `listening_sessions` for the activity section: heatmap grid, current
 * streak, count of completed lectures, and total listening time. The
 * caller decides when to call `reload` (typically on view-enter, on
 * player pause, and on track completion).
 */
export function useActivityHeatmap(): UseActivityHeatmapReturn {
  const app = useLectorium()
  const days = ref<readonly HeatmapDay[]>([])
  const currentStreak = ref<number>(0)
  const completedCount = ref<number>(0)
  const totalListenedSeconds = ref<number>(0)

  async function reload(): Promise<void> {
    try {
      const repos = app.repositories()
      const now = Date.now()
      const fromMs = now - TOTAL_DAYS * 86_400_000
      const toMs = now + (TOTAL_DAYS + 1) * 86_400_000

      const [totals, totalSec, activeItems] = await Promise.all([
        getDailyListeningHeatmap({ fromMs, toMs }, { listeningSessions: repos.listeningSessions }),
        repos.listeningSessions.getTotalListenedSeconds(),
        repos.playlistItems.listActive(),
      ])

      // Hydrate tracks for completion-detection. Bounded by active
      // playlist size, which is small.
      const itemIds: PlaylistItemId[] = activeItems.map((i) => i.id)
      const tracks = await Promise.all(activeItems.map((i) => repos.tracks.getById(i.trackId)))
      const durations = new Map<PlaylistItemId, number>()
      for (let i = 0; i < activeItems.length; i++) {
        const t = tracks[i]
        if (!t) continue
        const ms = maxAudioDurationMs(t)
        if (ms > 0) durations.set(activeItems[i].id, Math.floor(ms / 1000))
      }
      const completedMap = await repos.listeningSessions.getCompletedAtForItems(itemIds, durations)

      const { days: built } = buildHeatmapDays(TOTAL_DAYS, now, totals)
      days.value = built
      currentStreak.value = computeCurrentStreak(built)
      completedCount.value = Array.from(completedMap.values()).filter((v) => v !== null).length
      totalListenedSeconds.value = totalSec
    } catch (err) {
      console.error("[activity-heatmap] reload failed", err)
      days.value = []
      currentStreak.value = 0
      completedCount.value = 0
      totalListenedSeconds.value = 0
    }
  }

  return { days, currentStreak, completedCount, totalListenedSeconds, reload }
}
