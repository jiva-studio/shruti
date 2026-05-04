import { computed, onMounted, toRef, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useActivityHeatmap } from "@shruti/composables/useActivityHeatmap.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useReloadOnPlayback } from "@shruti/composables/useReloadOnPlayback.js"
import { useToast } from "@shruti/services/useToast.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useHomeRowBuilder } from "./useHomeRowBuilder.js"
import type { HeatmapDay } from "@lib/application/buildHeatmapDays.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"

export interface HomeControllerReturn {
  rows: ComputedRef<readonly UiTrackRow[]>
  isLoading: ComputedRef<boolean>
  error: ComputedRef<string | null>
  hasMore: ComputedRef<boolean>
  queueCount: ComputedRef<number>
  queueTotalSeconds: ComputedRef<number>
  heatmapDays: Ref<readonly HeatmapDay[]>
  currentStreak: Ref<number>
  completedCount: Ref<number>
  totalListenedSeconds: Ref<number>
  reloadHeatmap: () => Promise<void>
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  onSelect: (trackId: string) => Promise<void>
  onRemove: (trackId: string) => Promise<void>
}

/**
 * Home shows the user's listening journey. Wires the playlist store +
 * heatmap composable to the view; row construction is delegated to
 * `useHomeRowBuilder`, heatmap polling to `useReloadOnPlayback`.
 */
export function useHomeController(): HomeControllerReturn {
  const appLanguage = useAppLanguage()

  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const downloads = useDownloadStore()
  const dictionaries = useDictionariesStore()
  const toast = useToast()
  const { t } = useI18n()
  const heatmap = useActivityHeatmap()

  const { rows, queueCount, queueTotalSeconds } = useHomeRowBuilder(appLanguage)

  onMounted(async () => {
    await Promise.all([
      dictionaries.ensureLoaded(),
      playlist.ensureLoaded(),
      downloads.hydrate(),
      heatmap.reload(),
    ])
    if (downloads.hydrationError) {
      void toast.error(t("errors.downloadsCacheUnavailable"))
    }
    playlist.prefetchAll()
  })

  // Refresh the heatmap whenever playback ends — covers pause, track-end,
  // and stop. The seconds spent listening land in the cell for "today",
  // so the user sees their progress without having to leave and re-enter
  // the screen. While playback is in progress, also poll every minute so
  // the user sees today's cell tick up in near-real-time during long
  // listens — session writes happen every 15s, but a UI reload that
  // often would be wasteful.
  useReloadOnPlayback(toRef(player, "playing"), heatmap.reload)

  const isLoading = computed(() => playlist.isLoading)
  const error = computed(() => playlist.error)
  const hasMore = computed(() => playlist.hasMore)

  async function refresh(): Promise<void> {
    await playlist.refresh()
  }

  async function loadMore(): Promise<void> {
    await playlist.loadMore()
  }

  async function onSelect(trackId: string): Promise<void> {
    const entry = playlist.entries.find((e) => e.track.id === trackId)
    if (!entry) return
    const author = entry.track.authorId
      ? (dictionaries.authorsById.get(entry.track.authorId) ?? null)
      : null
    await player.openTrack({
      track: entry.track,
      preferredLanguage: appLanguage.value,
      author,
      itemId: entry.item.id,
    })
  }

  async function onRemove(trackId: string): Promise<void> {
    await playlist.archiveByTrackId(trackId)
  }

  return {
    rows,
    isLoading,
    error,
    hasMore,
    queueCount,
    queueTotalSeconds,
    heatmapDays: heatmap.days,
    currentStreak: heatmap.currentStreak,
    completedCount: heatmap.completedCount,
    totalListenedSeconds: heatmap.totalListenedSeconds,
    reloadHeatmap: heatmap.reload,
    refresh,
    loadMore,
    onSelect,
    onRemove,
  }
}
