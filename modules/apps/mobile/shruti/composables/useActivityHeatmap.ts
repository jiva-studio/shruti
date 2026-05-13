import { ref, type Ref } from "vue"
import type { HeatmapDay } from "@lib/application/buildHeatmapDays.js"
import { getActivityOverview } from "@lib/application/getActivityOverview.js"
import { useShruti } from "@shruti/shruti.js"

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
 *
 * Pure reactive shim — the actual orchestration is `getActivityOverview`
 * in @lib/application, which fetches via batch `tracks.getByIds` instead
 * of the previous N+1 `getById` fan-out.
 */
export function useActivityHeatmap(): UseActivityHeatmapReturn {
  const app = useShruti()
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

      const overview = await getActivityOverview(
        { fromMs, toMs, totalDays: TOTAL_DAYS },
        {
          listeningSessions: repos.listeningSessions,
          playlistItems: repos.playlistItems,
          tracks: repos.tracks,
        }
      )

      days.value = overview.days
      currentStreak.value = overview.currentStreak
      completedCount.value = overview.completedCount
      totalListenedSeconds.value = overview.totalListenedSeconds
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
